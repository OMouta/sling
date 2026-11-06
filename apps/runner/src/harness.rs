//! Coding agents the Runner can run. Each one is a `Harness`: how to detect
//! it, how to start it for a task or a chat turn, and how to read its
//! output. Everything else about a task (worktrees, commits, spools, cancel,
//! and actions) is shared and lives in `tasks`, and the rest of a chat turn
//! lives in `chat`.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use anyhow::Result;
use sling_harness_claude_code as claude;
use sling_harness_codex as codex;
use sling_runner_protocol::AgentModel;
use sling_runner_protocol::chat_event;
use sling_runner_protocol::task_event::Kind;
use tokio::sync::mpsc;

use crate::config::{Config, Mode};
use crate::mcp;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Default)]
pub struct Detected {
    pub version: String,
    /// Installed and logged in.
    pub ready: bool,
    pub detail: String,
    /// Models the agent can run, for the inventory.
    pub models: Vec<AgentModel>,
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
    /// Model for the agent. `None` uses its own default.
    pub model: Option<String>,
    /// Reasoning effort. `None` uses the model's default.
    pub effort: Option<String>,
    /// Use the model's fast tier, for agents that have one.
    pub fast: bool,
}

/// Whether a model or effort from a task is safe to hand to an agent: empty,
/// or letters, digits, `.`, `_`, `:` and `-`, up to 64 characters, starting
/// with a letter or digit. Codex reads the effort as TOML, so quotes and
/// newlines must never get through, and a value must never pass as a flag.
pub fn valid_setting(value: &str) -> bool {
    value.is_empty() || codex::valid_setting(value)
}

/// Whether a session ID from Sling is safe to hand to an agent's resume
/// flag. Both agents use UUIDs.
pub fn valid_session_id(id: &str) -> bool {
    codex::chat::valid_session_id(id)
}

/// `None` for an empty setting, which means the agent's default.
pub fn setting(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
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

/// What a chat turn asks the agent, and where.
pub struct ChatSpec {
    pub bin: String,
    /// The turn's own empty directory.
    pub dir: PathBuf,
    pub prompt: String,
    pub instructions: String,
    /// Session to resume.
    pub resume: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: bool,
    pub env: Vec<(String, String)>,
    /// The `sling-runner` the agent starts as `sling-runner mcp`.
    pub mcp_command: PathBuf,
    pub tools_url: String,
    pub tools_token: String,
}

impl ChatSpec {
    fn mcp_env(&self) -> Vec<(String, String)> {
        vec![
            (mcp::URL_ENV.into(), self.tools_url.clone()),
            (mcp::TOKEN_ENV.into(), self.tools_token.clone()),
        ]
    }
}

/// How a chat turn ended.
#[derive(Debug, Default)]
pub struct ChatOutcome {
    /// The whole reply.
    pub text: String,
    pub session_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub failure: Option<String>,
    /// The session to resume isn't on this machine.
    pub session_missing: bool,
}

/// A running chat turn.
pub trait ChatRun: Send {
    /// Interrupts it, then kills it if it's still running after `grace`.
    fn cancel(&mut self, grace: Duration) -> BoxFuture<'_, ()>;
    /// Waits for it to exit and for its output to be read.
    fn finish(self: Box<Self>) -> BoxFuture<'static, Result<ChatOutcome>>;
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
    /// Whether `model` has a fast tier `RunSpec::fast` can turn on. `None`
    /// is the agent's default model.
    fn has_fast_tier(&self, model: Option<&str>) -> bool;
    fn detect<'a>(&'a self, bin: &'a str) -> BoxFuture<'a, Detected>;
    /// Starts the agent. Events arrive on `tx` until its output closes.
    fn start<'a>(
        &'a self,
        spec: &'a RunSpec,
        tx: mpsc::Sender<HarnessEvent>,
    ) -> BoxFuture<'a, Result<Box<dyn HarnessRun>>>;
    /// Starts a chat turn. Reply text and tool calls arrive on `tx` until
    /// its output closes.
    fn start_chat<'a>(
        &'a self,
        spec: &'a ChatSpec,
        tx: mpsc::Sender<chat_event::Kind>,
    ) -> BoxFuture<'a, Result<Box<dyn ChatRun>>>;
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
    fn has_fast_tier(&self, _model: Option<&str>) -> bool {
        true
    }

    fn detect<'a>(&'a self, bin: &'a str) -> BoxFuture<'a, Detected> {
        Box::pin(async move {
            let d = codex::detect(bin).await;
            Detected {
                ready: d.ready(),
                version: d.version,
                detail: d.detail,
                models: d.models,
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
                model: spec.model.clone(),
                effort: spec.effort.clone(),
                fast: spec.fast,
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

    fn start_chat<'a>(
        &'a self,
        spec: &'a ChatSpec,
        tx: mpsc::Sender<chat_event::Kind>,
    ) -> BoxFuture<'a, Result<Box<dyn ChatRun>>> {
        Box::pin(async move {
            // Codex hands these to the MCP server through `env_vars`.
            let mut env = spec.env.clone();
            env.extend(spec.mcp_env());
            let opts = codex::chat::ChatOptions {
                bin: spec.bin.clone(),
                dir: spec.dir.clone(),
                prompt: spec.prompt.clone(),
                instructions: spec.instructions.clone(),
                mcp: codex::chat::McpServer {
                    command: spec.mcp_command.clone(),
                    args: vec!["mcp".into()],
                    env_vars: vec![mcp::URL_ENV.into(), mcp::TOKEN_ENV.into()],
                },
                env: Some(env),
                model: spec.model.clone(),
                effort: spec.effort.clone(),
                fast: spec.fast,
                resume: spec.resume.clone(),
            };
            let (run, reader) = codex::Run::start_chat(&opts, tx).await?;
            Ok(Box::new(CodexChat { run, reader }) as Box<dyn ChatRun>)
        })
    }
}

struct CodexChat {
    run: codex::Run,
    reader: codex::chat::ChatReader,
}

impl ChatRun for CodexChat {
    fn cancel(&mut self, grace: Duration) -> BoxFuture<'_, ()> {
        Box::pin(self.run.cancel(grace))
    }

    fn finish(self: Box<Self>) -> BoxFuture<'static, Result<ChatOutcome>> {
        Box::pin(async move {
            let CodexChat { mut run, reader } = *self;
            let exit = run.wait().await?;
            let o = reader.finish(exit).await;
            Ok(ChatOutcome {
                text: o.text,
                session_id: o.session_id,
                input_tokens: o.input_tokens,
                output_tokens: o.output_tokens,
                failure: o.failure,
                session_missing: o.session_missing,
            })
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
    fn has_fast_tier(&self, model: Option<&str>) -> bool {
        claude::has_fast(model)
    }

    fn detect<'a>(&'a self, bin: &'a str) -> BoxFuture<'a, Detected> {
        Box::pin(async move {
            let d = claude::detect(bin).await;
            Detected {
                ready: d.ready(),
                version: d.version,
                detail: d.detail,
                models: d.models,
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
                model: spec.model.clone(),
                effort: spec.effort.clone(),
                fast: spec.fast,
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

    fn start_chat<'a>(
        &'a self,
        spec: &'a ChatSpec,
        tx: mpsc::Sender<chat_event::Kind>,
    ) -> BoxFuture<'a, Result<Box<dyn ChatRun>>> {
        Box::pin(async move {
            let opts = claude::chat::ChatOptions {
                bin: spec.bin.clone(),
                dir: spec.dir.clone(),
                prompt: spec.prompt.clone(),
                instructions: spec.instructions.clone(),
                // The token goes in the MCP config file, readable only by
                // this user, not in Claude Code's own environment.
                mcp: claude::chat::McpServer {
                    command: spec.mcp_command.clone(),
                    args: vec!["mcp".into()],
                    env: spec.mcp_env(),
                },
                env: Some({
                    // Longer than the bridge's own HTTP timeout, so its
                    // error arrives first.
                    let mut env = spec.env.clone();
                    env.push(("MCP_TOOL_TIMEOUT".into(), "720000".into()));
                    env
                }),
                model: spec.model.clone(),
                effort: spec.effort.clone(),
                fast: spec.fast,
                resume: spec.resume.clone(),
            };
            let (run, reader) = claude::Run::start_chat(&opts, tx).await?;
            Ok(Box::new(ClaudeChat { run, reader }) as Box<dyn ChatRun>)
        })
    }
}

struct ClaudeChat {
    run: claude::Run,
    reader: claude::chat::ChatReader,
}

impl ChatRun for ClaudeChat {
    fn cancel(&mut self, grace: Duration) -> BoxFuture<'_, ()> {
        Box::pin(self.run.cancel(grace))
    }

    fn finish(self: Box<Self>) -> BoxFuture<'static, Result<ChatOutcome>> {
        Box::pin(async move {
            let ClaudeChat { mut run, reader } = *self;
            let exit = run.wait().await?;
            let o = reader.finish(exit).await;
            Ok(ChatOutcome {
                text: o.text,
                session_id: o.session_id,
                input_tokens: o.input_tokens,
                output_tokens: o.output_tokens,
                failure: o.failure,
                session_missing: o.session_missing,
            })
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
    fn model_settings_are_empty_or_safe() {
        assert!(valid_setting(""));
        assert!(valid_setting("gpt-6.1-sol"));
        assert!(valid_setting("claude-opus-5-5"));
        assert!(!valid_setting("high\" sandbox_mode=\"danger-full-access"));
        assert!(!valid_setting("--dangerously-skip-permissions"));
        assert!(!valid_setting(&"a".repeat(65)));
        assert_eq!(setting(""), None);
        assert_eq!(setting("opus").as_deref(), Some("opus"));
        assert!(valid_session_id("01a1ad94-9adb-7991-b3a8-3f052f9cc2a3"));
        assert!(!valid_session_id("--resume"));
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
