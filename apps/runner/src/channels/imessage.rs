//! iMessage on a Mac. New messages come from the Messages database, opened
//! read-only and polled every 2 seconds for rows past the channel's place.
//! Sends go through AppleScript, with the recipient and the text passed as
//! arguments to a fixed script, never written into it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use tokio::process::Command;

use super::{
    ChannelEntry, Kind, MAX_OUTBOX, Pending, current_entry, normalize_address, set_health,
};
use crate::config::{Paths, write_private};
use crate::tasks::Manager;

pub const POLL: Duration = if cfg!(test) {
    Duration::from_millis(100)
} else {
    Duration::from_secs(2)
};
/// Rows read per poll.
const BATCH: usize = 200;
/// 2001-01-01, where the Messages database counts time from.
const APPLE_EPOCH_MS: i64 = 978_307_200_000;
/// chat.style for a group chat. One-to-one chats are 45.
const GROUP_STYLE: i64 = 43;
const SEND_TIMEOUT: Duration = Duration::from_secs(30);
/// The first check may wait on the "control Messages" prompt.
const CHECK_TIMEOUT: Duration = Duration::from_secs(120);

/// Sends `item 2` of argv to `item 1`: a chat by its ID when the target has
/// a `;` in it, as group IDs do, or else a person by number or email.
pub const SEND_SCRIPT: &str = r#"on run argv
	set theTarget to item 1 of argv
	set theText to item 2 of argv
	tell application "Messages"
		if theTarget contains ";" then
			send theText to chat id theTarget
		else
			set theAccount to 1st account whose service type = iMessage
			send theText to participant theTarget of theAccount
		end if
	end tell
end run
"#;

const CHECK_SCRIPT: &str =
    r#"tell application "Messages" to get id of 1st account whose service type = iMessage"#;

/// One row of the Messages database, with what's needed to forward it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub rowid: i64,
    pub text: String,
    pub at_ms: i64,
    pub from_me: bool,
    /// The sender's handle: a phone number or an email address.
    pub sender: Option<String>,
    /// The chat's ID, such as `iMessage;+;chat123` for a group.
    pub chat: Option<String>,
    pub group: bool,
    /// A tapback, or a group event such as someone joining, rather than a
    /// message someone wrote.
    pub not_a_message: bool,
}

/// Why the Messages database can't be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbError {
    /// macOS keeps it behind Full Disk Access.
    NoAccess,
    Missing(PathBuf),
    Other(String),
}

impl DbError {
    /// For the inventory, which Sling shows on Machines.
    pub fn for_machine(&self) -> String {
        match self {
            DbError::NoAccess => format!(
                "Needs Full Disk Access for {} in System Settings → Privacy & Security → Full Disk Access",
                runner_exe()
            ),
            DbError::Missing(_) => {
                "Messages has no database yet. Open Messages and sign in to iMessage.".into()
            }
            DbError::Other(e) => format!("Couldn't read Messages: {e}"),
        }
    }
}

fn runner_exe() -> String {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "sling-runner".into())
}

pub struct Reader {
    conn: Connection,
}

impl Reader {
    /// Opens the database read-only. Messages keeps writing to it, so reads
    /// see its new rows as they're committed.
    pub fn open(path: &Path) -> Result<Reader, DbError> {
        // Asking the file system first tells a missing permission apart from
        // a missing file; SQLite reports both as "unable to open".
        if let Err(e) = std::fs::File::open(path) {
            return Err(match e.kind() {
                std::io::ErrorKind::NotFound => DbError::Missing(path.to_path_buf()),
                std::io::ErrorKind::PermissionDenied => DbError::NoAccess,
                _ => DbError::Other(e.to_string()),
            });
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| DbError::Other(e.to_string()))?;
        conn.busy_timeout(Duration::from_secs(2))
            .map_err(|e| DbError::Other(e.to_string()))?;
        let has_messages: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| DbError::Other(e.to_string()))?;
        if has_messages.is_none() {
            return Err(DbError::Other(format!(
                "{} isn't a Messages database",
                path.display()
            )));
        }
        Ok(Reader { conn })
    }

    pub fn last_rowid(&self) -> rusqlite::Result<i64> {
        self.conn
            .query_row("SELECT COALESCE(MAX(ROWID), 0) FROM message", [], |r| {
                r.get(0)
            })
    }

    /// Up to `limit` rows after `rowid`, oldest first.
    pub fn after(&self, rowid: i64, limit: usize) -> rusqlite::Result<Vec<Message>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT m.ROWID, m.text, m.attributedBody, m.date, m.is_from_me,
                    COALESCE(m.associated_message_type, 0), COALESCE(m.item_type, 0),
                    h.id, c.guid, c.style
             FROM message m
             LEFT JOIN handle h ON h.ROWID = m.handle_id
             LEFT JOIN chat c ON c.ROWID =
                 (SELECT chat_id FROM chat_message_join WHERE message_id = m.ROWID LIMIT 1)
             WHERE m.ROWID > ?1
             ORDER BY m.ROWID
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![rowid, limit as i64], |r| {
            let text: Option<String> = r.get(1)?;
            let body: Option<Vec<u8>> = r.get(2)?;
            let date: Option<i64> = r.get(3)?;
            let reaction: i64 = r.get(5)?;
            let item: i64 = r.get(6)?;
            let style: Option<i64> = r.get(9)?;
            let text = text
                .filter(|t| !t.trim().is_empty())
                .or_else(|| body.as_deref().and_then(attributed_text))
                .unwrap_or_default();
            Ok(Message {
                rowid: r.get(0)?,
                text: clean(&text),
                at_ms: apple_time_ms(date.unwrap_or(0)),
                from_me: r.get::<_, Option<i64>>(4)?.unwrap_or(0) != 0,
                sender: r.get(7)?,
                chat: r.get(8)?,
                group: style == Some(GROUP_STYLE),
                not_a_message: reaction != 0 || item != 0,
            })
        })?;
        rows.collect()
    }
}

/// Whether the database can be opened, for a quick look without polling.
pub fn can_open(db: &Path) -> Result<(), String> {
    Reader::open(db).map(|_| ()).map_err(|e| e.for_machine())
}

/// Times are nanoseconds since 2001 on current macOS, and seconds before
/// High Sierra.
fn apple_time_ms(date: i64) -> i64 {
    if date.abs() > 100_000_000_000 {
        APPLE_EPOCH_MS + date / 1_000_000
    } else {
        APPLE_EPOCH_MS + date * 1000
    }
}

/// Drops the placeholder Messages puts where an attachment was.
fn clean(text: &str) -> String {
    text.replace('\u{fffc}', "").trim().to_string()
}

/// The text of a message kept only in `attributedBody`, as recent macOS
/// often does: an NSAttributedString archived as a typedstream. The string
/// follows its class name, after a `+` that marks a C string, with its length
/// in one byte, or 0x81 and two bytes, or 0x82 and four, little-endian.
pub fn attributed_text(blob: &[u8]) -> Option<String> {
    let start = find(blob, b"NSString")
        .map(|i| i + b"NSString".len())
        .or_else(|| find(blob, b"NSMutableString").map(|i| i + b"NSMutableString".len()))?;
    let rest = blob.get(start..)?;
    let plus = rest.iter().take(16).position(|&b| b == b'+')?;
    let at = plus + 1;
    let (len, width) = match *rest.get(at)? {
        0x81 => (
            u16::from_le_bytes([*rest.get(at + 1)?, *rest.get(at + 2)?]) as usize,
            3,
        ),
        0x82 => (
            u32::from_le_bytes(rest.get(at + 1..at + 5)?.try_into().ok()?) as usize,
            5,
        ),
        b => (b as usize, 1),
    };
    let bytes = rest.get(at + width..at + width + len)?;
    Some(String::from_utf8_lossy(bytes).into_owned())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// The message to hand to Sling, and whether it's from a group, or None
/// when it's not one to forward: sent from this Mac, not someone's words,
/// empty, or from a sender the channel doesn't allow.
pub fn forwardable(e: &ChannelEntry, m: &Message) -> Option<(Pending, bool)> {
    if m.from_me || m.not_a_message || m.text.is_empty() {
        return None;
    }
    let sender = normalize_address(m.sender.as_deref()?)?;
    if !e.allowed_senders.contains(&sender) {
        return None;
    }
    let (conversation, group) = match &m.chat {
        Some(chat) if m.group => (chat.clone(), true),
        _ => (sender.clone(), false),
    };
    Some((
        Pending {
            message_id: m.rowid.to_string(),
            conversation,
            sender,
            text: m.text.clone(),
            at_ms: m.at_ms,
        },
        group,
    ))
}

// ---------------------------------------------------------------- poller

/// Starts polling for the channel. Dropping the returned sender stops it.
pub fn start(mgr: Arc<Manager>, name: String) -> Sender<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name(format!("imessage-{name}"))
        .spawn(move || poll_loop(&mgr, &name, &rx));
    if let Err(e) = spawned {
        tracing::error!("couldn't start the iMessage reader: {e}");
    }
    tx
}

fn poll_loop(mgr: &Arc<Manager>, name: &str, stop: &Receiver<()>) {
    let mut reader: Option<Reader> = None;
    loop {
        if let Some(e) = current_entry(mgr, name).filter(|e| e.kind == Kind::Imessage) {
            poll_once(mgr, &e, &mut reader);
        }
        match stop.recv_timeout(POLL) {
            Err(RecvTimeoutError::Timeout) => {}
            _ => return,
        }
    }
}

fn poll_once(mgr: &Manager, e: &ChannelEntry, reader: &mut Option<Reader>) {
    let Some(db) = e.messages_db() else {
        set_health(&e.name, false, "No home folder to find Messages in.");
        return;
    };
    if reader.is_none() {
        match Reader::open(&db) {
            Ok(r) => *reader = Some(r),
            Err(err) => {
                set_health(&e.name, false, err.for_machine());
                return;
            }
        }
    }
    let Some(r) = reader.as_ref() else { return };
    match step(mgr, e, r) {
        Ok(()) => set_health(&e.name, true, ""),
        Err(err) => {
            tracing::warn!(channel = %e.name, "reading Messages failed: {err}");
            set_health(
                &e.name,
                false,
                DbError::Other(err.to_string()).for_machine(),
            );
            *reader = None;
        }
    }
}

/// Reads what's new and forwards what the channel allows. A channel with no
/// place yet, or coming back from being turned off, starts from the newest
/// row, so nothing from before is answered.
fn step(mgr: &Manager, e: &ChannelEntry, r: &Reader) -> rusqlite::Result<()> {
    let from = mgr
        .channels
        .with_live(&mgr.paths, &e.name, Kind::Imessage, |l| {
            (l.store.cursor.is_some() && !l.store.paused).then_some(l.scanned)
        });
    let Some(from) = from else {
        let newest = r.last_rowid()?;
        mgr.channels
            .with_live(&mgr.paths, &e.name, Kind::Imessage, |l| {
                l.outbox.clear();
                l.scanned = newest;
                l.store.paused = false;
                l.store.cursor = Some(newest);
                l.store.save(&mgr.paths, &e.name);
            });
        return Ok(());
    };
    if mgr.channels.outbox_len(&e.name) >= MAX_OUTBOX {
        return Ok(());
    }
    let rows = r.after(from, BATCH)?;
    let mut scanned = from;
    for m in &rows {
        if let Some((p, group)) = forwardable(e, m)
            && !mgr.channel_forward(e, p, group)
            && mgr.channels.outbox_len(&e.name) >= MAX_OUTBOX
        {
            break;
        }
        scanned = m.rowid;
    }
    if scanned != from {
        mgr.channels
            .with_live(&mgr.paths, &e.name, Kind::Imessage, |l| {
                l.scanned = scanned;
                l.settle(&mgr.paths, &e.name);
            });
    }
    Ok(())
}

// ---------------------------------------------------------------- sending

/// Sends `text` to a person or a group chat. Runs outside the Runner's
/// command sandbox, which blocks Apple Events.
pub async fn send(osascript: &str, paths: &Paths, to: &str, text: &str) -> Result<(), String> {
    if to.is_empty() || to.starts_with('-') || to.chars().any(char::is_control) {
        return Err(format!("{to:?} isn't a chat iMessage can send to."));
    }
    let script =
        send_script(paths).map_err(|e| format!("Couldn't write the send script: {e:#}"))?;
    let run = Command::new(osascript)
        .arg(&script)
        .arg(to)
        .arg(text)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(SEND_TIMEOUT, run).await {
        Err(_) => Err("Messages didn't answer within 30 seconds.".into()),
        Ok(Err(e)) => Err(format!("Couldn't run {osascript}: {e}")),
        Ok(Ok(out)) if out.status.success() => Ok(()),
        Ok(Ok(out)) => Err(explain(&String::from_utf8_lossy(&out.stderr))),
    }
}

/// The send script, written once to the Runner's data folder. The file
/// comes first on osascript's command line, so nothing after it is read as
/// an option, whatever the text starts with.
fn send_script(paths: &Paths) -> anyhow::Result<PathBuf> {
    let path = paths
        .data_dir
        .join("channels")
        .join("send-imessage.applescript");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(SEND_SCRIPT) {
        write_private(&path, SEND_SCRIPT.as_bytes())?;
    }
    Ok(path)
}

/// Checks that Messages answers to AppleScript and has iMessage signed in.
pub async fn check_messages(osascript: &str) -> Result<(), String> {
    let run = Command::new(osascript)
        .args(["-e", CHECK_SCRIPT])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(CHECK_TIMEOUT, run).await {
        Err(_) => Err("Messages didn't answer. Open Messages, then run this again.".into()),
        Ok(Err(e)) => Err(format!("Couldn't run {osascript}: {e}")),
        Ok(Ok(out)) if out.status.success() => Ok(()),
        Ok(Ok(out)) => Err(explain(&String::from_utf8_lossy(&out.stderr))),
    }
}

/// What an AppleScript error means for whoever has to fix it.
fn explain(stderr: &str) -> String {
    if stderr.contains("-1743") || stderr.contains("Not authorized") {
        return "macOS doesn't let sling-runner control Messages. Allow it in System Settings → Privacy & Security → Automation.".into();
    }
    if stderr.contains("-1719")
        || stderr.contains("Can’t get account")
        || stderr.contains("Can't get account")
    {
        return "Messages isn't signed in to iMessage on this Mac. Sign in under Messages → Settings → iMessage.".into();
    }
    if stderr.contains("-1728") {
        return "Messages couldn't find that chat or person.".into();
    }
    let line = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("it failed with no message");
    format!("Messages refused it: {line}")
}

#[cfg(test)]
pub mod testdb {
    //! A database with the Messages schema, for tests. Never the real one.

    use std::path::Path;

    use rusqlite::{Connection, params};

    pub const SCHEMA: &str = "
        PRAGMA journal_mode = WAL;
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT NOT NULL DEFAULT 'iMessage');
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, chat_identifier TEXT, service_name TEXT, display_name TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, handle_id INTEGER DEFAULT 0, service TEXT, date INTEGER, is_from_me INTEGER DEFAULT 0, attributedBody BLOB, associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE (chat_id, handle_id));
    ";

    pub fn create(path: &Path) -> Connection {
        let c = Connection::open(path).unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }

    /// An attributedBody as Messages writes it, around `text`.
    pub fn attributed_body(text: &str) -> Vec<u8> {
        let mut b = b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+".to_vec();
        let bytes = text.as_bytes();
        if bytes.len() < 0x80 {
            b.push(bytes.len() as u8);
        } else {
            b.push(0x81);
            b.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
        }
        b.extend_from_slice(bytes);
        b.extend_from_slice(b"\x86\x84\x02iI\x01\x05\x92\x84\x84\x84\x0cNSDictionary\x00\x94\x84\x01i\x01\x92\x84\x96\x96\x1d__kIMMessagePartAttributeName\x86\x92\x84\x84\x84\x08NSNumber\x00\x84\x84\x07NSValue\x00\x94\x84\x01*\x84\x99\x99\x00\x86\x86\x86");
        b
    }

    /// The handle's row, added the first time.
    pub fn handle(c: &Connection, id: &str) -> i64 {
        if let Ok(rowid) = c.query_row("SELECT ROWID FROM handle WHERE id = ?1", [id], |r| r.get(0))
        {
            return rowid;
        }
        c.execute("INSERT INTO handle (id) VALUES (?1)", [id])
            .unwrap();
        c.last_insert_rowid()
    }

    pub fn chat(c: &Connection, guid: &str, group: bool) -> i64 {
        if let Ok(rowid) = c.query_row("SELECT ROWID FROM chat WHERE guid = ?1", [guid], |r| {
            r.get(0)
        }) {
            return rowid;
        }
        c.execute(
            "INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?1, ?2, ?3, 'iMessage')",
            params![guid, if group { 43 } else { 45 }, guid.rsplit(';').next().unwrap_or(guid)],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    pub struct Row<'a> {
        pub from: &'a str,
        pub text: Option<&'a str>,
        pub body: Option<&'a str>,
        pub from_me: bool,
        pub group: Option<&'a str>,
        pub reaction: bool,
    }

    impl Default for Row<'_> {
        fn default() -> Self {
            Row {
                from: "+351912345678",
                text: Some("hello"),
                body: None,
                from_me: false,
                group: None,
                reaction: false,
            }
        }
    }

    /// Adds a message as Messages would, and returns its ROWID.
    pub fn insert(c: &Connection, row: Row<'_>) -> i64 {
        let handle = handle(c, row.from);
        let chat = match row.group {
            Some(g) => chat(c, g, true),
            None => chat(c, &format!("iMessage;-;{}", row.from), false),
        };
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM message", [], |r| r.get(0))
            .unwrap();
        // Nanoseconds since 2001-01-01.
        let date: i64 = 784_000_000_000_000_000 + n;
        c.execute(
            "INSERT INTO message (guid, text, handle_id, service, date, is_from_me, attributedBody, associated_message_type)
             VALUES (?1, ?2, ?3, 'iMessage', ?4, ?5, ?6, ?7)",
            params![
                format!("guid-{n}-{}", row.from),
                row.text,
                handle,
                date,
                row.from_me as i64,
                row.body.map(attributed_body),
                if row.reaction { 2000 } else { 0 },
            ],
        )
        .unwrap();
        let id = c.last_insert_rowid();
        c.execute(
            "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?1, ?2, ?3)",
            params![chat, id, date],
        )
        .unwrap();
        id
    }
}
