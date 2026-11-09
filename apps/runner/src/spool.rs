//! Per-task spool on disk: the task's metadata plus every event it produced,
//! kept until the server acknowledges it. This is the Runner's outbox. The
//! connection reads unacknowledged events from here, so nothing is lost if the
//! socket drops or the Runner restarts.
//!
//! Layout: `<spool>/<task_id>/meta.json`, `events.bin` (length-delimited
//! protobuf `TaskEvent`s), and `acked` (highest acknowledged seq).

use std::fs::{File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use prost::Message;
use serde::{Deserialize, Serialize};
use sling_runner_protocol::{TaskEvent, task_event::Kind};

use crate::config::Mode;
use crate::sys::now_ms;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpoolState {
    Running,
    Finished,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TaskMeta {
    pub task_id: String,
    pub repo: String,
    pub title: String,
    pub objective: String,
    pub mode: Mode,
    pub harness: String,
    pub branch: String,
    pub default_branch: String,
    pub worktree: Option<PathBuf>,
    pub base_sha: Option<String>,
    /// Process group of the running harness, so a restarted Runner can stop
    /// one that outlived it.
    #[serde(default)]
    pub harness_pid: Option<u32>,
    pub state: SpoolState,
    pub created_ms: i64,
}

pub struct TaskSpool {
    dir: PathBuf,
    pub meta: TaskMeta,
    last_seq: u64,
    acked: u64,
    /// Next byte to scan for this connection. Unacknowledged data stays on disk.
    read_offset: u64,
    /// Highest seq handed to the current connection.
    pub sent: u64,
    file: File,
}

impl TaskSpool {
    pub fn create(root: &Path, meta: TaskMeta) -> Result<TaskSpool> {
        let dir = root.join(&meta.task_id);
        std::fs::create_dir_all(&dir)?;
        write_atomic(&dir.join("meta.json"), &serde_json::to_vec_pretty(&meta)?)?;
        write_atomic(&dir.join("acked"), b"0")?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("events.bin"))?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            File::open(&dir)?.sync_all()?;
            File::open(root)?.sync_all()?;
        }
        Ok(TaskSpool {
            dir,
            meta,
            last_seq: 0,
            acked: 0,
            read_offset: 0,
            sent: 0,
            file,
        })
    }

    pub fn open(dir: &Path) -> Result<TaskSpool> {
        let meta: TaskMeta = serde_json::from_slice(
            &std::fs::read(dir.join("meta.json"))
                .with_context(|| format!("reading {}", dir.display()))?,
        )?;
        let acked: u64 = std::fs::read_to_string(dir.join("acked"))
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        let path = dir.join("events.bin");
        let (last_seq, good_len) = scan_events(&path)?;
        // Drop a half-written record left by a crash. Windows refuses to
        // truncate through a handle opened only to append, so this one writes.
        if std::fs::metadata(&path).is_ok_and(|m| m.len() != good_len) {
            OpenOptions::new()
                .write(true)
                .open(&path)?
                .set_len(good_len)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let acked = acked.min(last_seq);
        Ok(TaskSpool {
            dir: dir.to_path_buf(),
            meta,
            last_seq,
            acked,
            read_offset: 0,
            sent: acked,
            file,
        })
    }

    pub fn task_id(&self) -> &str {
        &self.meta.task_id
    }

    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// Appends an event and returns it.
    pub fn append(&mut self, kind: Kind) -> Result<TaskEvent> {
        let event = TaskEvent {
            task_id: self.meta.task_id.clone(),
            seq: self.last_seq + 1,
            at_ms: now_ms(),
            kind: Some(kind),
        };
        let bytes = event.encode_length_delimited_to_vec();
        anyhow::ensure!(
            bytes.len() <= MAX_RECORD_BYTES,
            "event exceeds spool record limit"
        );
        self.file.write_all(&bytes)?;
        self.file.sync_data()?;
        self.last_seq = event.seq;
        Ok(event)
    }

    pub fn ack(&mut self, seq: u64) -> Result<()> {
        if seq <= self.acked {
            return Ok(());
        }
        let acked = seq.min(self.last_seq);
        write_atomic(&self.dir.join("acked"), acked.to_string().as_bytes())?;
        self.acked = acked;
        Ok(())
    }

    /// Events not yet handed to the current connection.
    pub fn unsent(&mut self) -> Vec<TaskEvent> {
        match self.read_batch() {
            Ok(events) => events,
            Err(err) => {
                tracing::warn!(task = self.task_id(), %err, "could not read spool");
                Vec::new()
            }
        }
    }

    fn read_batch(&mut self) -> Result<Vec<TaskEvent>> {
        let mut reader = BufReader::new(File::open(self.dir.join("events.bin"))?);
        reader.seek(SeekFrom::Start(self.read_offset))?;
        let mut out = Vec::new();
        let mut bytes = 0;
        while out.len() < 128 && bytes < 512 * 1024 {
            let Some(event) = read_record(&mut reader)? else {
                break;
            };
            self.read_offset = reader.stream_position()?;
            if event.seq <= self.sent {
                continue;
            }
            bytes += event.encoded_len();
            self.sent = event.seq;
            out.push(event);
        }
        Ok(out)
    }

    /// Called on every new connection: resend everything unacknowledged.
    pub fn reset_sent(&mut self) {
        self.sent = self.acked;
        self.read_offset = 0;
    }

    pub fn set_meta(&mut self, f: impl FnOnce(&mut TaskMeta)) -> Result<()> {
        f(&mut self.meta);
        write_atomic(
            &self.dir.join("meta.json"),
            &serde_json::to_vec_pretty(&self.meta)?,
        )
    }

    pub fn remove(self) -> Result<()> {
        drop(self.file);
        std::fs::remove_dir_all(&self.dir)?;
        Ok(())
    }
}

const MAX_RECORD_BYTES: usize = 4 * 1024 * 1024;

/// Decode one record without loading the history. An incomplete final record is ignored.
fn read_record(reader: &mut impl Read) -> Result<Option<TaskEvent>> {
    let mut len = 0u64;
    for shift in (0..70).step_by(7) {
        let mut byte = [0];
        match reader.read_exact(&mut byte) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e.into()),
        }
        if shift == 63 && byte[0] > 1 {
            return Ok(None);
        }
        len |= u64::from(byte[0] & 0x7f) << shift;
        if byte[0] & 0x80 == 0 {
            if len > MAX_RECORD_BYTES as u64 {
                return Ok(None);
            }
            let mut bytes = vec![0; len as usize];
            match reader.read_exact(&mut bytes) {
                Ok(()) => return Ok(TaskEvent::decode(bytes.as_slice()).ok()),
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok(None)
}

fn scan_events(path: &Path) -> Result<(u64, u64)> {
    if !path.exists() {
        return Ok((0, 0));
    }
    let mut reader = BufReader::new(File::open(path)?);
    let mut last_seq = 0;
    let mut good = 0;
    while let Some(event) = read_record(&mut reader)? {
        last_seq = event.seq;
        good = reader.stream_position()?;
    }
    Ok((last_seq, good))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    let mut file = File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

/// Opens every spool under `root`. Broken ones are skipped with a warning.
pub fn open_all(root: &Path) -> Vec<TaskSpool> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        match TaskSpool::open(&entry.path()) {
            Ok(s) => out.push(s),
            Err(e) => tracing::warn!("skipping spool {}: {e:#}", entry.path().display()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use sling_runner_protocol::{LogLine, TaskAccepted};

    fn meta(id: &str) -> TaskMeta {
        TaskMeta {
            task_id: id.into(),
            repo: "site".into(),
            title: "t".into(),
            objective: "o".into(),
            mode: Mode::Auto,
            harness: "codex".into(),
            branch: "sling/x".into(),
            default_branch: "main".into(),
            worktree: None,
            base_sha: None,
            harness_pid: None,
            state: SpoolState::Running,
            created_ms: 0,
        }
    }

    fn log(text: &str) -> Kind {
        Kind::Log(LogLine {
            stream: 1,
            text: text.into(),
        })
    }

    #[test]
    fn replay_is_batched_and_acknowledged_history_is_not_retained() {
        let root = tempfile::tempdir().unwrap();
        let mut s = TaskSpool::create(root.path(), meta("batch")).unwrap();
        for _ in 0..300 {
            s.append(log("line")).unwrap();
        }
        s.ack(100).unwrap();
        drop(s);
        let mut s = TaskSpool::open(&root.path().join("batch")).unwrap();
        let first = s.unsent();
        assert_eq!(first.len(), 128);
        assert_eq!(first[0].seq, 101);
        assert_eq!(s.unsent().len(), 72);
        assert!(s.unsent().is_empty());
        s.reset_sent();
        assert_eq!(s.unsent()[0].seq, 101);
    }

    #[test]
    fn events_survive_reopen_until_acked() {
        let root = tempfile::tempdir().unwrap();
        let mut s = TaskSpool::create(root.path(), meta("tsk_1")).unwrap();
        s.append(Kind::Accepted(TaskAccepted {})).unwrap();
        s.append(log("a")).unwrap();
        s.append(log("b")).unwrap();
        assert_eq!(s.unsent().len(), 3);
        assert!(s.unsent().is_empty());
        s.ack(2).unwrap();
        drop(s);

        let mut s = TaskSpool::open(&root.path().join("tsk_1")).unwrap();
        assert_eq!(s.last_seq(), 3);
        let unsent = s.unsent();
        assert_eq!(unsent.len(), 1);
        assert_eq!(unsent[0].seq, 3);
        let e = s.append(log("c")).unwrap();
        assert_eq!(e.seq, 4);
    }

    #[test]
    fn a_torn_write_is_dropped() {
        let root = tempfile::tempdir().unwrap();
        let mut s = TaskSpool::create(root.path(), meta("tsk_2")).unwrap();
        s.append(log("whole")).unwrap();
        drop(s);
        let path = root.path().join("tsk_2/events.bin");
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(&[0x40, 0x01, 0x02]).unwrap();
        drop(f);
        let mut s = TaskSpool::open(&root.path().join("tsk_2")).unwrap();
        assert_eq!(s.last_seq(), 1);
        assert_eq!(s.append(log("next")).unwrap().seq, 2);
        drop(s);
        let s = TaskSpool::open(&root.path().join("tsk_2")).unwrap();
        assert_eq!(s.last_seq(), 2);
    }

    #[test]
    fn reset_sent_resends_unacked() {
        let root = tempfile::tempdir().unwrap();
        let mut s = TaskSpool::create(root.path(), meta("tsk_3")).unwrap();
        s.append(log("a")).unwrap();
        s.append(log("b")).unwrap();
        s.unsent();
        s.ack(1).unwrap();
        s.reset_sent();
        let again = s.unsent();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].seq, 2);
    }
}
