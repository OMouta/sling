//! Chat turns: the assistant's replies, run by a coding agent's CLI on this
//! machine's own login. Each turn runs in its own empty directory, which is
//! removed afterwards. The agent gets Sling's tools through
//! `sling-runner mcp` and none of its own. Turns run alongside tasks, outside
//! their limit, at most `MAX_TURNS` at once. Nothing about a turn is kept:
//! when the connection drops, its turns stop.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use sling_runner_protocol::envelope::Body;
use sling_runner_protocol::{ChatDone, ChatEvent, ChatTurn, chat_event};
use tokio::sync::{mpsc, watch};

use crate::config::Paths;
use crate::harness::{self, ChatOutcome, ChatSpec, Harness};
use crate::tasks::Manager;

#[cfg(all(test, unix))]
#[path = "chat_tests.rs"]
mod tests;

pub const MAX_TURNS: usize = 4;
const CANCEL_GRACE: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct Chats {
    running: Mutex<HashMap<String, watch::Sender<bool>>>,
    /// The MCP server agents start. `None` means this executable.
    mcp_command: Mutex<Option<PathBuf>>,
}

impl Chats {
    pub fn running_count(&self) -> usize {
        self.running.lock().unwrap().len()
    }

    #[cfg(test)]
    pub fn set_mcp_command(&self, path: PathBuf) {
        *self.mcp_command.lock().unwrap() = Some(path);
    }

    fn mcp_command(&self) -> Result<PathBuf> {
        match self.mcp_command.lock().unwrap().clone() {
            Some(path) => Ok(path),
            None => std::env::current_exe().context("finding sling-runner for the MCP server"),
        }
    }
}

/// Removes turn directories left behind when the Runner stopped mid-turn.
pub fn clear_leftovers(paths: &Paths) {
    match std::fs::remove_dir_all(paths.chat_dir()) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("could not remove old chat directories: {e}"),
    }
}

/// A turn's directory, readable only by this user, and removed with
/// everything in it when dropped.
struct TurnDir(PathBuf);

impl TurnDir {
    fn create(root: &Path) -> Result<TurnDir> {
        std::fs::create_dir_all(root).with_context(|| format!("creating {}", root.display()))?;
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("no randomness: {e}"))?;
        let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let path = root.join(name);
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .with_context(|| format!("creating {}", path.display()))?;
        Ok(TurnDir(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TurnDir {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_dir_all(&self.0) {
            tracing::warn!("could not remove {}: {e}", self.0.display());
        }
    }
}

/// The prompt for a new session: the conversation so far, if there is any,
/// then the new message.
pub fn new_session_prompt(history: &str, prompt: &str) -> String {
    let history = history.trim();
    if history.is_empty() {
        return prompt.to_string();
    }
    format!(
        "The conversation so far, for context:\n\n<conversation>\n{history}\n</conversation>\n\n{prompt}"
    )
}

fn event(turn_id: &str, kind: chat_event::Kind) -> Body {
    Body::ChatEvent(ChatEvent {
        turn_id: turn_id.to_string(),
        kind: Some(kind),
    })
}

fn done(turn_id: &str, done: ChatDone) -> Body {
    event(turn_id, chat_event::Kind::Done(done))
}

/// `scheme://host[:port]`, lowercased, or None when `url` has no scheme.
fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    Some(format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        host.to_ascii_lowercase()
    ))
}

/// Why this machine won't run a turn, if it won't.
fn refusal(t: &ChatTurn, agent: Option<&dyn Harness>, ready: &[String]) -> Option<String> {
    let Some(agent) = agent else {
        return Some(format!("Unknown coding agent {:?}.", t.harness));
    };
    if !ready.contains(&t.harness) {
        return Some(format!(
            "{} is not installed or not logged in on this machine.",
            agent.label()
        ));
    }
    for (what, value) in [("model", &t.model), ("effort", &t.effort)] {
        if !harness::valid_setting(value) {
            return Some(format!(
                "Refusing {what} {value:?}: use letters, digits, '.', '_', ':' and '-', up to 64 characters."
            ));
        }
    }
    if !(t.tools_url.starts_with("http://") || t.tools_url.starts_with("https://")) {
        return Some(format!(
            "Refusing tools URL {:?}: it must start with http:// or https://.",
            t.tools_url
        ));
    }
    None
}

impl Manager {
    /// Handles ChatTurn. The turn runs in the background, sends its text and
    /// tool calls to `out` as they come, and ends with one ChatDone. A turn
    /// ID that's already running is ignored.
    pub fn chat_turn(self: &Arc<Self>, turn: ChatTurn, ready: &[String], out: mpsc::Sender<Body>) {
        let agent = harness::find(&turn.harness);
        let mut refused = refusal(&turn, agent, ready);
        // The bridge only ever calls the control plane this machine is paired with.
        if refused.is_none()
            && let Some(server) = self.config().server_url
            && origin(&turn.tools_url) != origin(&server)
        {
            refused = Some(format!(
                "Refusing tools URL {:?}: it isn't on {server}, which this machine is paired with.",
                turn.tools_url
            ));
        }
        let (cancel_tx, cancel_rx) = watch::channel(false);
        if refused.is_none() {
            let mut running = self.chats.running.lock().unwrap();
            if running.contains_key(&turn.turn_id) {
                return;
            }
            if running.len() >= MAX_TURNS {
                refused = Some(format!(
                    "This machine is already running {MAX_TURNS} chat turns."
                ));
            } else {
                running.insert(turn.turn_id.clone(), cancel_tx);
            }
        }
        if let Some(error) = refused {
            tracing::info!(turn = turn.turn_id, "chat turn refused: {error}");
            tokio::spawn(async move {
                let _ = out
                    .send(done(
                        &turn.turn_id,
                        ChatDone {
                            error,
                            ..Default::default()
                        },
                    ))
                    .await;
            });
            return;
        }
        let agent = agent.expect("checked above");
        let me = self.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let result = me.run_chat(&turn, agent, cancel_rx, &out).await;
            let finished = result.unwrap_or_else(|e| ChatDone {
                error: format!("{e:#}"),
                ..Default::default()
            });
            tracing::info!(
                turn = turn.turn_id,
                harness = agent.name(),
                secs = started.elapsed().as_secs(),
                error = finished.error,
                "chat turn finished"
            );
            me.chats.running.lock().unwrap().remove(&turn.turn_id);
            let _ = out.send(done(&turn.turn_id, finished)).await;
        });
    }

    /// Handles ChatCancel. The turn still ends with a ChatDone.
    pub fn chat_cancel(&self, turn_id: &str) {
        if let Some(tx) = self.chats.running.lock().unwrap().get(turn_id) {
            let _ = tx.send(true);
        }
    }

    async fn run_chat(
        self: &Arc<Self>,
        t: &ChatTurn,
        agent: &'static dyn Harness,
        mut cancel: watch::Receiver<bool>,
        out: &mpsc::Sender<Body>,
    ) -> Result<ChatDone> {
        let dir = TurnDir::create(&self.paths.chat_dir())?;
        let resume = Some(t.session_id.clone()).filter(|id| {
            let usable = harness::valid_session_id(id);
            if !id.is_empty() && !usable {
                tracing::warn!(turn = t.turn_id, "ignoring session ID {id:?}");
            }
            usable
        });
        let cfg = self.config();
        let mut spec = ChatSpec {
            bin: agent.bin(&cfg),
            dir: dir.path().to_path_buf(),
            prompt: match resume {
                Some(_) => t.prompt.clone(),
                None => new_session_prompt(&t.history, &t.prompt),
            },
            instructions: t.instructions.clone(),
            resume,
            model: harness::setting(&t.model),
            effort: harness::setting(&t.effort),
            fast: t.fast && agent.has_fast_tier(harness::setting(&t.model).as_deref()),
            env: self.agent_env(agent.name()),
            mcp_command: self.chats.mcp_command()?,
            tools_url: t.tools_url.clone(),
            tools_token: t.tools_token.clone(),
            web: t.web,
        };
        let (mut outcome, mut cancelled) = self
            .chat_attempt(agent, &spec, &t.turn_id, &mut cancel, out)
            .await?;
        if outcome.session_missing && spec.resume.is_some() && !cancelled {
            tracing::info!(
                turn = t.turn_id,
                "{} has no session {}; starting a new one",
                agent.label(),
                t.session_id
            );
            spec.resume = None;
            spec.prompt = new_session_prompt(&t.history, &t.prompt);
            (outcome, cancelled) = self
                .chat_attempt(agent, &spec, &t.turn_id, &mut cancel, out)
                .await?;
        }
        let error = if cancelled {
            "Cancelled.".to_string()
        } else {
            outcome.failure.unwrap_or_default()
        };
        Ok(ChatDone {
            text: outcome.text,
            session_id: outcome.session_id,
            error,
            input_tokens: outcome.input_tokens,
            output_tokens: outcome.output_tokens,
        })
    }

    /// Runs the agent once, sending its text and tool calls to `out`, until
    /// it exits, the turn is cancelled, or the connection goes away. Returns
    /// how it ended and whether it was cut short.
    async fn chat_attempt(
        &self,
        agent: &'static dyn Harness,
        spec: &ChatSpec,
        turn_id: &str,
        cancel: &mut watch::Receiver<bool>,
        out: &mpsc::Sender<Body>,
    ) -> Result<(ChatOutcome, bool)> {
        if *cancel.borrow() || out.is_closed() {
            return Ok((ChatOutcome::default(), true));
        }
        let (tx, mut rx) = mpsc::channel(256);
        let mut run = agent.start_chat(spec, tx).await?;
        let mut cancelled = false;
        loop {
            tokio::select! {
                ev = rx.recv() => match ev {
                    Some(kind) => {
                        let _ = out.send(event(turn_id, kind)).await;
                    }
                    None => break,
                },
                changed = cancel.changed(), if !cancelled => {
                    if changed.is_err() || *cancel.borrow() {
                        cancelled = true;
                        run.cancel(CANCEL_GRACE).await;
                    }
                }
                _ = out.closed(), if !cancelled => {
                    cancelled = true;
                    run.cancel(CANCEL_GRACE).await;
                }
            }
        }
        Ok((run.finish().await?, cancelled))
    }
}

#[cfg(test)]
mod origin_tests {
    use super::origin;

    #[test]
    fn compares_scheme_host_and_port() {
        assert_eq!(
            origin("http://LocalHost:5173/api/agent/tools"),
            origin("http://localhost:5173")
        );
        assert_ne!(
            origin("http://localhost:5173/x"),
            origin("http://localhost:8080")
        );
        assert_ne!(
            origin("https://sling.example.com/a"),
            origin("http://sling.example.com")
        );
        assert_eq!(origin("not a url"), None);
    }
}
