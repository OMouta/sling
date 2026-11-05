//! Per-task spool on disk: the task's metadata plus every event it produced,
//! kept until the server acknowledges it. This is the Runner's outbox. The
//! connection reads unacknowledged events from here, so nothing is lost if the
//! socket drops or the Runner restarts.
//!
//! Layout: `<spool>/<task_id>/meta.json`, `events.bin` (length-delimited
//! protobuf `TaskEvent`s), and `acked` (highest acknowledged seq).

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{BufReader, Read, Write};
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
    /// Events with seq > acked, oldest first.
    pending: VecDeque<TaskEvent>,
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
        Ok(TaskSpool {
            dir,
            meta,
            last_seq: 0,
            acked: 0,
            pending: VecDeque::new(),
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
        let (events, good_len) = read_events(&path)?;
        // Drop a half-written record left by a crash.
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        if file.metadata()?.len() != good_len {
            file.set_len(good_len)?;
        }
        let last_seq = events.last().map(|e| e.seq).unwrap_or(0);
        let pending = events.into_iter().filter(|e| e.seq > acked).collect();
        Ok(TaskSpool {
            dir: dir.to_path_buf(),
            meta,
            last_seq,
            acked,
            pending,
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
        self.last_seq += 1;
        let event = TaskEvent {
            task_id: self.meta.task_id.clone(),
            seq: self.last_seq,
            at_ms: now_ms(),
            kind: Some(kind),
        };
        let bytes = event.encode_length_delimited_to_vec();
        self.file.write_all(&bytes)?;
        self.file.flush()?;
        self.pending.push_back(event.clone());
        Ok(event)
    }

    pub fn ack(&mut self, seq: u64) -> Result<()> {
        if seq <= self.acked {
            return Ok(());
        }
        self.acked = seq.min(self.last_seq);
        while self.pending.front().is_some_and(|e| e.seq <= self.acked) {
            self.pending.pop_front();
        }
        write_atomic(&self.dir.join("acked"), self.acked.to_string().as_bytes())
    }

    /// Events not yet handed to the current connection.
    pub fn unsent(&mut self) -> Vec<TaskEvent> {
        let out: Vec<_> = self
            .pending
            .iter()
            .filter(|e| e.seq > self.sent)
            .cloned()
            .collect();
        if let Some(last) = out.last() {
            self.sent = last.seq;
        }
        out
    }

    /// Called on every new connection: resend everything unacknowledged.
    pub fn reset_sent(&mut self) {
        self.sent = self.acked;
    }

    pub fn set_meta(&mut self, f: impl FnOnce(&mut TaskMeta)) -> Result<()> {
        f(&mut self.meta);
        write_atomic(
            &self.dir.join("meta.json"),
            &serde_json::to_vec_pretty(&self.meta)?,
        )
    }

    pub fn fully_acked(&self) -> bool {
        self.acked >= self.last_seq
    }

    pub fn remove(self) -> Result<()> {
        drop(self.file);
        std::fs::remove_dir_all(&self.dir)?;
        Ok(())
    }
}

fn read_events(path: &Path) -> Result<(Vec<TaskEvent>, u64)> {
    let mut buf = Vec::new();
    if path.exists() {
        BufReader::new(File::open(path)?).read_to_end(&mut buf)?;
    }
    let mut events = Vec::new();
    let mut slice = buf.as_slice();
    let mut good = 0u64;
    while !slice.is_empty() {
        let before = slice.len();
        match TaskEvent::decode_length_delimited(&mut slice) {
            Ok(e) => {
                good += (before - slice.len()) as u64;
                events.push(e);
            }
            Err(_) => break,
        }
    }
    Ok((events, good))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
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
