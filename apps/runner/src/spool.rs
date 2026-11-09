//! Per-task spool on disk: the task's metadata plus every event it produced,
//! kept until the server acknowledges it. This is the Runner's outbox. The
//! connection reads unacknowledged events from here, so nothing is lost if the
//! socket drops or the Runner restarts.
//!
//! Layout: `<spool>/<task_id>/meta.json`, `events.bin` (length-delimited
//! protobuf `TaskEvent`s), and `acked` (highest acknowledged seq).
//!
//! `events.bin` holds a run of consecutive records. Once enough of it is
//! acknowledged, the spool rewrites it to start at the last acknowledged
//! record, so it doesn't grow for as long as the task runs. Every record
//! before the first one in the file is acknowledged.
//!
//! While Sling isn't acknowledging, a spool holds at most `BUDGET` bytes of
//! output. Past that it skips the kinds of events Sling itself drops once a
//! task's stored events pass its cap: log lines, commands, agent messages,
//! file changes, and plan updates. It never skips the task's acceptance,
//! rejection, start, finish, token usage, or push and PR results. A note in
//! the task's log says when skipping starts and how much was skipped.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use prost::Message;
use serde::{Deserialize, Serialize};
use sling_runner_protocol::{LogLine, TaskEvent, log_line, task_event::Kind};

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

/// The events file inside a task's spool directory.
const EVENTS: &str = "events.bin";
/// The compacted copy of the events file before it replaces the original.
const COMPACTING: &str = "events.compact";
/// Compaction waits for an acknowledged prefix this big, and as big as the
/// rest of the file, so each compaction copies no more than it frees.
const COMPACT_MIN: u64 = 1024 * 1024;
/// The spool remembers where a record starts at least this often, so replay
/// and compaction can skip the acknowledged prefix without reading it.
const MARK_EVERY: u64 = 64 * 1024;
/// Records handed to the connection per call, by count and by bytes.
const BATCH_EVENTS: usize = 128;
const BATCH_BYTES: u64 = 512 * 1024;
/// Largest record the spool reads. Anything claiming more is treated as torn.
const MAX_RECORD_BYTES: usize = 4 * 1024 * 1024;
/// Largest record the spool writes. Sling closes a connection that sends a
/// message over 4 MiB, so a bigger record could never be delivered and would
/// hold up every record after it.
const RECORD_LIMIT: u64 = 1024 * 1024;
/// Free text longer than this is cut from an event that is over
/// `RECORD_LIMIT`.
const TEXT_LIMIT: usize = 256 * 1024;
/// Unacknowledged bytes a spool holds before it skips output. Sling stores at
/// most 20 MiB of a task's events before dropping the same kinds, so this
/// rarely costs anything Sling would have kept.
const BUDGET: u64 = 32 * 1024 * 1024;

pub struct TaskSpool {
    disk: Arc<dyn Disk>,
    dir: PathBuf,
    pub meta: TaskMeta,
    /// Appends go here. Dropped after a failed write and reopened by the next
    /// append, which first cuts off whatever the failure left behind.
    file: Option<Box<dyn Writer>>,
    /// Bytes of whole records in the events file.
    len: u64,
    /// Seq of the first record in the events file, or `last_seq + 1` when it
    /// is empty.
    first_seq: u64,
    /// Where some records start, oldest first. Marks before the last one at
    /// or before `acked` are dropped.
    marks: VecDeque<Mark>,
    last_seq: u64,
    acked: u64,
    /// Next byte to scan for this connection. Unacknowledged data stays on disk.
    read_offset: u64,
    /// Highest seq handed to the current connection.
    sent: u64,
    /// Skipping output to stay within `BUDGET`. It resumes once
    /// acknowledgements bring the backlog under half the budget.
    skipping: bool,
    /// Events skipped, and their bytes, since the last note about it.
    skipped: (u64, u64),
}

#[derive(Clone, Copy, Debug)]
struct Mark {
    seq: u64,
    offset: u64,
}

impl TaskSpool {
    pub fn create(root: &Path, meta: TaskMeta) -> Result<TaskSpool> {
        TaskSpool::create_on(Arc::new(Os), root, meta)
    }

    pub(crate) fn create_on(disk: Arc<dyn Disk>, root: &Path, meta: TaskMeta) -> Result<TaskSpool> {
        let dir = root.join(&meta.task_id);
        disk.create_dir_all(&dir)?;
        replace_file(
            &*disk,
            &dir.join("meta.json"),
            &serde_json::to_vec_pretty(&meta)?,
            true,
        )?;
        replace_file(&*disk, &dir.join("acked"), b"0", false)?;
        let mut file = disk.append(&dir.join(EVENTS))?;
        file.sync()?;
        disk.sync_dir(&dir)?;
        disk.sync_dir(root)?;
        Ok(TaskSpool {
            disk,
            dir,
            meta,
            file: Some(file),
            len: 0,
            first_seq: 1,
            marks: VecDeque::new(),
            last_seq: 0,
            acked: 0,
            read_offset: 0,
            sent: 0,
            skipping: false,
            skipped: (0, 0),
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
        // A compaction that a crash interrupted before its rename.
        match disk.remove_file(&dir.join(COMPACTING)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => {
                tracing::warn!(task = meta.task_id, %e, "could not remove a spool copy")
            }
            _ => {}
        }
        let path = dir.join(EVENTS);
        let mut scan = scan(&*disk, &path, &meta.task_id)?;
        let mut len = scan.len;
        if scan.last_seq < acked {
            // Sling acknowledged records this file no longer has, which means
            // storage lost writes it had confirmed. The rest of the file is
            // acknowledged too, so it goes, and the next record continues
            // after `acked`. Reusing a lower number would make Sling ignore
            // the new record as one it already has.
            tracing::warn!(
                task = meta.task_id,
                acked,
                last_seq = scan.last_seq,
                "spool lost acknowledged events"
            );
            len = 0;
            scan.marks.clear();
        }
        // Cut off a record a crash left half written, or the stale records.
        if file_len(&*disk, &path)? > len {
            disk.set_len(&path, len)?;
        }
        let file = disk.append(&path)?;
        let last_seq = scan.last_seq.max(acked);
        let mut spool = TaskSpool {
            disk,
            dir: dir.to_path_buf(),
            meta,
            file: Some(file),
            len,
            first_seq: if len == 0 {
                last_seq + 1
            } else {
                scan.first_seq
            },
            marks: scan.marks,
            last_seq,
            acked,
            read_offset: 0,
            sent: acked,
            skipping: false,
            skipped: (0, 0),
        };
        spool.drop_old_marks();
        // Spools from before compaction existed, or left by a crash, get
        // compacted here.
        spool.maybe_compact();
        spool.reset_sent();
        Ok(spool)
    }

    pub fn task_id(&self) -> &str {
        &self.meta.task_id
    }

    pub fn last_seq(&self) -> u64 {
        self.last_seq
    }

    /// Appends an event, synced to disk, and returns its seq, or `None` if
    /// it was skipped to stay within the budget.
    pub fn append(&mut self, kind: Kind) -> Result<Option<u64>> {
        let mut event = self.next_event(kind);
        if record_len(&event) > RECORD_LIMIT
            && let Some(kind) = &mut event.kind
        {
            shorten(kind);
        }
        let size = record_len(&event);
        if event.kind.as_ref().is_some_and(droppable) {
            if size > RECORD_LIMIT {
                tracing::warn!(
                    task = self.task_id(),
                    size,
                    "skipping an event too big to send"
                );
                self.skipped.0 += 1;
                self.skipped.1 += size;
                return Ok(None);
            }
            let limit = if self.skipping { BUDGET / 2 } else { BUDGET };
            if self.unacked_bytes() + size > limit {
                self.skip(size)?;
                return Ok(None);
            }
            self.skipping = false;
        }
        if self.skipped.0 > 0 {
            let (count, bytes) = self.skipped;
            let events = if count == 1 { "event" } else { "events" };
            let note = self.note(format!(
                "Skipped {count} {events} ({}) of this task's output.",
                size_text(bytes)
            ));
            // The note must not cost the event after it, which may be the
            // task's finish.
            match self.write_event(&note) {
                Ok(()) => {
                    self.skipped = (0, 0);
                    event.seq = self.last_seq + 1;
                }
                Err(e) => tracing::warn!(
                    task = self.task_id(),
                    "could not note skipped output: {e:#}"
                ),
            }
        }
        self.write_event(&event)?;
        Ok(Some(event.seq))
    }

    fn next_event(&self, kind: Kind) -> TaskEvent {
        TaskEvent {
            task_id: self.meta.task_id.clone(),
            seq: self.last_seq + 1,
            at_ms: now_ms(),
            kind: Some(kind),
        }
    }

    fn note(&self, text: String) -> TaskEvent {
        self.next_event(Kind::Log(LogLine {
            stream: log_line::Stream::Runner as i32,
            text,
        }))
    }

    fn skip(&mut self, size: u64) -> Result<()> {
        if !self.skipping {
            tracing::warn!(task = self.task_id(), "spool is full, skipping output");
            self.write_event(&self.note(format!(
                "Sling hasn't acknowledged the last {} of this task's output, so the Runner is \
                 skipping log lines, commands, agent messages, file changes, and plan updates \
                 until it catches up. The task's start, finish, token usage, and push and PR \
                 results are always kept.",
                size_text(BUDGET)
            )))?;
            self.skipping = true;
        }
        self.skipped.0 += 1;
        self.skipped.1 += size;
        Ok(())
    }

    /// Bytes from the first unacknowledged record to the end of the file, or a
    /// little more, as marks are sparse.
    fn unacked_bytes(&self) -> u64 {
        if self.acked >= self.last_seq {
            return 0;
        }
        self.len - self.mark_before(self.acked + 1).offset
    }

    fn write_event(&mut self, event: &TaskEvent) -> Result<()> {
        let bytes = event.encode_length_delimited_to_vec();
        anyhow::ensure!(
            bytes.len() as u64 <= RECORD_LIMIT,
            "event exceeds spool record limit"
        );
        let start = self.write_record(&bytes)?;
        self.last_seq = event.seq;
        if self
            .marks
            .back()
            .is_none_or(|m| start - m.offset >= MARK_EVERY)
        {
            self.marks.push_back(Mark {
                seq: event.seq,
                offset: start,
            });
        }
        Ok(())
    }

    /// Writes and syncs one encoded record, and returns where it starts. A
    /// failed write can leave part of the record behind. The next write cuts
    /// it off first, so it never sits in front of later records, where
    /// recovery would stop at it.
    fn write_record(&mut self, bytes: &[u8]) -> Result<u64> {
        let file = match &mut self.file {
            Some(file) => file,
            None => {
                let path = self.dir.join(EVENTS);
                if file_len(&*self.disk, &path)? > self.len {
                    self.disk.set_len(&path, self.len)?;
                }
                self.file.insert(self.disk.append(&path)?)
            }
        };
        if let Err(e) = file.write_bytes(bytes).and_then(|()| file.sync()) {
            self.file = None;
            return Err(e.into());
        }
        let start = self.len;
        self.len += bytes.len() as u64;
        Ok(start)
    }

    pub fn ack(&mut self, seq: u64) -> Result<()> {
        if seq <= self.acked {
            return Ok(());
        }
        self.acked = seq.min(self.last_seq);
        self.drop_old_marks();
        // Not synced: losing it to a power cut only means resending events
        // Sling already has, which it ignores by seq. Compaction keeps the
        // last acknowledged record, so the sequence carries on regardless.
        // Syncing every acknowledgement would cap them at the disk's flush
        // rate, around 120 a second on a Mac, and a long backlog of them
        // would hold up the heartbeat replies queued behind it.
        let saved = replace_file(
            &*self.disk,
            &self.dir.join("acked"),
            self.acked.to_string().as_bytes(),
            false,
        );
        self.maybe_compact();
        saved
    }

    /// Marks before the last one at or before `acked` are no longer needed.
    fn drop_old_marks(&mut self) {
        while self.marks.get(1).is_some_and(|m| m.seq <= self.acked) {
            self.marks.pop_front();
        }
    }

    /// The last known record start at or before `seq`.
    fn mark_before(&self, seq: u64) -> Mark {
        match self.marks.partition_point(|m| m.seq <= seq) {
            0 => Mark {
                seq: self.first_seq,
                offset: 0,
            },
            i => self.marks[i - 1],
        }
    }

    /// Compacts when the acknowledged prefix is at least `COMPACT_MIN` and
    /// as big as the rest, or when a finished task is fully acknowledged.
    /// A failure leaves the events file as it was, so it is only logged.
    fn maybe_compact(&mut self) {
        if self.acked <= self.first_seq {
            return;
        }
        let prefix = self.mark_before(self.acked).offset;
        let done = self.meta.state == SpoolState::Finished && self.acked == self.last_seq;
        if (done || (prefix >= COMPACT_MIN && prefix >= self.len - prefix))
            && let Err(e) = self.compact()
        {
            tracing::warn!(task = self.task_id(), "could not compact spool: {e:#}");
        }
    }

    /// Rewrites the events file to start at the last acknowledged record.
    /// That record stays so the file alone shows how far the task got, should
    /// the `acked` file be lost.
    ///
    /// The copy is synced before it is renamed over the original. A crash
    /// before the rename leaves the original, and the next open deletes the
    /// copy. A power cut that loses the rename brings back the original,
    /// which is still valid.
    fn compact(&mut self) -> Result<()> {
        let path = self.dir.join(EVENTS);
        let copy = self.dir.join(COMPACTING);
        let mark = self.mark_before(self.acked);
        let mut reader = self.disk.reader(&path)?;
        reader.seek(SeekFrom::Start(mark.offset))?;
        let mut start = mark.offset;
        loop {
            let (event, size) = read_record(&mut reader)?
                .context("events file ended before the acknowledged one")?;
            if event.seq >= self.acked {
                break;
            }
            start += size;
        }
        reader.seek(SeekFrom::Start(start))?;
        let mut out = self.disk.create(&copy)?;
        let mut buf = vec![0; 256 * 1024];
        let mut left = self.len - start;
        while left > 0 {
            let n = left.min(buf.len() as u64) as usize;
            reader.read_exact(&mut buf[..n])?;
            out.write_bytes(&buf[..n])?;
            left -= n as u64;
        }
        out.sync()?;
        drop(out);
        drop(reader);
        // Windows can't replace a file this process still has open. The next
        // append reopens whichever file is in place.
        self.file = None;
        self.disk.rename(&copy, &path)?;
        self.len -= start;
        self.first_seq = self.acked;
        self.read_offset = self.read_offset.saturating_sub(start);
        let acked = self.acked;
        let rest = self.marks.iter().filter(|m| m.seq > acked).map(|m| Mark {
            seq: m.seq,
            offset: m.offset - start,
        });
        self.marks = std::iter::once(Mark {
            seq: acked,
            offset: 0,
        })
        .chain(rest)
        .collect();
        self.disk.sync_dir(&self.dir)?;
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
        let mut out = Vec::new();
        let done = self.sent.max(self.acked);
        if done >= self.last_seq {
            return Ok(out);
        }
        let mut reader = self.disk.reader(&self.dir.join(EVENTS))?;
        reader.seek(SeekFrom::Start(self.read_offset))?;
        let mut bytes = 0;
        while out.len() < BATCH_EVENTS && bytes < BATCH_BYTES && self.read_offset < self.len {
            let Some((event, size)) = read_record(&mut reader)? else {
                break;
            };
            self.read_offset += size;
            if event.seq <= self.sent.max(self.acked) {
                continue;
            }
            bytes += size;
            self.sent = event.seq;
            out.push(event);
        }
        Ok(out)
    }

    /// Called on every new connection: resend everything unacknowledged.
    pub fn reset_sent(&mut self) {
        self.sent = self.acked;
        self.read_offset = self.mark_before(self.acked + 1).offset;
    }

    pub fn set_meta(&mut self, f: impl FnOnce(&mut TaskMeta)) -> Result<()> {
        f(&mut self.meta);
        replace_file(
            &*self.disk,
            &self.dir.join("meta.json"),
            &serde_json::to_vec_pretty(&self.meta)?,
            true,
        )?;
        self.maybe_compact();
        Ok(())
    }

    pub fn remove(self) -> Result<()> {
        drop(self.file);
        self.disk.remove_dir_all(&self.dir)?;
        Ok(())
    }
}

/// Reads one record without loading the rest of the file, and returns it with
/// its size on disk. `None` at the end, or at a record that is incomplete or
/// doesn't decode.
fn read_record(reader: &mut impl Read) -> Result<Option<(TaskEvent, u64)>> {
    let mut len = 0u64;
    for (i, shift) in (0..70).step_by(7).enumerate() {
        let mut byte = [0];
        match reader.read_exact(&mut byte) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
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
            return match reader.read_exact(&mut bytes) {
                Ok(()) => Ok(TaskEvent::decode(bytes.as_slice())
                    .ok()
                    .map(|event| (event, i as u64 + 1 + len))),
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(None),
                Err(e) => Err(e.into()),
            };
        }
    }
    Ok(None)
}

/// The whole records at the start of an events file.
struct Scan {
    first_seq: u64,
    last_seq: u64,
    len: u64,
    marks: VecDeque<Mark>,
}

/// Reads records up to the first one that isn't whole, this task's, and next
/// in sequence. Nothing after it was ever confirmed written: it is a torn
/// tail, zeros where a power cut kept a file's new length but not its data,
/// or stale bytes. Zeros and stale bytes can still decode, so the task ID and
/// sequence checks are what catch them.
fn scan(disk: &dyn Disk, path: &Path, task_id: &str) -> Result<Scan> {
    let mut scan = Scan {
        first_seq: 0,
        last_seq: 0,
        len: 0,
        marks: VecDeque::new(),
    };
    let mut reader = match disk.reader(path) {
        Ok(reader) => reader,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(scan),
        Err(e) => return Err(e.into()),
    };
    while let Some((event, size)) = read_record(&mut reader)? {
        let in_sequence = if scan.len == 0 {
            event.seq > 0
        } else {
            event.seq == scan.last_seq + 1
        };
        if event.task_id != task_id || !in_sequence {
            break;
        }
        if scan.len == 0 {
            scan.first_seq = event.seq;
        }
        if scan
            .marks
            .back()
            .is_none_or(|m| scan.len - m.offset >= MARK_EVERY)
        {
            scan.marks.push_back(Mark {
                seq: event.seq,
                offset: scan.len,
            });
        }
        scan.last_seq = event.seq;
        scan.len += size;
    }
    Ok(scan)
}

/// The kinds Sling drops once a task's stored events pass its cap. Every other
/// kind changes the task's state, so it is always kept.
fn droppable(kind: &Kind) -> bool {
    match kind {
        Kind::Log(_)
        | Kind::Command(_)
        | Kind::AgentMessage(_)
        | Kind::FileChange(_)
        | Kind::Plan(_) => true,
        Kind::Accepted(_)
        | Kind::Rejected(_)
        | Kind::Started(_)
        | Kind::Usage(_)
        | Kind::Finished(_)
        | Kind::ActionResult(_) => false,
    }
}

/// Cuts the free text of an event too big to send. A task's start and finish
/// are small otherwise, so this always makes them fit. A plan or file change
/// can still be too big, and is skipped.
fn shorten(kind: &mut Kind) {
    fn cut(text: &mut String) {
        if text.len() > TEXT_LIMIT {
            let mut end = TEXT_LIMIT;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            text.push_str("\n[cut by the Runner: too long to send]");
        }
    }
    match kind {
        Kind::AgentMessage(m) => cut(&mut m.text),
        Kind::Command(c) => {
            cut(&mut c.command);
            cut(&mut c.output);
        }
        Kind::Log(l) => cut(&mut l.text),
        Kind::Rejected(r) => cut(&mut r.message),
        Kind::Finished(f) => {
            cut(&mut f.summary);
            cut(&mut f.error);
        }
        Kind::ActionResult(a) => cut(&mut a.message),
        _ => {}
    }
}

fn record_len(event: &TaskEvent) -> u64 {
    let len = event.encoded_len();
    (prost::length_delimiter_len(len) + len) as u64
}

fn size_text(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
}

/// A missing file counts as empty.
fn file_len(disk: &dyn Disk, path: &Path) -> io::Result<u64> {
    match disk.len(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(0),
        other => other,
    }
}

/// Writes a small file through a temporary file and a rename, so a crash
/// leaves the old contents or the new, never a mix. `durable` also syncs the
/// new contents before the rename and the directory after it, so a power cut
/// can't leave the file empty.
fn replace_file(disk: &dyn Disk, path: &Path, bytes: &[u8], durable: bool) -> Result<()> {
    let tmp = path.with_extension("tmp");
    let mut file = disk.create(&tmp)?;
    file.write_bytes(bytes)?;
    if durable {
        file.sync()?;
    }
    drop(file);
    disk.rename(&tmp, path)?;
    if durable && let Some(parent) = path.parent() {
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
    fn remove_file(&self, path: &Path) -> io::Result<()>;
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

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        std::fs::remove_file(path)
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

#[cfg(test)]
#[path = "spool_sim.rs"]
mod sim;
