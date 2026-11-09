//! Per-task spool on disk: the task's metadata plus every event it produced,
//! kept until the server acknowledges it. This is the Runner's outbox. The
//! connection reads unacknowledged events from here, so nothing is lost if the
//! socket drops or the Runner restarts.
//!
//! Layout: `<spool>/<task_id>/meta.json`, `events.bin` (length-delimited
//! protobuf `TaskEvent`s), and `acked` (highest acknowledged seq).

use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
    disk: Arc<dyn Disk>,
    dir: PathBuf,
    pub meta: TaskMeta,
    last_seq: u64,
    acked: u64,
    /// Next byte to scan for this connection. Unacknowledged data stays on disk.
    read_offset: u64,
    /// Highest seq handed to the current connection.
    sent: u64,
    file: Box<dyn Writer>,
}

impl TaskSpool {
    pub fn create(root: &Path, meta: TaskMeta) -> Result<TaskSpool> {
        TaskSpool::create_on(Arc::new(Os), root, meta)
    }

    pub(crate) fn create_on(disk: Arc<dyn Disk>, root: &Path, meta: TaskMeta) -> Result<TaskSpool> {
        let dir = root.join(&meta.task_id);
        disk.create_dir_all(&dir)?;
        write_atomic(
            &*disk,
            &dir.join("meta.json"),
            &serde_json::to_vec_pretty(&meta)?,
        )?;
        write_atomic(&*disk, &dir.join("acked"), b"0")?;
        let mut file = disk.append(&dir.join("events.bin"))?;
        file.sync()?;
        disk.sync_dir(&dir)?;
        disk.sync_dir(root)?;
        Ok(TaskSpool {
            disk,
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
        TaskSpool::open_on(Arc::new(Os), dir)
    }

    pub(crate) fn open_on(disk: Arc<dyn Disk>, dir: &Path) -> Result<TaskSpool> {
        let meta: TaskMeta = serde_json::from_slice(
            &disk
                .read(&dir.join("meta.json"))
                .with_context(|| format!("reading {}", dir.display()))?,
        )?;
        let acked: u64 = disk
            .read(&dir.join("acked"))
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        let path = dir.join("events.bin");
        let (last_seq, good_len) = scan_events(&*disk, &path)?;
        // Drop a half-written record left by a crash.
        if disk.len(&path).is_ok_and(|len| len != good_len) {
            disk.set_len(&path, good_len)?;
        }
        let file = disk.append(&path)?;
        let acked = acked.min(last_seq);
        Ok(TaskSpool {
            disk,
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
        self.file.write_bytes(&bytes)?;
        self.file.sync()?;
        self.last_seq = event.seq;
        Ok(event)
    }

    pub fn ack(&mut self, seq: u64) -> Result<()> {
        if seq <= self.acked {
            return Ok(());
        }
        let acked = seq.min(self.last_seq);
        write_atomic(
            &*self.disk,
            &self.dir.join("acked"),
            acked.to_string().as_bytes(),
        )?;
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
        let mut reader = self.disk.reader(&self.dir.join("events.bin"))?;
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
            &*self.disk,
            &self.dir.join("meta.json"),
            &serde_json::to_vec_pretty(&self.meta)?,
        )
    }

    pub fn remove(self) -> Result<()> {
        drop(self.file);
        self.disk.remove_dir_all(&self.dir)?;
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

fn scan_events(disk: &dyn Disk, path: &Path) -> Result<(u64, u64)> {
    let mut reader = match disk.reader(path) {
        Ok(reader) => reader,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(e) => return Err(e.into()),
    };
    let mut last_seq = 0;
    let mut good = 0;
    while let Some(event) = read_record(&mut reader)? {
        last_seq = event.seq;
        good = reader.stream_position()?;
    }
    Ok((last_seq, good))
}

fn write_atomic(disk: &dyn Disk, path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    let mut file = disk.create(&tmp)?;
    file.write_bytes(bytes)?;
    file.sync()?;
    drop(file);
    disk.rename(&tmp, path)?;
    if let Some(parent) = path.parent() {
        disk.sync_dir(parent)?;
    }
    Ok(())
}

/// The file operations the spool uses. The Runner uses the real filesystem.
/// Tests use a simulated disk that can lose or tear anything not yet synced,
/// to check what a crash leaves behind at every step.
pub(crate) trait Disk: Send + Sync {
    fn create_dir_all(&self, dir: &Path) -> io::Result<()>;
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    fn reader(&self, path: &Path) -> io::Result<Box<dyn Reader>>;
    /// Opens a file for appending, creating it if it's missing.
    fn append(&self, path: &Path) -> io::Result<Box<dyn Writer>>;
    /// Creates a file, or empties an existing one, for writing.
    fn create(&self, path: &Path) -> io::Result<Box<dyn Writer>>;
    fn len(&self, path: &Path) -> io::Result<u64>;
    fn set_len(&self, path: &Path, len: u64) -> io::Result<()>;
    /// Replaces `to` if it exists.
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    fn remove_dir_all(&self, dir: &Path) -> io::Result<()>;
    /// Makes files created in or renamed into `dir` durable.
    fn sync_dir(&self, dir: &Path) -> io::Result<()>;
}

pub(crate) trait Reader: Read + Seek + Send {}

impl<T: Read + Seek + Send> Reader for T {}

pub(crate) trait Writer: Send {
    fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()>;
    /// Returns once the data written so far and the file's length are on
    /// stable storage.
    fn sync(&mut self) -> io::Result<()>;
}

impl Writer for File {
    fn write_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.write_all(bytes)
    }

    fn sync(&mut self) -> io::Result<()> {
        // F_FULLFSYNC on macOS, fdatasync on Linux, FlushFileBuffers on Windows.
        self.sync_data()
    }
}

/// The real filesystem.
pub(crate) struct Os;

impl Disk for Os {
    fn create_dir_all(&self, dir: &Path) -> io::Result<()> {
        std::fs::create_dir_all(dir)
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        std::fs::read(path)
    }

    fn reader(&self, path: &Path) -> io::Result<Box<dyn Reader>> {
        Ok(Box::new(BufReader::new(File::open(path)?)))
    }

    fn append(&self, path: &Path) -> io::Result<Box<dyn Writer>> {
        Ok(Box::new(
            OpenOptions::new().create(true).append(true).open(path)?,
        ))
    }

    fn create(&self, path: &Path) -> io::Result<Box<dyn Writer>> {
        Ok(Box::new(File::create(path)?))
    }

    fn len(&self, path: &Path) -> io::Result<u64> {
        Ok(std::fs::metadata(path)?.len())
    }

    fn set_len(&self, path: &Path, len: u64) -> io::Result<()> {
        // Windows refuses to truncate through a handle opened only to append,
        // so this one opens its own.
        OpenOptions::new().write(true).open(path)?.set_len(len)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        std::fs::rename(from, to)
    }

    fn remove_dir_all(&self, dir: &Path) -> io::Result<()> {
        std::fs::remove_dir_all(dir)
    }

    #[cfg(unix)]
    fn sync_dir(&self, dir: &Path) -> io::Result<()> {
        File::open(dir)?.sync_all()
    }

    /// Windows can't open a directory to sync it without extra flags, and
    /// NTFS journals renames itself. See docs/runner.md for what that means
    /// after a power cut.
    #[cfg(not(unix))]
    fn sync_dir(&self, _dir: &Path) -> io::Result<()> {
        Ok(())
    }
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
#[path = "spool_tests.rs"]
mod tests;
