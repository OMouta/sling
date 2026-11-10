//! Claude Code adapter. Spawns `claude -p --output-format stream-json`, reads
//! its events from stdout, and turns them into Sling `TaskEvent` kinds.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Value, json};
use sling_runner_protocol::{
    AgentMessage, AgentModel, CommandRun, FileChange, LogLine, PlanUpdate, Usage, command_run,
    file_change, log_line, plan_update, task_event::Kind,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

pub mod chat;

/// Command output kept per event. The tail matters more than the head.
pub const MAX_OUTPUT_BYTES: usize = 8 * 1024;

/// Hosts Bash may reach in Supervised and Auto when the repo allows network.
/// Claude Code's sandbox only takes a list of hosts and refuses `*`, so
/// "network on" means package registries and code hosts.
pub const NETWORK_DOMAINS: &[&str] = &[
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "gitlab.com",
    "*.gitlab.com",
    "bitbucket.org",
    "registry.npmjs.org",
    "*.npmjs.org",
    "registry.yarnpkg.com",
    "*.yarnpkg.com",
    "jsr.io",
    "*.jsr.io",
    "deno.land",
    "*.deno.land",
    "pypi.org",
    "*.pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "*.crates.io",
    "static.rust-lang.org",
    "*.rust-lang.org",
    "proxy.golang.org",
    "sum.golang.org",
    "*.golang.org",
    "rubygems.org",
    "*.rubygems.org",
    "repo.maven.apache.org",
    "*.maven.org",
    "*.gradle.org",
    "packagist.org",
    "*.packagist.org",
    "*.nuget.org",
    "pub.dev",
    "*.pub.dev",
    "hex.pm",
    "*.hex.pm",
];

#[derive(Debug, Clone, Default)]
pub struct Detection {
    pub installed: bool,
    pub version: String,
    pub logged_in: bool,
    pub detail: String,
    /// Models `--model` takes.
    pub models: Vec<AgentModel>,
}

/// Effort levels `--effort` takes, lowest first.
pub const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// Models by their full names, which `--model` takes as well as the
/// `opus`-style aliases. Claude Code has no command that lists models, so
/// this list is fixed.
pub fn models() -> Vec<AgentModel> {
    [
        ("claude-fable-5-1", "Claude Fable 5.1", "high", false, false),
        ("claude-opus-5-5", "Claude Opus 5.5", "medium", true, true),
        (
            "claude-sonnet-5-5",
            "Claude Sonnet 5.5",
            "high",
            false,
            false,
        ),
        (
            "claude-haiku-5-5",
            "Claude Haiku 5.5",
            "medium",
            false,
            false,
        ),
    ]
    .into_iter()
    .map(|(id, name, default_effort, is_default, fast)| AgentModel {
        id: id.into(),
        display_name: name.into(),
        efforts: EFFORTS.iter().map(|e| e.to_string()).collect(),
        default_effort: default_effort.into(),
        is_default,
        fast,
        ..Default::default()
    })
    .collect()
}

/// Whether Claude Code's fast mode works with `model`. Only Opus has it.
/// `None` is Claude Code's default model, which is Opus.
pub fn has_fast(model: Option<&str>) -> bool {
    match model {
        None | Some("opus") => true,
        Some(id) => models().iter().any(|m| m.id == id && m.fast),
    }
}

/// `--settings` that turns fast mode on for this run only. On a Claude
/// subscription, fast mode is billed to usage credits, not the plan.
fn with_fast(mut settings: Value) -> Value {
    if let Some(obj) = settings.as_object_mut() {
        obj.insert("fastMode".into(), Value::Bool(true));
    }
    settings
}

impl Detection {
    pub fn ready(&self) -> bool {
        self.installed && self.logged_in
    }
}

/// Finds out whether Claude Code is installed and logged in, using its own
/// CLI (`claude --version` and `claude auth status`). Never reads Claude
/// Code's credential files.
pub async fn detect(bin: &str) -> Detection {
    let version = match quick(bin, &["--version"]).await {
        Ok((true, out)) => out
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string(),
        _ => {
            return Detection {
                detail: format!("{bin} not found"),
                ..Default::default()
            };
        }
    };
    let (logged_in, detail) = match quick(bin, &["auth", "status", "--json"]).await {
        Ok((_, out)) => login_state(&out),
        Err(e) => (false, format!("could not check the login: {e}")),
    };
    Detection {
        installed: true,
        version,
        logged_in,
        detail,
        models: models(),
    }
}

/// Reads `claude auth status --json`. Only `loggedIn` and the method are
/// used; the account's email and organization are left out of the detail.
pub fn login_state(json_text: &str) -> (bool, String) {
    let Ok(v) = serde_json::from_str::<Value>(json_text.trim()) else {
        return (
            false,
            format!("unexpected auth status output: {}", first_line(json_text)),
        );
    };
    let logged_in = v["loggedIn"].as_bool().unwrap_or(false);
    let method = v["authMethod"].as_str().unwrap_or_default();
    let detail = match (logged_in, method) {
        (false, _) => "Not logged in. Run `claude auth login`, or set ANTHROPIC_API_KEY.".into(),
        (true, "api_key") => format!(
            "Logged in with an API key ({})",
            v["apiKeySource"].as_str().unwrap_or("unknown source")
        ),
        (true, "") => "Logged in".into(),
        (true, m) => format!("Logged in using {m}"),
    };
    (logged_in, detail)
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or_default().trim()
}

/// Runs a short command and returns whether it succeeded, with stdout.
async fn quick(bin: &str, args: &[&str]) -> Result<(bool, String)> {
    let out = tokio::time::timeout(
        Duration::from_secs(15),
        Command::new(bin)
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("timed out")??;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    ))
}

/// How much Claude Code may do, from Sling's permission mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Read-only: plan mode, so no edits and only read-only commands.
    ReadOnly,
    /// Supervised and Auto: edits in the working directory, and Bash inside
    /// Claude Code's sandbox.
    Edit,
    /// Full access: no permission checks and no sandbox.
    Full,
}

pub struct RunOptions {
    pub bin: String,
    pub cwd: PathBuf,
    pub prompt: String,
    pub access: Access,
    /// Lets sandboxed Bash reach `NETWORK_DOMAINS`. Only applies to `Edit`.
    pub network: bool,
    /// Environment for Claude Code. `None` inherits the Runner's.
    pub env: Option<Vec<(String, String)>>,
    /// `--model`, such as `claude-opus-5-5`. `None` uses Claude Code's default.
    pub model: Option<String>,
    /// `--effort`, such as `high`. `None` uses the model's default.
    pub effort: Option<String>,
    /// Fast mode, for a model that has it.
    pub fast: bool,
}

/// The `--settings` JSON for each access level. Passed on every run so the
/// result doesn't depend on the user's own sandbox settings.
pub fn settings_for(access: Access, network: bool) -> Value {
    match access {
        Access::ReadOnly => json!({
            "sandbox": {
                "enabled": true,
                "autoAllowBashIfSandboxed": false,
                "allowUnsandboxedCommands": false,
                "network": { "allowedDomains": [], "strictAllowlist": true },
            }
        }),
        Access::Edit => {
            let domains: &[&str] = if network { NETWORK_DOMAINS } else { &[] };
            json!({
                "sandbox": {
                    "enabled": true,
                    "autoAllowBashIfSandboxed": true,
                    "allowUnsandboxedCommands": false,
                    "failIfUnavailable": true,
                    "network": { "allowedDomains": domains, "strictAllowlist": true },
                }
            })
        }
        Access::Full => json!({ "sandbox": { "enabled": false } }),
    }
}

pub fn args_for(opts: &RunOptions) -> Vec<String> {
    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose"]
        .map(String::from)
        .to_vec();
    match opts.access {
        Access::ReadOnly => args.extend(["--permission-mode".into(), "plan".into()]),
        Access::Edit => args.extend(["--permission-mode".into(), "acceptEdits".into()]),
        Access::Full => args.push("--dangerously-skip-permissions".into()),
    }
    if let Some(model) = &opts.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = &opts.effort {
        args.extend(["--effort".into(), effort.clone()]);
    }
    let mut settings = settings_for(opts.access, opts.network);
    if opts.fast && has_fast(opts.model.as_deref()) {
        settings = with_fast(settings);
    }
    args.push("--settings".into());
    args.push(settings.to_string());
    // The prompt goes on stdin, so it never shows up in `ps`.
    args
}

/// What the Runner hears from a running Claude Code.
#[derive(Debug)]
pub enum Event {
    /// Something to record in the task's event stream.
    Task(Kind),
    SessionStarted {
        session_id: String,
        model: String,
    },
}

pub struct Outcome {
    pub exit_code: Option<i32>,
    /// The final result text, or the last assistant message.
    pub summary: String,
    /// Set when Claude Code reported an error result, or ended without one.
    pub failure: Option<String>,
}

pub struct Run {
    child: Child,
    pid: Option<u32>,
}

/// A started process with its output streams.
pub(crate) struct Spawned {
    pub child: Child,
    pub pid: Option<u32>,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

/// Starts `bin` in its own process group with `stdin_text` on stdin.
pub(crate) async fn spawn(
    bin: &str,
    args: &[String],
    cwd: &Path,
    env: Option<&[(String, String)]>,
    stdin_text: &str,
) -> Result<Spawned> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(env) = env {
        cmd.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
    }
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().with_context(|| format!("starting {bin}"))?;
    // Claude Code waits a few seconds for stdin when it isn't a TTY, so
    // write the prompt and close it right away.
    let mut stdin = child.stdin.take().context("no stdin")?;
    write_input(&mut stdin, stdin_text).await?;
    drop(stdin);
    Ok(Spawned {
        stdout: child.stdout.take().context("no stdout")?,
        stderr: child.stderr.take().context("no stderr")?,
        pid: child.id(),
        child,
    })
}

/// Writes the prompt and closes stdin. A process that exits before reading
/// it, as Claude Code does for a session it doesn't have, has already closed
/// the pipe. That's no error here: its exit and stderr say what happened.
async fn write_input(stdin: &mut ChildStdin, text: &str) -> std::io::Result<()> {
    let written = async {
        stdin.write_all(text.as_bytes()).await?;
        stdin.shutdown().await
    }
    .await;
    match written {
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        other => other,
    }
}

impl Run {
    /// Starts Claude Code. Events arrive on `tx` until the process exits; then
    /// call `wait`.
    pub async fn start(opts: &RunOptions, tx: mpsc::Sender<Event>) -> Result<(Run, Reader)> {
        let Spawned {
            child,
            pid,
            stdout,
            stderr,
        } = spawn(
            &opts.bin,
            &args_for(opts),
            &opts.cwd,
            opts.env.as_deref(),
            &opts.prompt,
        )
        .await?;

        let err_tx = tx.clone();
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let _ = err_tx
                    .send(Event::Task(Kind::Log(LogLine {
                        stream: log_line::Stream::HarnessStderr as i32,
                        text: truncate_tail(&line, 2048),
                    })))
                    .await;
            }
        });

        let stdout_task = tokio::spawn(async move {
            let mut parser = Parser::default();
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                for ev in parser.line(&line) {
                    if tx.send(ev).await.is_err() {
                        break;
                    }
                }
            }
            parser
        });

        Ok((
            Run { child, pid },
            Reader {
                stdout_task,
                stderr_task,
            },
        ))
    }

    /// Asks Claude Code to stop (SIGINT to its process group), then kills it
    /// if it hasn't exited after `grace`. Claude Code exits 0 after a SIGINT,
    /// so the caller has to remember that it cancelled.
    pub async fn cancel(&mut self, grace: Duration) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // SAFETY: plain syscall; a negative pid targets the process group we created.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGINT);
            }
        }
        if tokio::time::timeout(grace, self.child.wait())
            .await
            .is_err()
        {
            #[cfg(unix)]
            if let Some(pid) = self.pid {
                // SAFETY: as above.
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = self.child.kill().await;
        }
    }

    /// Process ID, which is also the process group ID on Unix.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub async fn wait(&mut self) -> Result<Option<i32>> {
        Ok(self.child.wait().await?.code())
    }
}

pub struct Reader {
    stdout_task: tokio::task::JoinHandle<Parser>,
    stderr_task: tokio::task::JoinHandle<()>,
}

impl Reader {
    /// Waits for the output streams to close and returns the parse result.
    pub async fn finish(self, exit_code: Option<i32>) -> Outcome {
        let parser = self.stdout_task.await.unwrap_or_default();
        let _ = self.stderr_task.await;
        parser.outcome(exit_code)
    }
}

/// A tool call waiting for its result.
struct PendingTool {
    name: String,
    input: Value,
}

/// Turns Claude Code's stream-json lines into Sling events. Pure, so it's
/// easy to test.
#[derive(Default)]
pub struct Parser {
    pub session_id: String,
    /// Last top-level assistant text.
    pub last_message: String,
    /// `result` text from the final event, when it succeeded.
    pub result: Option<String>,
    pub failure: Option<String>,
    pub saw_result: bool,
    pending: HashMap<String, PendingTool>,
}

impl Parser {
    pub fn outcome(self, exit_code: Option<i32>) -> Outcome {
        let failure = match (self.failure, self.saw_result) {
            (Some(f), _) => Some(f),
            (None, false) => Some("Claude Code ended without reporting a result.".into()),
            (None, true) => None,
        };
        Outcome {
            exit_code,
            summary: self.result.unwrap_or(self.last_message),
            failure,
        }
    }

    pub fn line(&mut self, line: &str) -> Vec<Event> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            if line.trim().is_empty() {
                return vec![];
            }
            return vec![log(line)];
        };
        self.value(&v)
    }

    /// Like `line`, for a line that's already parsed.
    pub fn value(&mut self, v: &Value) -> Vec<Event> {
        match v["type"].as_str().unwrap_or_default() {
            "system" => self.system(v),
            "assistant" => self.assistant(v),
            "user" => self.user(v),
            "result" => self.result(v),
            "rate_limit_event" => {
                let info = &v["rate_limit_info"];
                match info["status"].as_str() {
                    Some("allowed") | None => vec![],
                    Some(status) => vec![log(&format!(
                        "Claude Code rate limit: {status} ({})",
                        str_of(&info["rateLimitType"])
                    ))],
                }
            }
            _ => vec![],
        }
    }

    fn system(&mut self, v: &Value) -> Vec<Event> {
        match v["subtype"].as_str().unwrap_or_default() {
            "init" => {
                self.session_id = str_of(&v["session_id"]);
                vec![Event::SessionStarted {
                    session_id: self.session_id.clone(),
                    model: str_of(&v["model"]),
                }]
            }
            "permission_denied" => vec![log(&format!(
                "Claude Code was not allowed to use {}: {}",
                str_of(&v["tool_name"]),
                v["decision_reason"]
                    .as_str()
                    .or(v["message"].as_str())
                    .unwrap_or("denied")
            ))],
            "api_retry" => vec![log(&format!(
                "Claude Code is retrying an API request: {}",
                v["error"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| v["error"].to_string())
            ))],
            _ => vec![],
        }
    }

    fn assistant(&mut self, v: &Value) -> Vec<Event> {
        let top_level = v["parent_tool_use_id"].is_null();
        let msg_id = str_of(&v["message"]["id"]);
        let Some(content) = v["message"]["content"].as_array() else {
            return vec![];
        };
        let mut out = Vec::new();
        for (i, block) in content.iter().enumerate() {
            match block["type"].as_str().unwrap_or_default() {
                "text" if top_level => {
                    let text = str_of(&block["text"]);
                    if text.trim().is_empty() {
                        continue;
                    }
                    self.last_message = text.clone();
                    out.push(Event::Task(Kind::AgentMessage(AgentMessage {
                        item_id: format!("{msg_id}:{i}"),
                        text,
                    })));
                }
                "tool_use" => out.extend(self.tool_use(block)),
                _ => {}
            }
        }
        out
    }

    fn tool_use(&mut self, block: &Value) -> Vec<Event> {
        let id = str_of(&block["id"]);
        let name = str_of(&block["name"]);
        let input = block["input"].clone();
        let out = match name.as_str() {
            "Bash" => vec![Event::Task(Kind::Command(CommandRun {
                item_id: id.clone(),
                command: str_of(&input["command"]),
                status: command_run::Status::Started as i32,
                exit_code: None,
                output: String::new(),
            }))],
            "TodoWrite" => {
                let steps = input["todos"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|t| plan_update::Step {
                                text: str_of(&t["content"]),
                                done: t["status"].as_str() == Some("completed"),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                vec![Event::Task(Kind::Plan(PlanUpdate { steps }))]
            }
            "WebFetch" => vec![log(&format!("fetch: {}", str_of(&input["url"])))],
            "WebSearch" => vec![log(&format!("web search: {}", str_of(&input["query"])))],
            "Task" | "Agent" => vec![log(&format!("subagent: {}", str_of(&input["description"])))],
            n if n.starts_with("mcp__") => {
                let mut parts = n.trim_start_matches("mcp__").splitn(2, "__");
                let server = parts.next().unwrap_or_default();
                let tool = parts.next().unwrap_or_default();
                vec![log(&format!("tool call: {server}.{tool}"))]
            }
            _ => vec![],
        };
        self.pending.insert(id, PendingTool { name, input });
        out
    }

    fn user(&mut self, v: &Value) -> Vec<Event> {
        let Some(content) = v["message"]["content"].as_array() else {
            return vec![];
        };
        let mut out = Vec::new();
        for block in content {
            if block["type"].as_str() != Some("tool_result") {
                continue;
            }
            let id = str_of(&block["tool_use_id"]);
            let Some(tool) = self.pending.remove(&id) else {
                continue;
            };
            let is_error = block["is_error"].as_bool().unwrap_or(false);
            // `tool_use_result` is set on top-level results only.
            let detail = if content.len() == 1 {
                &v["tool_use_result"]
            } else {
                &Value::Null
            };
            out.extend(tool_result(id, &tool, block, detail, is_error));
        }
        out
    }

    fn result(&mut self, v: &Value) -> Vec<Event> {
        self.saw_result = true;
        if self.session_id.is_empty() {
            self.session_id = str_of(&v["session_id"]);
        }
        let mut out = Vec::new();
        let u = &v["usage"];
        if u.is_object() {
            let input = u["input_tokens"].as_u64().unwrap_or(0);
            let created = u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            let read = u["cache_read_input_tokens"].as_u64().unwrap_or(0);
            out.push(Event::Task(Kind::Usage(Usage {
                input_tokens: input + created + read,
                cached_input_tokens: read,
                output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
            })));
        }
        let text = str_of(&v["result"]);
        if v["is_error"].as_bool().unwrap_or(false) {
            let errors: Vec<String> = v["errors"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|e| e.as_str())
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default();
            let msg = if !text.trim().is_empty() {
                text
            } else if !errors.is_empty() {
                errors.join("; ")
            } else {
                format!(
                    "Claude Code reported an error ({})",
                    v["subtype"].as_str().unwrap_or("unknown")
                )
            };
            out.push(log(&format!("error: {msg}")));
            self.failure = Some(msg);
        } else if !text.trim().is_empty() {
            self.result = Some(text);
        }
        if let Some(denials) = v["permission_denials"].as_array()
            && !denials.is_empty()
        {
            let tools: Vec<String> = denials.iter().map(|d| str_of(&d["tool_name"])).collect();
            out.push(log(&format!(
                "Claude Code was denied {} tool call(s): {}",
                denials.len(),
                tools.join(", ")
            )));
        }
        out
    }
}

fn tool_result(
    id: String,
    tool: &PendingTool,
    block: &Value,
    detail: &Value,
    is_error: bool,
) -> Vec<Event> {
    let input = &tool.input;
    match tool.name.as_str() {
        "Bash" => {
            let output = content_text(&block["content"]);
            let exit_code = if is_error {
                error_exit_code(&output)
            } else {
                Some(0)
            };
            let status = if is_error {
                command_run::Status::Failed
            } else {
                command_run::Status::Completed
            };
            vec![Event::Task(Kind::Command(CommandRun {
                item_id: id,
                command: str_of(&input["command"]),
                status: status as i32,
                exit_code,
                output: truncate_tail(&output, MAX_OUTPUT_BYTES),
            }))]
        }
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" if !is_error => {
            let path = input["file_path"]
                .as_str()
                .or(input["notebook_path"].as_str())
                .unwrap_or_default()
                .to_string();
            if path.is_empty() {
                return vec![];
            }
            let created = tool.name == "Write"
                && (detail["type"].as_str() == Some("create")
                    || (detail.is_object() && detail["originalFile"].is_null()));
            let kind = if created {
                file_change::Kind::Add
            } else {
                file_change::Kind::Modify
            };
            vec![Event::Task(Kind::FileChange(FileChange {
                item_id: id,
                changes: vec![file_change::Change {
                    path,
                    kind: kind as i32,
                }],
            }))]
        }
        _ => vec![],
    }
}

/// `tool_result` content is a string or a list of text blocks.
fn content_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Failed Bash results start with `Exit code N`.
fn error_exit_code(output: &str) -> Option<i32> {
    first_line(output)
        .strip_prefix("Exit code ")
        .and_then(|n| n.trim().parse().ok())
}

fn str_of(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn log(text: &str) -> Event {
    Event::Task(Kind::Log(LogLine {
        stream: log_line::Stream::Runner as i32,
        text: truncate_tail(text, 2048),
    }))
}

/// Keeps the last `max` bytes, cut on a char boundary.
pub fn truncate_tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("[...truncated]\n{}", &s[start..])
}

/// Prompt Sling sends Claude Code. The Runner does all committing and
/// pushing, so Claude Code is told to leave its changes uncommitted. Sling
/// commits new files only when they were made with the file tools, so it's
/// told to use those.
pub fn build_prompt(title: &str, objective: &str, writes: bool) -> String {
    let rules = if writes {
        "- Work only inside the current directory.\n\
         - Create and edit files with your file tools (Write, Edit), not with shell commands. Sling only commits new files it saw you create.\n\
         - Leave your changes uncommitted. Sling commits them for you.\n\
         - Do not push, and do not open pull requests.\n\
         - Run the relevant tests if the project has them.\n\
         - When you finish, reply with a short summary of what you changed and what the tests showed."
    } else {
        "- This is a read-only task. Do not modify any files.\n\
         - Investigate and report what you found.\n\
         - Reply with a short, concrete summary."
    };
    format!(
        "You are working on a task that Sling delegated to you, in the repository in the current directory.\n\n\
         Task: {title}\n\n{objective}\n\nRules:\n{rules}\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(p: &mut Parser, line: &str) -> Vec<Kind> {
        p.line(line)
            .into_iter()
            .filter_map(|e| match e {
                Event::Task(k) => Some(k),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn reads_the_login_state() {
        let (ok, detail) = login_state(
            r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","orgName":"Org"}"#,
        );
        assert!(ok);
        assert_eq!(detail, "Logged in using claude.ai");
        let (ok, detail) = login_state(
            r#"{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}"#,
        );
        assert!(ok);
        assert!(detail.contains("ANTHROPIC_API_KEY"));
        let (ok, detail) = login_state(r#"{"loggedIn":false,"authMethod":"none"}"#);
        assert!(!ok);
        assert!(detail.starts_with("Not logged in"));
        assert!(!login_state("error: unknown command").0);
    }

    #[test]
    fn maps_modes_to_flags_and_settings() {
        let mut opts = RunOptions {
            bin: "claude".into(),
            cwd: "/tmp/w".into(),
            prompt: String::new(),
            access: Access::ReadOnly,
            network: true,
            env: None,
            model: None,
            effort: None,
            fast: false,
        };
        let args = args_for(&opts);
        assert!(!args.iter().any(|a| a == "--model" || a == "--effort"));
        assert_eq!(
            &args[..4],
            ["-p", "--output-format", "stream-json", "--verbose"]
        );
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "plan"]));
        let settings: Value = serde_json::from_str(args.last().unwrap()).unwrap();
        assert_eq!(settings["sandbox"]["autoAllowBashIfSandboxed"], false);
        assert_eq!(
            settings["sandbox"]["network"]["allowedDomains"],
            json!([]),
            "read-only never gets network"
        );

        opts.access = Access::Edit;
        let args = args_for(&opts);
        assert!(
            args.windows(2)
                .any(|w| w == ["--permission-mode", "acceptEdits"])
        );
        let settings: Value = serde_json::from_str(args.last().unwrap()).unwrap();
        assert_eq!(settings["sandbox"]["enabled"], true);
        assert_eq!(settings["sandbox"]["allowUnsandboxedCommands"], false);
        assert!(
            settings["sandbox"]["network"]["allowedDomains"]
                .as_array()
                .unwrap()
                .contains(&json!("registry.npmjs.org"))
        );

        opts.network = false;
        let settings = settings_for(opts.access, opts.network);
        assert_eq!(settings["sandbox"]["network"]["allowedDomains"], json!([]));

        opts.access = Access::Full;
        let args = args_for(&opts);
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(!args.contains(&"--permission-mode".to_string()));
        assert_eq!(
            settings_for(Access::Full, true)["sandbox"]["enabled"],
            false
        );
    }

    #[test]
    fn passes_the_model_and_effort() {
        let opts = RunOptions {
            bin: "claude".into(),
            cwd: "/tmp/w".into(),
            prompt: String::new(),
            access: Access::Edit,
            network: false,
            env: None,
            model: Some("opus".into()),
            effort: Some("xhigh".into()),
            fast: false,
        };
        let args = args_for(&opts);
        assert!(args.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(args.windows(2).any(|w| w == ["--effort", "xhigh"]));
        assert!(
            serde_json::from_str::<Value>(args.last().unwrap()).is_ok(),
            "settings stay last"
        );
    }

    #[test]
    fn turns_on_fast_mode_only_for_a_model_that_has_it() {
        let settings = |model: &str, fast: bool| {
            let args = args_for(&RunOptions {
                bin: "claude".into(),
                cwd: "/tmp/w".into(),
                prompt: String::new(),
                access: Access::Edit,
                network: false,
                env: None,
                model: Some(model.into()),
                effort: None,
                fast,
            });
            serde_json::from_str::<Value>(args.last().unwrap()).unwrap()
        };
        let on = settings("claude-opus-5-5", true);
        assert_eq!(on["fastMode"], true);
        // The sandbox settings are still there.
        assert_eq!(on["sandbox"]["enabled"], true);
        assert!(settings("claude-opus-5-5", false).get("fastMode").is_none());
        assert!(
            settings("claude-sonnet-5-5", true)
                .get("fastMode")
                .is_none()
        );
        assert!(has_fast(None));
        assert!(!has_fast(Some("claude-haiku-5-5")));
    }

    #[test]
    fn lists_models_by_full_name() {
        let models = models();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "claude-fable-5-1",
                "claude-opus-5-5",
                "claude-sonnet-5-5",
                "claude-haiku-5-5"
            ]
        );
        let names: Vec<&str> = models.iter().map(|m| m.display_name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Claude Fable 5.1",
                "Claude Opus 5.5",
                "Claude Sonnet 5.5",
                "Claude Haiku 5.5"
            ]
        );
        let defaults: Vec<&str> = models.iter().map(|m| m.default_effort.as_str()).collect();
        assert_eq!(defaults, ["high", "medium", "high", "medium"]);
        let default: Vec<&str> = models
            .iter()
            .filter(|m| m.is_default)
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(default, ["claude-opus-5-5"]);
        let fast: Vec<&str> = models
            .iter()
            .filter(|m| m.fast)
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(fast, ["claude-opus-5-5"]);
        assert!(
            models
                .iter()
                .all(|m| m.efforts == ["low", "medium", "high", "xhigh", "max"])
        );
        assert!(
            models
                .iter()
                .all(|m| m.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        );
    }

    #[test]
    fn network_domains_are_ones_claude_code_accepts() {
        // Claude Code refuses "*" and one-label wildcards like "*.com".
        for d in NETWORK_DOMAINS {
            let host = d.strip_prefix("*.").unwrap_or(d);
            assert!(!host.contains('*'), "{d}");
            assert!(host.split('.').count() >= 2, "{d}");
        }
    }

    #[test]
    fn bash_results_become_commands() {
        let mut p = Parser::default();
        let started = kinds(
            &mut p,
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"cargo test"}}]},"parent_tool_use_id":null}"#,
        );
        let Kind::Command(c) = &started[0] else {
            panic!("{started:?}")
        };
        assert_eq!(c.status(), command_run::Status::Started);
        assert_eq!(c.command, "cargo test");

        let done = kinds(
            &mut p,
            r#"{"type":"user","message":{"content":[{"tool_use_id":"tu1","type":"tool_result","content":"Exit code 101\nerror: 1 test failed","is_error":true}]},"tool_use_result":"Error: Exit code 101"}"#,
        );
        let Kind::Command(c) = &done[0] else {
            panic!("{done:?}")
        };
        assert_eq!(c.status(), command_run::Status::Failed);
        assert_eq!(c.exit_code, Some(101));
        assert!(c.output.contains("1 test failed"));
    }

    #[test]
    fn todo_lists_become_plans() {
        let mut p = Parser::default();
        let plan = kinds(
            &mut p,
            r#"{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"TodoWrite","input":{"todos":[{"content":"Edit","status":"completed","activeForm":"Editing"},{"content":"Test","status":"in_progress","activeForm":"Testing"}]}}]},"parent_tool_use_id":null}"#,
        );
        let Kind::Plan(p) = &plan[0] else {
            panic!("{plan:?}")
        };
        assert_eq!(p.steps.len(), 2);
        assert!(p.steps[0].done && !p.steps[1].done);
    }

    #[test]
    fn subagent_text_is_left_out_but_its_edits_count() {
        let mut p = Parser::default();
        assert!(
            kinds(
                &mut p,
                r#"{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"sub says hi"}]},"parent_tool_use_id":"tu0"}"#,
            )
            .is_empty()
        );
        kinds(
            &mut p,
            r#"{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"/w/a.rs","old_string":"a","new_string":"b"}}]},"parent_tool_use_id":"tu0"}"#,
        );
        let fc = kinds(
            &mut p,
            r#"{"type":"user","message":{"content":[{"tool_use_id":"e1","type":"tool_result","content":"ok"}]},"parent_tool_use_id":"tu0"}"#,
        );
        let Kind::FileChange(f) = &fc[0] else {
            panic!("{fc:?}")
        };
        assert_eq!(f.changes[0].path, "/w/a.rs");
        assert_eq!(f.changes[0].kind(), file_change::Kind::Modify);
        assert!(p.last_message.is_empty());
    }

    #[test]
    fn a_missing_result_is_a_failure() {
        let p = Parser::default();
        let o = p.outcome(Some(0));
        assert!(o.failure.unwrap().contains("without reporting a result"));
    }

    #[test]
    fn non_json_lines_become_logs() {
        let mut p = Parser::default();
        assert!(matches!(kinds(&mut p, "plain text")[0], Kind::Log(_)));
        assert!(p.line("").is_empty());
    }

    #[test]
    fn truncates_from_the_front() {
        let s = "x".repeat(100) + "END";
        let t = truncate_tail(&s, 10);
        assert!(t.ends_with("END"));
        assert!(t.len() < 40);
    }
}
