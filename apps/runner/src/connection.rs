//! The Runner's outbound WebSocket to the control plane: signed handshake,
//! heartbeats, inventory updates, the outbox of task events and merge and
//! deploy results, and chat turns.
//! Reconnects forever with backoff, except when the server says this Runner
//! is revoked or unknown. Chat turns and the assistant's commands belong to
//! one connection and stop when it drops.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use sling_runner_protocol::{
    Envelope, Heartbeat, Hello, Inventory, RUNNER_WS_PATH, auth_payload, envelope::Body,
    error::Code,
};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::config::Config;
use crate::identity::Identity;
use crate::inventory;
use crate::sys::{hostname, now_ms, os};
use crate::tasks::Manager;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const INVENTORY_REFRESH: Duration = Duration::from_secs(60);
/// A reconnect reuses a repo scan younger than this.
const SCAN_REUSE: Duration = Duration::from_secs(60);
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn ws_url(server: &str) -> Result<String> {
    let base = server.trim_end_matches('/');
    let url = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        bail!("server URL must start with http:// or https://, got {server}");
    };
    Ok(format!("{url}{RUNNER_WS_PATH}"))
}

/// The server refused this Runner for good (revoked or unknown).
#[derive(Debug)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refused {}

enum Ended {
    /// Try again after a pause.
    Retry(String),
    /// Stop: the server will never accept this Runner.
    Fatal(String),
}

pub async fn run_forever(mgr: Arc<Manager>, identity: Identity) -> Result<()> {
    let mut backoff = Duration::from_secs(1);
    loop {
        let cfg = mgr.config();
        let started = Instant::now();
        match connect_once(&mgr, &identity, &cfg).await {
            Ok(Ended::Fatal(msg)) => return Err(Refused(msg).into()),
            Ok(Ended::Retry(msg)) => tracing::warn!("disconnected: {msg}"),
            Err(e) => tracing::warn!("connection failed: {e:#}"),
        }
        if started.elapsed() > Duration::from_secs(30) {
            backoff = Duration::from_secs(1);
        }
        let jitter = Duration::from_millis(now_ms().unsigned_abs() % 500);
        tokio::time::sleep(backoff + jitter).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn connect_once(mgr: &Arc<Manager>, identity: &Identity, cfg: &Config) -> Result<Ended> {
    let server = cfg
        .server_url
        .as_deref()
        .context("not paired: run `sling-runner pair <url> <code>`")?;
    let runner_id = cfg.runner_id.as_deref().context("not paired")?;
    let url = ws_url(server)?;
    // Connect first and scan after. Walking a big home folder and asking git
    // about every repo in it can take many seconds, and nothing else the
    // machine does should wait on that. The scan follows as its own inventory.
    let rescan = !mgr.scan_is_fresh(SCAN_REUSE);
    tracing::info!("connecting to {url}");
    let (ws, _) = tokio::time::timeout(HANDSHAKE_TIMEOUT, tokio_tungstenite::connect_async(&url))
        .await
        .context("timed out connecting")??;
    let (mut sink, mut stream) = ws.split();

    // 1. Challenge
    let nonce = match read_envelope(&mut stream).await? {
        Some(Body::Challenge(c)) => c.nonce,
        Some(Body::Error(e)) => return Ok(Ended::Retry(e.message)),
        other => bail!("expected challenge, got {other:?}"),
    };

    // 2. Hello
    let mut inv = inventory::build(cfg, &mgr.found(), &mgr.command_sandbox().await).await;
    let ts = now_ms();
    let hello = Hello {
        runner_id: runner_id.to_string(),
        timestamp_ms: ts,
        signature: identity.sign(&auth_payload(&nonce, runner_id, ts)),
        runner_version: VERSION.into(),
        os: os().into(),
        arch: std::env::consts::ARCH.into(),
        hostname: hostname(),
        inventory: Some(inv.clone()),
        held_tasks: mgr.held_tasks(),
    };
    send(&mut sink, Body::Hello(hello)).await?;

    // 3. Welcome
    let welcome = match read_envelope(&mut stream).await? {
        Some(Body::Welcome(w)) => w,
        Some(Body::Error(e)) => {
            let fatal = matches!(e.code(), Code::Revoked | Code::UnknownRunner);
            return Ok(if fatal {
                Ended::Fatal(format!(
                    "the server refused this Runner: {}. Pair it again.",
                    e.message
                ))
            } else {
                Ended::Retry(e.message)
            });
        }
        other => bail!("expected welcome, got {other:?}"),
    };
    tracing::info!("connected as {runner_id}");
    mgr.forget(&welcome.forget_task_ids);
    mgr.reset_sent();

    let hb_secs = welcome.heartbeat_interval_seconds.clamp(5, 60) as u64;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(hb_secs));
    let mut refresh = tokio::time::interval(INVENTORY_REFRESH);
    refresh.tick().await;
    let mut last_ack = Instant::now();
    let mut ready = inventory::ready_harnesses(&inv);
    // Replies from work spawned off the read loop, such as repo changes.
    let (reply_tx, mut reply_rx) = mpsc::channel::<Body>(16);
    // Chat events. Turns stop when this connection ends and drops the
    // receiver.
    let (chat_tx, mut chat_rx) = mpsc::channel::<Body>(256);

    flush(mgr, &mut sink).await?;
    if rescan {
        let mgr = mgr.clone();
        let reply = reply_tx.clone();
        tokio::spawn(async move { mgr.rescan_and_report(&reply).await });
    }

    loop {
        tokio::select! {
            msg = stream.next() => {
                let Some(msg) = msg else { return Ok(Ended::Retry("server closed the connection".into())) };
                match msg? {
                    Message::Binary(bytes) => {
                        let env = Envelope::decode(bytes.as_ref()).context("bad frame from server")?;
                        match env.body {
                            Some(Body::HeartbeatAck(_)) => last_ack = Instant::now(),
                            Some(Body::TaskAssign(a)) => {
                                let mgr = mgr.clone();
                                let ready = ready.clone();
                                tokio::spawn(async move { mgr.assign(a, &ready).await });
                            }
                            Some(Body::TaskCancel(c)) => mgr.cancel(&c.task_id),
                            Some(Body::ActionRequest(r)) => {
                                let mgr = mgr.clone();
                                tokio::spawn(async move { mgr.action(r).await });
                            }
                            Some(Body::EventAck(a)) => mgr.ack(&a.task_id, a.seq),
                            Some(Body::RepoChange(c)) => {
                                let mgr = mgr.clone();
                                let reply = reply_tx.clone();
                                tokio::spawn(async move { mgr.repo_change_and_report(c, &reply).await });
                            }
                            Some(Body::RepoScan(_)) => {
                                let mgr = mgr.clone();
                                let reply = reply_tx.clone();
                                tokio::spawn(async move { mgr.rescan_and_report(&reply).await });
                            }
                            Some(Body::ChatTurn(t)) => mgr.chat_turn(t, &ready, chat_tx.clone()),
                            Some(Body::ChatCancel(c)) => mgr.chat_cancel(&c.turn_id),
                            Some(Body::ExecRequest(r)) => mgr.exec(r, chat_tx.clone()),
                            Some(Body::RepoAction(a)) => mgr.repo_action(a),
                            Some(Body::RepoActionAck(a)) => mgr.repo_action_ack(&a.request_id),
                            Some(Body::FileSearch(r)) => mgr.file_search(r, reply_tx.clone()),
                            Some(Body::FileRead(r)) => mgr.file_read(r, reply_tx.clone()),
                            Some(Body::ChannelSend(r)) => mgr.channel_send(r, reply_tx.clone()),
                            Some(Body::ChannelMessageAck(a)) => mgr.channel_message_ack(&a),
                            Some(Body::Error(e)) => {
                                let fatal = matches!(e.code(), Code::Revoked | Code::UnknownRunner);
                                if fatal {
                                    return Ok(Ended::Fatal(format!("the server revoked this Runner: {}", e.message)));
                                }
                                return Ok(Ended::Retry(e.message));
                            }
                            _ => {}
                        }
                    }
                    Message::Close(frame) => {
                        return Ok(Ended::Retry(frame.map(|f| f.reason.to_string()).unwrap_or_default()));
                    }
                    _ => {}
                }
            }
            _ = heartbeat.tick() => {
                if last_ack.elapsed() > Duration::from_secs(hb_secs * 3) {
                    return Ok(Ended::Retry("no heartbeat reply from the server".into()));
                }
                send(&mut sink, Body::Heartbeat(Heartbeat { running_tasks: mgr.running_count() as u32 })).await?;
            }
            _ = crate::channels::refresh_due(&mut refresh) => {
                if let Some(next) = refresh_inventory(mgr, &inv).await {
                    ready = inventory::ready_harnesses(&next);
                    send(&mut sink, Body::Inventory(next.clone())).await?;
                    inv = next;
                }
            }
            _ = mgr.outbox.notified() => flush(mgr, &mut sink).await?,
            Some(body) = chat_rx.recv() => send(&mut sink, body).await?,
            Some(body) = reply_rx.recv() => {
                if let Body::Inventory(next) = &body {
                    ready = inventory::ready_harnesses(next);
                    inv = next.clone();
                }
                send(&mut sink, body).await?;
            }
        }
    }
}

fn reload_config(mgr: &Manager) {
    match Config::load(&mgr.paths) {
        Ok(cfg) => mgr.set_config(cfg),
        Err(e) => tracing::warn!("could not reload config: {e:#}"),
    }
}

/// Re-reads runner.toml and rebuilds the inventory. Returns it if it changed.
/// Scans for repos only when there's no scan yet, as after `remote-repos` is
/// turned on, and never while another scan runs; otherwise the latest scan
/// stands until the next connect or RepoScan.
async fn refresh_inventory(mgr: &Arc<Manager>, current: &Inventory) -> Option<Inventory> {
    reload_config(mgr);
    mgr.rescan_if_unscanned_nowait().await;
    let next = inventory::build(&mgr.config(), &mgr.found(), &mgr.command_sandbox().await).await;
    (next != *current).then_some(next)
}

type Sink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;
type Stream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

async fn flush(mgr: &Arc<Manager>, sink: &mut Sink) -> Result<()> {
    for event in mgr.unsent() {
        send(sink, Body::TaskEvent(event)).await?;
    }
    for body in mgr.repo_actions.unsent() {
        send(sink, body).await?;
    }
    for body in mgr.channels.unsent() {
        send(sink, body).await?;
    }
    Ok(())
}

async fn send(sink: &mut Sink, body: Body) -> Result<()> {
    let bytes = Envelope { body: Some(body) }.encode_to_vec();
    sink.send(Message::Binary(bytes.into())).await?;
    Ok(())
}

async fn read_envelope(stream: &mut Stream) -> Result<Option<Body>> {
    loop {
        let msg = tokio::time::timeout(HANDSHAKE_TIMEOUT, stream.next())
            .await
            .context("timed out waiting for the server")?
            .ok_or_else(|| anyhow!("connection closed during handshake"))??;
        match msg {
            Message::Binary(bytes) => return Ok(Envelope::decode(bytes.as_ref())?.body),
            Message::Close(f) => {
                bail!(
                    "server closed the connection: {}",
                    f.map(|f| f.reason.to_string()).unwrap_or_default()
                )
            }
            _ => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_ws_urls() {
        assert_eq!(
            ws_url("https://sling.example.com/").unwrap(),
            "wss://sling.example.com/runner/v1/ws"
        );
        assert_eq!(
            ws_url("http://localhost:8080").unwrap(),
            "ws://localhost:8080/runner/v1/ws"
        );
        assert!(ws_url("sling.example.com").is_err());
    }
}
