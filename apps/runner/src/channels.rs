//! Messaging channels the machine relays for Sling, such as iMessage and
//! Signal, which have no API the control plane can call. Only the machine
//! adds a channel or allows its senders. Messages from anyone else never
//! leave it, and it sends only to the senders it allows and to groups they
//! wrote in, whatever the control plane asks.
//!
//! Each channel keeps its place on disk. A message stays in the outbox until
//! Sling says it stored it, and goes out again after a reconnect until then,
//! so one that arrived while the Runner was down reaches Sling once it's back.

pub mod cli;
mod imessage;
mod signal;
mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sling_runner_protocol::envelope::Body;
use sling_runner_protocol::{Channel, ChannelMessageAck, ChannelSend, ChannelSendResult};
use tokio::sync::mpsc;

use crate::config::{Config, Paths};
use crate::tasks::Manager;

pub use store::Pending;

/// How often the workers are checked against the config.
const RECONCILE_EVERY: Duration = Duration::from_secs(5);
/// Messages forwarded and not acknowledged yet, per channel. A channel stops
/// reading more until Sling catches up.
const MAX_OUTBOX: usize = 500;
/// Longest message the Runner sends.
const MAX_SEND_BYTES: usize = 64 * 1024;
/// Group conversations remembered per channel, newest last.
const MAX_GROUPS: usize = 200;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Imessage,
    Signal,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Imessage => "imessage",
            Kind::Signal => "signal",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Kind::Imessage => "iMessage",
            Kind::Signal => "Signal",
        }
    }
}

/// One channel in `runner.toml`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ChannelEntry {
    pub kind: Kind,
    /// Unique on this machine. Sling names the channel by it.
    pub name: String,
    /// Signal: the account's phone number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// The program that sends: signal-cli for Signal, osascript for iMessage.
    /// Found on PATH when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bin: Option<String>,
    /// iMessage: the Messages database, `~/Library/Messages/chat.db` when
    /// unset. Only tests point it elsewhere.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages_db: Option<PathBuf>,
    /// Phone numbers, email addresses, or Signal account IDs whose messages go
    /// to Sling, as `normalize_address` writes them. Nothing goes while it's
    /// empty.
    #[serde(default)]
    pub allowed_senders: Vec<String>,
}

impl ChannelEntry {
    pub fn bin(&self) -> String {
        self.bin.clone().unwrap_or_else(|| {
            match self.kind {
                Kind::Imessage => "osascript",
                Kind::Signal => "signal-cli",
            }
            .into()
        })
    }

    pub fn messages_db(&self) -> Option<PathBuf> {
        self.messages_db
            .clone()
            .or_else(|| crate::sys::home_dir().map(|h| h.join("Library/Messages/chat.db")))
    }

    pub fn allows(&self, address: &str) -> bool {
        normalize_address(address).is_some_and(|a| self.allowed_senders.contains(&a))
    }

    /// What a running worker was started with. A change restarts it.
    fn worker_key(&self) -> (Kind, Option<String>, Option<String>, Option<PathBuf>) {
        (
            self.kind,
            self.account.clone(),
            self.bin.clone(),
            self.messages_db.clone(),
        )
    }
}

/// A phone number with its country code and only digits after the `+`, an
/// email address in lowercase, or a Signal account ID in lowercase. None for
/// anything else, such as a short code or a business chat.
pub fn normalize_address(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > 254 || s.chars().any(|c| c.is_control()) {
        return None;
    }
    if let Some((local, domain)) = s.split_once('@') {
        let ok = !local.is_empty()
            && domain.contains('.')
            && !domain.contains('@')
            && !domain.starts_with('.')
            && !domain.ends_with('.')
            && !s.chars().any(char::is_whitespace);
        return ok.then(|| s.to_lowercase());
    }
    if is_uuid(s) {
        return Some(s.to_ascii_lowercase());
    }
    let compact: String = s
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '(' | ')' | '.'))
        .collect();
    let digits = compact.strip_prefix('+')?;
    ((6..=15).contains(&digits.len()) && digits.chars().all(|c| c.is_ascii_digit()))
        .then_some(compact)
}

/// Where a program is: the path itself when it names one, or the first match
/// on PATH.
pub fn find_program(bin: &str) -> Option<PathBuf> {
    if bin.contains('/') {
        let p = PathBuf::from(bin);
        return p.is_file().then_some(p);
    }
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(bin))
            .find(|p| p.is_file())
    })
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// Checks a channel name: lowercase letters, digits, `-` and `_`, up to 40
/// characters. It names the channel's files, too.
pub fn check_name(name: &str) -> anyhow::Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 40
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'));
    if !ok {
        anyhow::bail!(
            "invalid channel name {name:?}: use lowercase letters, digits, '-' and '_', up to 40 characters"
        );
    }
    Ok(())
}

// ---------------------------------------------------------------- health

/// Whether a running channel can receive and send right now, as its worker
/// last found. The inventory reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Health {
    ready: bool,
    missing: String,
}

/// By channel name. There's one Manager per process, and the inventory is
/// built from the config alone, so the workers report here.
static HEALTH: LazyLock<Mutex<HashMap<String, Health>>> = LazyLock::new(Default::default);

fn set_health(name: &str, ready: bool, missing: impl Into<String>) {
    let missing = if ready { String::new() } else { missing.into() };
    HEALTH
        .lock()
        .unwrap()
        .insert(name.to_string(), Health { ready, missing });
}

fn clear_health(name: &str) {
    HEALTH.lock().unwrap().remove(name);
}

fn health(name: &str) -> Option<Health> {
    HEALTH.lock().unwrap().get(name).cloned()
}

/// The channels set up on this machine, for the inventory.
pub fn inventory(cfg: &Config) -> Vec<Channel> {
    cfg.channel_entries
        .iter()
        .map(|e| {
            let h = if cfg.channels {
                health(&e.name).unwrap_or_else(|| first_look(e))
            } else {
                Health {
                    ready: false,
                    missing: "Off on this machine: sling-runner config set channels on".into(),
                }
            };
            Channel {
                kind: e.kind.as_str().into(),
                name: e.name.clone(),
                allowed_senders: e.allowed_senders.len() as u32,
                ready: h.ready,
                missing: h.missing,
            }
        })
        .collect()
}

/// A line per channel for `sling-runner doctor`.
pub fn doctor(channels: &[Channel]) -> Vec<String> {
    channels
        .iter()
        .map(|c| {
            let (mark, detail) = if c.ready {
                ("ok  ", format!("{} senders allowed", c.allowed_senders))
            } else {
                ("FAIL", c.missing.clone())
            };
            format!("{mark} {:<18} {} ({}): {detail}", "channel", c.name, c.kind)
        })
        .collect()
}

/// What can be told without running the channel: whether the Messages
/// database can be opened, or signal-cli found.
fn first_look(e: &ChannelEntry) -> Health {
    let problem = match e.kind {
        Kind::Imessage => e
            .messages_db()
            .map(|db| imessage::can_open(&db).err())
            .unwrap_or_else(|| Some("No home folder to find Messages in.".into())),
        Kind::Signal => find_program(&e.bin())
            .is_none()
            .then(|| signal::NOT_INSTALLED.to_string()),
    };
    match problem {
        Some(missing) => Health {
            ready: false,
            missing,
        },
        None => Health {
            ready: true,
            missing: String::new(),
        },
    }
}

// ---------------------------------------------------------------- runtime

/// Every channel's outbox and workers while the Runner runs.
#[derive(Default)]
pub struct Channels {
    live: Mutex<HashMap<String, Live>>,
    workers: Mutex<HashMap<String, Worker>>,
}

struct Live {
    kind: Kind,
    store: store::Store,
    /// iMessage: the last row read in this run.
    scanned: i64,
    /// Forwarded and not acknowledged, oldest first, with whether the current
    /// connection has it.
    outbox: Vec<(Pending, bool)>,
}

struct Worker {
    key: (Kind, Option<String>, Option<String>, Option<PathBuf>),
    handle: WorkerHandle,
}

enum WorkerHandle {
    /// Dropping it stops the poller.
    Imessage(#[allow(dead_code)] std::sync::mpsc::Sender<()>),
    Signal(mpsc::Sender<signal::Request>, tokio::task::AbortHandle),
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let WorkerHandle::Signal(_, abort) = &self.handle {
            abort.abort();
        }
    }
}

impl Channels {
    /// Loads a channel's state from disk the first time it's needed.
    fn with_live<T>(
        &self,
        paths: &Paths,
        name: &str,
        kind: Kind,
        f: impl FnOnce(&mut Live) -> T,
    ) -> T {
        let mut live = self.live.lock().unwrap();
        let entry = live.entry(name.to_string()).or_insert_with(|| {
            let store = store::Store::load(paths, name);
            let outbox = store.pending.iter().cloned().map(|p| (p, false)).collect();
            Live {
                kind,
                scanned: store.cursor.unwrap_or(0),
                store,
                outbox,
            }
        });
        f(entry)
    }

    /// Messages the current connection hasn't been sent yet.
    pub fn unsent(&self) -> Vec<Body> {
        let mut live = self.live.lock().unwrap();
        let mut out = Vec::new();
        for (name, l) in live.iter_mut() {
            for (p, sent) in l.outbox.iter_mut().filter(|(_, sent)| !*sent) {
                *sent = true;
                out.push(Body::ChannelMessage(p.to_proto(name)));
            }
        }
        out
    }

    /// Everything unacknowledged goes out again on the next connection.
    pub fn reset_sent(&self) {
        for l in self.live.lock().unwrap().values_mut() {
            for (_, sent) in l.outbox.iter_mut() {
                *sent = false;
            }
        }
    }

    /// Sling stored a message, so the channel's place can move past it.
    fn ack(&self, paths: &Paths, channel: &str, message_id: &str) {
        let mut live = self.live.lock().unwrap();
        let Some(l) = live.get_mut(channel) else {
            return;
        };
        let before = l.outbox.len();
        l.outbox.retain(|(p, _)| p.message_id != message_id);
        if l.outbox.len() != before {
            l.settle(paths, channel);
        }
    }

    /// Adds a message to the outbox. False when it's already there, or the
    /// outbox is full.
    fn forward(&self, paths: &Paths, channel: &str, kind: Kind, p: Pending, group: bool) -> bool {
        self.with_live(paths, channel, kind, |l| {
            if l.outbox.len() >= MAX_OUTBOX
                || l.outbox.iter().any(|(q, _)| q.message_id == p.message_id)
            {
                return false;
            }
            if group {
                l.store.remember_group(&p.conversation, MAX_GROUPS);
            }
            l.outbox.push((p, false));
            if kind == Kind::Signal {
                l.settle(paths, channel);
            }
            true
        })
    }

    fn outbox_len(&self, channel: &str) -> usize {
        self.live
            .lock()
            .unwrap()
            .get(channel)
            .map_or(0, |l| l.outbox.len())
    }

    /// Whether a send may go to this conversation: one of the allowed
    /// senders, or a group one of them wrote in.
    fn may_send(&self, paths: &Paths, e: &ChannelEntry, conversation: &str) -> bool {
        e.allows(conversation)
            || self.with_live(paths, &e.name, e.kind, |l| {
                l.store.groups.iter().any(|g| g == conversation)
            })
    }

    fn signal_sender(&self, name: &str) -> Option<mpsc::Sender<signal::Request>> {
        match &self.workers.lock().unwrap().get(name)?.handle {
            WorkerHandle::Signal(tx, _) => Some(tx.clone()),
            WorkerHandle::Imessage(_) => None,
        }
    }

    /// Drops what's kept for a channel that was removed from the config.
    fn forget(&self, paths: &Paths, name: &str) {
        self.live.lock().unwrap().remove(name);
        clear_health(name);
        store::Store::remove(paths, name);
    }
}

impl Live {
    /// Saves the channel's place after the outbox changed: for iMessage the
    /// row before the oldest message Sling hasn't stored, for Signal the
    /// messages themselves, since signal-cli won't hand them out again.
    fn settle(&mut self, paths: &Paths, name: &str) {
        match self.kind {
            Kind::Imessage => {
                let cursor = self
                    .outbox
                    .iter()
                    .filter_map(|(p, _)| p.message_id.parse::<i64>().ok())
                    .min()
                    .map_or(self.scanned, |oldest| oldest - 1);
                if self.store.cursor != Some(cursor) {
                    self.store.cursor = Some(cursor);
                    self.store.save(paths, name);
                }
            }
            Kind::Signal => {
                self.store.pending = self.outbox.iter().map(|(p, _)| p.clone()).collect();
                self.store.save(paths, name);
            }
        }
    }
}

impl Manager {
    /// Starts the channels' workers and keeps them in step with the config,
    /// which the connection reloads every minute.
    pub fn start_channels(self: &Arc<Self>) {
        let mgr = self.clone();
        tokio::spawn(async move {
            loop {
                reconcile(&mgr);
                tokio::time::sleep(RECONCILE_EVERY).await;
            }
        });
    }

    /// Handles ChannelSend: answers with one ChannelSendResult on `out`.
    pub fn channel_send(self: &Arc<Self>, r: ChannelSend, out: mpsc::Sender<Body>) {
        let mgr = self.clone();
        tokio::spawn(async move {
            let (ok, message) = match send(&mgr, &r).await {
                Ok(()) => (true, String::new()),
                Err(e) => (false, e),
            };
            tracing::info!(channel = %r.channel, ok, "channel send");
            let result = ChannelSendResult {
                request_id: r.request_id,
                ok,
                message,
            };
            let _ = out.send(Body::ChannelSendResult(result)).await;
        });
    }

    /// The server has stored a ChannelMessage, so the channel's place moves
    /// past it.
    pub fn channel_message_ack(&self, ack: &ChannelMessageAck) {
        self.channels
            .ack(&self.paths, &ack.channel, &ack.message_id);
    }

    /// Hands a message to Sling, unless it's in the outbox already. False when
    /// the outbox is full.
    fn channel_forward(&self, e: &ChannelEntry, p: Pending, group: bool) -> bool {
        let added = self
            .channels
            .forward(&self.paths, &e.name, e.kind, p, group);
        if added {
            self.outbox.notify_one();
        }
        added
    }
}

/// Starts, stops, and restarts workers to match the config. Turning channels
/// off pauses each one, so what arrives meanwhile is never forwarded.
fn reconcile(mgr: &Arc<Manager>) {
    let cfg = mgr.config();
    let wanted: Vec<&ChannelEntry> = if cfg.channels {
        cfg.channel_entries.iter().collect()
    } else {
        Vec::new()
    };
    let mut gone = Vec::new();
    {
        let mut workers = mgr.channels.workers.lock().unwrap();
        workers.retain(|name, w| {
            let keep = wanted
                .iter()
                .any(|e| &e.name == name && e.worker_key() == w.key);
            if !keep {
                gone.push(name.clone());
            }
            keep
        });
    }
    for name in gone {
        match cfg.channel_entries.iter().find(|e| e.name == name) {
            None => mgr.channels.forget(&mgr.paths, &name),
            Some(e) if !cfg.channels => pause(mgr, e),
            Some(_) => {}
        }
    }
    if !cfg.channels {
        for e in &cfg.channel_entries {
            pause(mgr, e);
        }
        return;
    }
    // Channels whose files are left from a removed entry.
    let names: Vec<String> = mgr.channels.live.lock().unwrap().keys().cloned().collect();
    for name in names {
        if !cfg.channel_entries.iter().any(|e| e.name == name) {
            mgr.channels.forget(&mgr.paths, &name);
        }
    }
    let mut workers = mgr.channels.workers.lock().unwrap();
    for e in wanted {
        if !workers.contains_key(&e.name) {
            // What Sling hadn't stored before the Runner stopped goes first.
            let saved = mgr
                .channels
                .with_live(&mgr.paths, &e.name, e.kind, |l| l.outbox.len());
            if saved > 0 {
                mgr.outbox.notify_one();
            }
            let handle = match e.kind {
                Kind::Imessage => {
                    WorkerHandle::Imessage(imessage::start(mgr.clone(), e.name.clone()))
                }
                Kind::Signal => {
                    let (tx, abort) = signal::start(mgr.clone(), e.clone());
                    WorkerHandle::Signal(tx, abort)
                }
            };
            workers.insert(
                e.name.clone(),
                Worker {
                    key: e.worker_key(),
                    handle,
                },
            );
        }
    }
}

/// Marks a channel paused, once, and drops what it hadn't handed over.
fn pause(mgr: &Manager, e: &ChannelEntry) {
    mgr.channels.with_live(&mgr.paths, &e.name, e.kind, |l| {
        if !l.store.paused {
            l.store.paused = true;
            l.outbox.clear();
            l.store.pending.clear();
            l.store.save(&mgr.paths, &e.name);
        }
    });
    clear_health(&e.name);
}

/// The channel's entry in the current config, if it's still there and on.
fn current_entry(mgr: &Manager, name: &str) -> Option<ChannelEntry> {
    let cfg = mgr.config();
    if !cfg.channels {
        return None;
    }
    cfg.channel_entries.into_iter().find(|e| e.name == name)
}

async fn send(mgr: &Arc<Manager>, r: &ChannelSend) -> Result<(), String> {
    let cfg = mgr.config();
    let Some(e) = cfg.channel_entries.iter().find(|e| e.name == r.channel) else {
        return Err(format!("This machine has no channel named {}.", r.channel));
    };
    if !cfg.channels {
        return Err(
            "Channels are off on this machine. Turn them on there with `sling-runner config set channels on`."
                .into(),
        );
    }
    let text = r.text.trim();
    if text.is_empty() {
        return Err("The message is empty.".into());
    }
    if text.len() > MAX_SEND_BYTES {
        return Err(format!(
            "The message is longer than {} KB.",
            MAX_SEND_BYTES / 1024
        ));
    }
    // No one named: the one sender the channel allows, such as you.
    let raw = match (r.conversation.trim(), e.allowed_senders.as_slice()) {
        ("", [only]) => only.as_str(),
        ("", []) => {
            return Err(format!(
                "This channel allows no senders yet, so there's no one to send to. Run `sling-runner channel allow {} <number>` on the machine.",
                e.name
            ));
        }
        ("", _) => {
            return Err(format!(
                "This channel allows {} senders. Say which one to send to.",
                e.allowed_senders.len()
            ));
        }
        (raw, _) => raw,
    };
    if !mgr.channels.may_send(&mgr.paths, e, raw) {
        return Err(format!(
            "This machine sends {} messages only to the senders it allows, and to groups they wrote in. To send to {raw}, run `sling-runner channel allow {} {raw}` on it.",
            e.kind.label(),
            e.name
        ));
    }
    // A person is sent to as the channel writes them; a group by its ID.
    let to = normalize_address(raw).unwrap_or_else(|| raw.to_string());
    match e.kind {
        Kind::Imessage => imessage::send(&e.bin(), &mgr.paths, &to, text).await,
        Kind::Signal => {
            let Some(tx) = mgr.channels.signal_sender(&e.name) else {
                return Err(
                    "Signal isn't running on this machine yet. Try again in a moment.".into(),
                );
            };
            signal::send(&tx, &to, text).await
        }
    }
}

#[cfg(all(test, unix))]
#[path = "channels/tests.rs"]
mod tests;
