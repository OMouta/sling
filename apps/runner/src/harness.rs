//! Coding agents the Runner can run. Each one is a `Harness`: how to detect
//! it, how to start it for a task, and how to read its output. Everything
//! else about a task (worktrees, commits, spools, cancel, and actions) is
//! shared and lives in `tasks`.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use anyhow::Result;
use sling_harness_claude_code as claude;
use sling_harness_codex as codex;
use sling_runner_protocol::task_event::Kind;
use tokio::sync::mpsc;

use crate::config::{Config, Mode};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Default)]
pub struct Detected {
    pub version: String,
    /// Installed and logged in.
    pub ready: bool,
    pub detail: String,
}

/// What a task asks the agent to do, and where.
pub struct RunSpec {
    pub bin: String,
    pub cwd: PathBuf,
    pub title: String,
    pub objective: String,
    pub mode: Mode,
    /// The repo allows network inside the agent's sandbox.
    pub network: bool,
    /// The Runner lives in a disposable sandbox, which is the isolation
    /// boundary, so the agent runs without its own.
    pub disposable: bool,
    pub env: Vec<(String, String)>,
}

pub enum HarnessEvent {
    /// Something to record in the task's event stream.
    Task(Kind),
    /// A line for the task log, such as the agent's session ID.
    Note(String),
}

pub struct Outcome {
    pub exit_code: Option<i32>,
    pub summary: String,
    /// Set when the agent reported a failure the task should end with.
    pub failure: Option<String>,
}

pub trait Harness: Send + Sync {
    /// Name in `TaskAssign.harness`, for example `codex`.
    fn name(&self) -> &'static str;
    /// Product name for messages, for example `Codex`.
    fn label(&self) -> &'static str;
    /// Inventory capability, for example `coding.codex`.
    fn capability(&self) -> &'static str;
    /// Text a process's command line contains when it's this agent. Used to
    /// check a leftover process group before killing it.
    fn process_marker(&self) -> &'static str;
    /// The binary to run, from the config.
    fn bin(&self, cfg: &Config) -> String;
    fn detect<'a>(&'a self, bin: &'a str) -> BoxFuture<'a, Detected>;
    /// Starts the agent. Events arrive on `tx` until its output closes.
    fn start<'a>(
        &'a self,
        spec: &'a RunSpec,
        tx: mpsc::Sender<HarnessEvent>,
    ) -> BoxFuture<'a, Result<Box<dyn HarnessRun>>>;
}

impl std::fmt::Debug for dyn Harness {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

/// A running agent process.
pub trait HarnessRun: Send {
    /// Process ID, which is also its process group on Unix.
    fn pid(&self) -> Option<u32>;
    /// Interrupts it, then kills it if it's still running after `grace`.
    fn cancel(&mut self, grace: Duration) -> BoxFuture<'_, ()>;
    /// Waits for it to exit and for its output to be read.
    fn finish(self: Box<Self>) -> BoxFuture<'static, Result<Outcome>>;
}

pub static CODEX: Codex = Codex;
pub static CLAUDE_CODE: ClaudeCode = ClaudeCode;

/// Every harness the Runner knows, in the order the inventory lists them.
pub fn all() -> [&'static dyn Harness; 2] {
    [&CODEX, &CLAUDE_CODE]
}

pub fn find(name: &str) -> Option<&'static dyn Harness> {
    all().into_iter().find(|h| h.name() == name)
}

/// Forwards a crate's events to the Runner's channel, converted.
fn forward<E: Send + 'static>(
    tx: mpsc::Sender<HarnessEvent>,
    convert: fn(E) -> HarnessEvent,
) -> mpsc::Sender<E> {
    let (inner_tx, mut inner_rx) = mpsc::channel::<E>(256);
    tokio::spawn(async move {
        while let Some(ev) = inner_rx.recv().await {
            if tx.send(convert(ev)).await.is_err() {
                break;
            }
        }
    });
    inner_tx
}

pub struct Codex;

impl Codex {
    /// Codex sandbox for a mode. In a disposable sandbox Codex's own sandbox
    /// can't start, so every mode runs without it. Read-only tasks still
    /// never commit or push there, because the Runner refuses both.
    pub fn sandbox(mode: Mode, disposable: bool) -> &'static str {
        match mode {
            _ if disposable => "danger-full-access",
            Mode::ReadOnly => "read-only",
            Mode::Supervised | Mode::Auto => "workspace-write",
            Mode::FullAccess => "danger-full-access",
        }
    }
}

impl Harness for Codex {
    fn name(&self) -> &'static str {
        "codex"
    }
    fn label(&self) -> &'static str {
        "Codex"
    }
    fn capability(&self) -> &'static str {
        "coding.codex"
    }
    fn process_marker(&self) -> &'static str {
        "codex"
    }
    fn bin(&self, cfg: &Config) -> String {
        cfg.codex_bin()
    }

    fn detect<'a>(&'a self, bin: &'a str) -> BoxFuture<'a, Detected> {
        Box::pin(async move {
            let d = codex::detect(bin).await;
            Detected {
                ready: d.ready(),
                version: d.version,
                detail: d.detail,
            }
        })
    }

    fn start<'a>(
        &'a self,
        spec: &'a RunSpec,
        tx: mpsc::Sender<HarnessEvent>,
    ) -> BoxFuture<'a, Result<Box<dyn HarnessRun>>> {
        Box::pin(async move {
            let opts = codex::RunOptions {
                bin: spec.bin.clone(),
                cwd: spec.cwd.clone(),
                prompt: codex::build_prompt(&spec.title, &spec.objective, spec.mode.writes()),
                sandbox: Codex::sandbox(spec.mode, spec.disposable).into(),
                network: spec.network,
                env: Some(spec.env.clone()),
            };
            let tx = forward(tx, |ev| match ev {
                codex::Event::Task(kind) => HarnessEvent::Task(kind),
                codex::Event::ThreadStarted(id) => {
                    HarnessEvent::Note(format!("Codex session {id}"))
                }
            });
            let (run, reader) = codex::Run::start(&opts, tx).await?;
            Ok(Box::new(CodexRun { run, reader }) as Box<dyn HarnessRun>)
        })
    }
}

struct CodexRun {
    run: codex::Run,
    reader: codex::Reader,
}

impl HarnessRun for CodexRun {
    fn pid(&self) -> Option<u32> {
        self.run.pid()
    }

    fn cancel(&mut self, grace: Duration) -> BoxFuture<'_, ()> {
        Box::pin(self.run.cancel(grace))
    }

    fn finish(self: Box<Self>) -> BoxFuture<'static, Result<Outcome>> {
        Box::pin(async move {
            let CodexRun { mut run, reader } = *self;
            let exit = run.wait().await?;
            let o = reader.finish(exit).await;
            Ok(Outcome {
                exit_code: exit,
                summary: o.summary,
                // Codex can report an error and still finish the turn; only a
                // failed exit counts.
                failure: o.failure.filter(|_| exit != Some(0)),
            })
        })
    }
}

pub struct ClaudeCode;

impl ClaudeCode {
    /// Claude Code access for a mode. In a disposable sandbox Claude Code's
    /// own sandbox can't start, so Supervised and Auto skip permissions
    /// there. Read-only stays in plan mode, which doesn't need it.
    pub fn access(mode: Mode, disposable: bool) -> claude::Access {
        match mode {
            Mode::ReadOnly => claude::Access::ReadOnly,
            _ if disposable => claude::Access::Full,
            Mode::Supervised | Mode::Auto => claude::Access::Edit,
            Mode::FullAccess => claude::Access::Full,
        }
    }
}

impl Harness for ClaudeCode {
    fn name(&self) -> &'static str {
        "claude-code"
    }
    fn label(&self) -> &'static str {
        "Claude Code"
    }
    fn capability(&self) -> &'static str {
        "coding.claude-code"
    }
    fn process_marker(&self) -> &'static str {
        "claude"
    }
    fn bin(&self, cfg: &Config) -> String {
        cfg.claude_bin()
    }

    fn detect<'a>(&'a self, bin: &'a str) -> BoxFuture<'a, Detected> {
        Box::pin(async move {
            let d = claude::detect(bin).await;
            Detected {
                ready: d.ready(),
                version: d.version,
                detail: d.detail,
            }
        })
    }

    fn start<'a>(
        &'a self,
        spec: &'a RunSpec,
        tx: mpsc::Sender<HarnessEvent>,
    ) -> BoxFuture<'a, Result<Box<dyn HarnessRun>>> {
        Box::pin(async move {
            let opts = claude::RunOptions {
                bin: spec.bin.clone(),
                cwd: spec.cwd.clone(),
                prompt: claude::build_prompt(&spec.title, &spec.objective, spec.mode.writes()),
                access: ClaudeCode::access(spec.mode, spec.disposable),
                network: spec.network,
                env: Some(spec.env.clone()),
            };
            let tx = forward(tx, |ev| match ev {
                claude::Event::Task(kind) => HarnessEvent::Task(kind),
                claude::Event::SessionStarted { session_id, model } => {
                    HarnessEvent::Note(format!("Claude Code session {session_id} ({model})"))
                }
            });
            let (run, reader) = claude::Run::start(&opts, tx).await?;
            Ok(Box::new(ClaudeRun { run, reader }) as Box<dyn HarnessRun>)
        })
    }
}

struct ClaudeRun {
    run: claude::Run,
    reader: claude::Reader,
}

impl HarnessRun for ClaudeRun {
    fn pid(&self) -> Option<u32> {
        self.run.pid()
    }

    fn cancel(&mut self, grace: Duration) -> BoxFuture<'_, ()> {
        Box::pin(self.run.cancel(grace))
    }

    fn finish(self: Box<Self>) -> BoxFuture<'static, Result<Outcome>> {
        Box::pin(async move {
            let ClaudeRun { mut run, reader } = *self;
            let exit = run.wait().await?;
            let o = reader.finish(exit).await;
            Ok(Outcome {
                exit_code: exit,
                summary: o.summary,
                // An error result is a failure even when Claude Code exits 0.
                failure: o.failure,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_harnesses_by_name() {
        assert_eq!(find("codex").unwrap().label(), "Codex");
        assert_eq!(
            find("claude-code").unwrap().capability(),
            "coding.claude-code"
        );
        assert!(find("opencode").is_none());
    }

    #[test]
    fn modes_map_to_each_agent() {
        use claude::Access;
        assert_eq!(Codex::sandbox(Mode::ReadOnly, false), "read-only");
        assert_eq!(Codex::sandbox(Mode::Supervised, false), "workspace-write");
        assert_eq!(Codex::sandbox(Mode::Auto, false), "workspace-write");
        assert_eq!(
            Codex::sandbox(Mode::FullAccess, false),
            "danger-full-access"
        );
        assert_eq!(ClaudeCode::access(Mode::ReadOnly, false), Access::ReadOnly);
        assert_eq!(ClaudeCode::access(Mode::Supervised, false), Access::Edit);
        assert_eq!(ClaudeCode::access(Mode::Auto, false), Access::Edit);
        assert_eq!(ClaudeCode::access(Mode::FullAccess, false), Access::Full);
    }

    #[test]
    fn a_disposable_sandbox_drops_the_agents_own_sandbox() {
        use claude::Access;
        for mode in [Mode::ReadOnly, Mode::Supervised, Mode::Auto] {
            assert_eq!(Codex::sandbox(mode, true), "danger-full-access");
        }
        assert_eq!(ClaudeCode::access(Mode::ReadOnly, true), Access::ReadOnly);
        assert_eq!(ClaudeCode::access(Mode::Supervised, true), Access::Full);
        assert_eq!(ClaudeCode::access(Mode::Auto, true), Access::Full);
    }
}
