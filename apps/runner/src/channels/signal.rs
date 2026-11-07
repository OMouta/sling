//! Signal through signal-cli, linked as a device of the account. The Runner
//! runs `signal-cli -a <account> jsonRpc` as a child process, reads its
//! `receive` notifications, and sends with its `send` method. If it stops,
//! it's started again, waiting longer each time it fails quickly.
//!
//! signal-cli takes a message off Signal's servers as soon as it reads it,
//! so the Runner saves each one until Sling has stored it.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

use super::{ChannelEntry, Kind, Pending, current_entry, normalize_address, set_health};
use crate::tasks::Manager;

pub const NOT_INSTALLED: &str = "signal-cli isn't installed. Install it with `brew install signal-cli`, or from github.com/AsamK/signal-cli.";
const SEND_TIMEOUT: Duration = Duration::from_secs(30);
const FIRST_BACKOFF: Duration = if cfg!(test) {
    Duration::from_millis(200)
} else {
    Duration::from_secs(1)
};
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// signal-cli counts as running once it has stayed up this long, so one
/// that exits at start never shows as ready.
const READY_AFTER: Duration = if cfg!(test) {
    Duration::from_millis(300)
} else {
    Duration::from_secs(3)
};
/// A run longer than this resets the wait before the next start.
const HEALTHY_RUN: Duration = Duration::from_secs(60);
/// The end of signal-cli's errors kept to say why it stopped.
const STDERR_TAIL: usize = 2048;

pub struct Request {
    to: String,
    text: String,
    reply: oneshot::Sender<Result<(), String>>,
}

/// Starts signal-cli for the channel and keeps it running. Dropping the
/// sender, or aborting, stops it.
pub fn start(
    mgr: Arc<Manager>,
    entry: ChannelEntry,
) -> (mpsc::Sender<Request>, tokio::task::AbortHandle) {
    let (tx, rx) = mpsc::channel(16);
    let task = tokio::spawn(supervise(mgr, entry, rx));
    (tx, task.abort_handle())
}

/// Sends through the running signal-cli and waits for its answer.
pub async fn send(tx: &mpsc::Sender<Request>, to: &str, text: &str) -> Result<(), String> {
    let (reply, answer) = oneshot::channel();
    tx.send(Request {
        to: to.to_string(),
        text: text.to_string(),
        reply,
    })
    .await
    .map_err(|_| "Signal stopped on this machine.".to_string())?;
    match tokio::time::timeout(SEND_TIMEOUT, answer).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("signal-cli stopped before it answered.".into()),
        Err(_) => Err("signal-cli didn't answer within 30 seconds.".into()),
    }
}

async fn supervise(mgr: Arc<Manager>, entry: ChannelEntry, mut rx: mpsc::Receiver<Request>) {
    let mut backoff = FIRST_BACKOFF;
    loop {
        let started = Instant::now();
        let why = match run_once(&mgr, &entry, &mut rx).await {
            Some(why) => why,
            None => return,
        };
        tracing::warn!(channel = %entry.name, "signal-cli stopped: {why}");
        set_health(&entry.name, false, why.clone());
        if started.elapsed() > HEALTHY_RUN {
            backoff = FIRST_BACKOFF;
        }
        // Sends while it's down fail at once rather than wait.
        let until = tokio::time::Instant::now() + backoff;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(until) => break,
                req = rx.recv() => match req {
                    Some(r) => { let _ = r.reply.send(Err(format!("Signal isn't running on this machine: {why}"))); }
                    None => return,
                },
            }
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

/// Runs signal-cli until it exits, and says why. None when the channel was
/// stopped.
async fn run_once(
    mgr: &Arc<Manager>,
    entry: &ChannelEntry,
    rx: &mut mpsc::Receiver<Request>,
) -> Option<String> {
    let account = entry.account.clone().unwrap_or_default();
    let bin = entry.bin();
    let mut child = match Command::new(&bin)
        .args(["-a", &account, "jsonRpc"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(NOT_INSTALLED.into()),
        Err(e) => return Some(format!("couldn't start {bin}: {e}")),
    };
    let (Some(mut stdin), Some(stdout), Some(mut stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Some("signal-cli started without its pipes".into());
    };
    let tail = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        while let Ok(n) = stderr.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() > STDERR_TAIL {
                buf.drain(..buf.len() - STDERR_TAIL);
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    });
    let mut lines = BufReader::new(stdout).lines();
    let up = tokio::time::sleep(READY_AFTER);
    tokio::pin!(up);
    let mut ready = false;
    let mut waiting: HashMap<u64, oneshot::Sender<Result<(), String>>> = HashMap::new();
    let mut next_id: u64 = 1;
    loop {
        tokio::select! {
            _ = &mut up, if !ready => {
                ready = true;
                set_health(&entry.name, true, "");
            }
            line = lines.next_line() => match line {
                Ok(Some(line)) => on_line(mgr, entry, &line, &mut waiting),
                Ok(None) | Err(_) => break,
            },
            req = rx.recv() => {
                let req = req?;
                let id = next_id;
                next_id += 1;
                match write_send(&mut stdin, id, &req.to, &req.text).await {
                    Ok(()) => { waiting.insert(id, req.reply); }
                    Err(e) => { let _ = req.reply.send(Err(format!("couldn't reach signal-cli: {e}"))); }
                }
            }
        }
    }
    for (_, reply) in waiting.drain() {
        let _ = reply.send(Err("signal-cli stopped before it answered.".into()));
    }
    let status = child.wait().await.ok();
    let stderr = tail.await.unwrap_or_default();
    Some(why_stopped(&stderr, status.and_then(|s| s.code())))
}

fn why_stopped(stderr: &str, code: Option<i32>) -> String {
    let last = stderr.lines().map(str::trim).rfind(|l| !l.is_empty());
    match last {
        Some(l) if l.contains("not registered") || l.contains("not linked") => format!(
            "signal-cli isn't linked to this account. Run `signal-cli link -n Sling` and scan the code in Signal on your phone. ({l})"
        ),
        Some(l) => l.chars().take(240).collect(),
        None => match code {
            Some(c) => format!("signal-cli exited with code {c}"),
            None => "signal-cli was stopped".into(),
        },
    }
}

async fn write_send(stdin: &mut ChildStdin, id: u64, to: &str, text: &str) -> std::io::Result<()> {
    let mut params = json!({ "message": text });
    // A person by number or account ID; anything else is a group's ID.
    if normalize_address(to).is_some() {
        params["recipient"] = json!([to]);
    } else {
        params["groupId"] = json!(to);
    }
    let req = json!({ "jsonrpc": "2.0", "id": id, "method": "send", "params": params });
    let mut line = serde_json::to_vec(&req)?;
    line.push(b'\n');
    stdin.write_all(&line).await?;
    stdin.flush().await
}

fn on_line(
    mgr: &Manager,
    entry: &ChannelEntry,
    line: &str,
    waiting: &mut HashMap<u64, oneshot::Sender<Result<(), String>>>,
) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if let Some(id) = v.get("id").and_then(response_id) {
        if let Some(reply) = waiting.remove(&id) {
            let _ = reply.send(send_outcome(&v));
        }
        return;
    }
    if v.get("method").and_then(Value::as_str) != Some("receive") {
        return;
    }
    // The newest config, so senders allowed since the start count.
    let Some(e) = current_entry(mgr, &entry.name).filter(|e| e.kind == Kind::Signal) else {
        return;
    };
    let skip_before = mgr
        .channels
        .with_live(&mgr.paths, &e.name, Kind::Signal, |l| {
            l.store.skip_before_ms
        });
    if let Some(params) = v.get("params")
        && let Some((p, group)) = incoming(&e, params, skip_before)
    {
        mgr.channel_forward(&e, p, group);
    }
}

fn response_id(id: &Value) -> Option<u64> {
    id.as_u64()
        .or_else(|| id.as_str().and_then(|s| s.parse().ok()))
}

/// What a `send` answer means: an error, or a result whose recipients each
/// say SUCCESS.
fn send_outcome(v: &Value) -> Result<(), String> {
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("signal-cli refused it");
        return Err(format!("Signal refused it: {msg}"));
    }
    let failed: Vec<String> = v
        .pointer("/result/results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let kind = r.get("type").and_then(Value::as_str).unwrap_or("SUCCESS");
            (kind != "SUCCESS").then(|| kind.to_lowercase().replace('_', " "))
        })
        .collect();
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!("Signal couldn't deliver it: {}", failed.join(", ")))
    }
}

/// The message in a `receive` notification, and whether it's from a group,
/// when it's one to forward: someone else's words, from an allowed sender,
/// sent after the channel's start.
pub fn incoming(e: &ChannelEntry, params: &Value, skip_before_ms: i64) -> Option<(Pending, bool)> {
    let env = params.get("envelope")?;
    let data = env.get("dataMessage")?;
    let text = data.get("message")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let at_ms = env
        .get("timestamp")
        .or_else(|| data.get("timestamp"))
        .and_then(Value::as_i64)?;
    if at_ms < skip_before_ms {
        return None;
    }
    let str_of = |k: &str| {
        env.get(k)
            .and_then(Value::as_str)
            .and_then(normalize_address)
    };
    let number = str_of("sourceNumber").or_else(|| str_of("source").filter(|s| s.starts_with('+')));
    let uuid = str_of("sourceUuid");
    let account = e.account.as_deref().and_then(normalize_address);
    if number.is_some() && number == account {
        return None;
    }
    let allowed = |a: &Option<String>| a.as_ref().is_some_and(|a| e.allowed_senders.contains(a));
    if !allowed(&number) && !allowed(&uuid) {
        return None;
    }
    let sender = number.or(uuid)?;
    let group = data
        .pointer("/groupInfo/groupId")
        .and_then(Value::as_str)
        .filter(|g| !g.is_empty());
    let conversation = group.map_or_else(|| sender.clone(), str::to_string);
    Some((
        Pending {
            message_id: format!("{at_ms}-{sender}"),
            conversation,
            sender,
            text: text.to_string(),
            at_ms,
        },
        group.is_some(),
    ))
}

/// Whether signal-cli on this machine knows the account, from its own list.
pub async fn linked(bin: &str, account: &str) -> Result<bool, String> {
    let out = crate::sys::run_timeout(
        bin,
        &["-o", "json", "listAccounts"],
        None,
        Duration::from_secs(60),
    )
    .await
    .map_err(|e| {
        if crate::channels::find_program(bin).is_none() {
            NOT_INSTALLED.to_string()
        } else {
            format!("{e:#}")
        }
    })?;
    if !out.ok() {
        let line = out
            .stderr
            .lines()
            .next_back()
            .unwrap_or("")
            .trim()
            .to_string();
        return Err(format!("signal-cli failed: {line}"));
    }
    let numbers: Vec<String> = match serde_json::from_str::<Value>(&out.stdout) {
        Ok(Value::Array(list)) => list
            .iter()
            .filter_map(|a| a.get("number").and_then(Value::as_str).map(str::to_string))
            .collect(),
        // Older versions print "Number: +351…" lines.
        _ => out
            .stdout
            .lines()
            .filter_map(|l| l.split_whitespace().find(|w| w.starts_with('+')))
            .map(str::to_string)
            .collect(),
    };
    Ok(numbers
        .iter()
        .any(|n| normalize_address(n).as_deref() == Some(account)))
}
