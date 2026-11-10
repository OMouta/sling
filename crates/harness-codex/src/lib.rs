//! Codex adapter. Spawns `codex exec --json`, reads its JSONL events from
//! stdout, and turns them into Sling `TaskEvent` kinds.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;
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

#[derive(Debug, Clone, Default)]
pub struct Detection {
    pub installed: bool,
    pub version: String,
    pub logged_in: bool,
    pub detail: String,
    /// Models Codex lists for `-m`. Empty when it couldn't say.
    pub models: Vec<AgentModel>,
}

impl Detection {
    pub fn ready(&self) -> bool {
        self.installed && self.logged_in
    }
}

/// Finds out whether Codex is installed and logged in, using Codex's own CLI.
/// Never reads Codex's credential files.
pub async fn detect(bin: &str) -> Detection {
    let Ok(version) = quick(bin, &["--version"]).await else {
        return Detection {
            detail: format!("{bin} not found"),
            ..Default::default()
        };
    };
    let version = parse_version(&version);
    let (logged_in, detail) = match quick(bin, &["login", "status"]).await {
        Ok(text) => login_state(&text),
        Err(e) => (false, format!("not logged in: {e}")),
    };
    Detection {
        installed: true,
        version,
        logged_in,
        detail,
        models: list_models(bin).await,
    }
}

/// Models from `codex debug models`, which prints Codex's model catalog as
/// JSON. Any failure gives an empty list.
pub async fn list_models(bin: &str) -> Vec<AgentModel> {
    let out = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(bin)
            .args(["debug", "models"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    match out {
        Ok(Ok(out)) if out.status.success() => parse_models(&String::from_utf8_lossy(&out.stdout)),
        _ => Vec::new(),
    }
}

/// Reads the catalog `codex debug models` prints. Keeps the models Codex
/// lists in its own picker, ordered by Codex's priority, and marks the first
/// one as the default. Text before the JSON, such as a warning, is skipped.
pub fn parse_models(text: &str) -> Vec<AgentModel> {
    let Some(start) = text.find('{') else {
        return Vec::new();
    };
    let Some(Ok(catalog)) = serde_json::Deserializer::from_str(&text[start..])
        .into_iter::<Value>()
        .next()
    else {
        return Vec::new();
    };
    let Some(entries) = catalog["models"].as_array() else {
        return Vec::new();
    };
    let mut models: Vec<(i64, AgentModel)> = entries
        .iter()
        .filter(|m| m["visibility"].as_str() == Some("list"))
        .filter_map(|m| {
            let id = m["slug"].as_str().filter(|s| valid_setting(s))?.to_string();
            let efforts: Vec<String> = m["supported_reasoning_levels"]
                .as_array()
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(|l| l["effort"].as_str())
                        .filter(|e| valid_setting(e))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let fast = m["additional_speed_tiers"]
                .as_array()
                .is_some_and(|t| t.iter().any(|t| t.as_str() == Some("fast")))
                || m["service_tiers"].as_array().is_some_and(|t| !t.is_empty());
            let model = AgentModel {
                display_name: m["display_name"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&id)
                    .to_string(),
                description: str_of(&m["description"]),
                default_effort: str_of(&m["default_reasoning_level"]),
                efforts,
                fast,
                is_default: false,
                id,
            };
            Some((m["priority"].as_i64().unwrap_or(i64::MAX), model))
        })
        .collect();
    models.sort_by_key(|(priority, _)| *priority);
    if let Some((_, first)) = models.first_mut() {
        first.is_default = true;
    }
    models.into_iter().map(|(_, m)| m).collect()
}

/// Model and effort values may use letters, digits, `.`, `_`, `:` and `-`,
/// up to 64 characters, starting with a letter or digit. They end up in a
/// TOML `-c` override, so nothing that could close a string gets through,
/// and they can't be mistaken for a flag.
pub fn valid_setting(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.starts_with(|c: char| c.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// The version from `codex --version`, which prints `codex-cli 0.166.0`,
/// sometimes after a warning.
pub fn parse_version(text: &str) -> String {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("codex-cli "))
        .or_else(|| text.split_whitespace().last())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Reads the output of a successful `codex login status`. It prints, for
/// example, `Logged in using ChatGPT`, or `API key configured - ***` after a
/// login with an API key. Warning lines come first sometimes.
pub fn login_state(text: &str) -> (bool, String) {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("WARNING"))
        .unwrap_or_default()
        .to_string();
    (!line.to_lowercase().starts_with("not logged in"), line)
}

async fn quick(bin: &str, args: &[&str]) -> Result<String> {
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
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        anyhow::bail!("{}", text.trim());
    }
    Ok(text)
}

pub struct RunOptions {
    pub bin: String,
    pub cwd: PathBuf,
    pub prompt: String,
    /// `read-only`, `workspace-write`, or `danger-full-access`.
    pub sandbox: String,
    pub network: bool,
    /// Environment for Codex. `None` inherits the Runner's.
    pub env: Option<Vec<(String, String)>>,
    /// `-m`, one of the catalog's slugs. `None` uses Codex's default.
    pub model: Option<String>,
    /// `model_reasoning_effort`. `None` uses the model's default.
    pub effort: Option<String>,
    /// Use the model's fast service tier.
    pub fast: bool,
}

/// Codex's name for its fast service tier, which it sends as the
/// `priority` tier.
pub const FAST_SERVICE_TIER: &str = "fast";

/// What the Runner hears from a running Codex.
#[derive(Debug)]
pub enum Event {
    /// Something to record in the task's event stream.
    Task(Kind),
    ThreadStarted(String),
}

pub struct Outcome {
    pub exit_code: Option<i32>,
    /// Last agent message, used as the task summary.
    pub summary: String,
    /// Set when Codex reported `turn.failed` or `error`.
    pub failure: Option<String>,
}

pub struct Run {
    child: Child,
    pid: Option<u32>,
}

pub fn args_for(opts: &RunOptions) -> Vec<String> {
    let mut args = vec![
        "exec".to_string(),
        "--json".into(),
        "-s".into(),
        opts.sandbox.clone(),
        "-C".into(),
        opts.cwd.display().to_string(),
        "-c".into(),
        "approval_policy=\"never\"".into(),
    ];
    // Set every time, so a user's own config.toml can't open the network
    // or extra folders to a task.
    if opts.sandbox == "workspace-write" {
        args.push("-c".into());
        args.push(format!(
            "sandbox_workspace_write.network_access={}",
            opts.network
        ));
        args.push("-c".into());
        args.push("sandbox_workspace_write.writable_roots=[]".into());
    }
    if let Some(model) = &opts.model {
        args.push("-m".into());
        args.push(model.clone());
    }
    if let Some(effort) = &opts.effort {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort=\"{effort}\""));
    }
    if opts.fast {
        args.push("-c".into());
        args.push(format!("service_tier=\"{FAST_SERVICE_TIER}\""));
    }
    // Prompt comes from stdin, so it never shows up in `ps`.
    args.push("-".into());
    args
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
/// it, as Codex does for a session it doesn't have, has already closed
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

/// Refuses a model or effort that isn't safe to put in a TOML override.
pub(crate) fn check_settings(model: &Option<String>, effort: &Option<String>) -> Result<()> {
    for value in [model, effort].into_iter().flatten() {
        anyhow::ensure!(
            valid_setting(value),
            "refusing model setting {value:?}: use letters, digits, '.', '_', ':' and '-'"
        );
    }
    Ok(())
}

impl Run {
    /// Starts Codex. Events arrive on `tx` until the process exits; then call
    /// `wait`.
    pub async fn start(opts: &RunOptions, tx: mpsc::Sender<Event>) -> Result<(Run, Reader)> {
        check_settings(&opts.model, &opts.effort)?;
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
                if line.trim().is_empty() || line.starts_with("Reading additional input") {
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

    /// Asks Codex to stop (SIGINT to its process group), then kills it if it
    /// hasn't exited after `grace`.
    pub async fn cancel(&mut self, grace: Duration) {
        // Windows has no interrupt to send, so there is nothing to wait for.
        let grace = if cfg!(unix) { grace } else { Duration::ZERO };
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
        Outcome {
            exit_code,
            summary: parser.last_message,
            failure: parser.failure,
        }
    }
}

/// Turns Codex JSONL lines into Sling events. Pure, so it's easy to test.
#[derive(Default)]
pub struct Parser {
    pub last_message: String,
    pub failure: Option<String>,
}

impl Parser {
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
        let ty = v["type"].as_str().unwrap_or_default();
        match ty {
            "thread.started" => {
                vec![Event::ThreadStarted(str_of(&v["thread_id"]))]
            }
            "item.started" | "item.updated" | "item.completed" => {
                self.item(&v["item"], ty == "item.completed")
            }
            "turn.completed" => {
                let u = &v["usage"];
                vec![Event::Task(Kind::Usage(Usage {
                    input_tokens: u["input_tokens"].as_u64().unwrap_or(0),
                    cached_input_tokens: u["cached_input_tokens"].as_u64().unwrap_or(0),
                    output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
                }))]
            }
            "turn.failed" => {
                let msg = v["error"]["message"]
                    .as_str()
                    .unwrap_or("Codex reported a failed turn")
                    .to_string();
                self.failure = Some(msg.clone());
                vec![log(&format!("turn failed: {msg}"))]
            }
            "error" => {
                let msg = v["message"].as_str().unwrap_or("Codex error").to_string();
                self.failure = Some(msg.clone());
                vec![log(&format!("error: {msg}"))]
            }
            _ => vec![],
        }
    }

    fn item(&mut self, item: &Value, completed: bool) -> Vec<Event> {
        let id = str_of(&item["id"]);
        match item["type"].as_str().unwrap_or_default() {
            "agent_message" if completed => {
                let text = str_of(&item["text"]);
                self.last_message = text.clone();
                vec![Event::Task(Kind::AgentMessage(AgentMessage {
                    item_id: id,
                    text,
                }))]
            }
            "command_execution" => {
                let status = match (completed, item["exit_code"].as_i64()) {
                    (false, _) => command_run::Status::Started,
                    (true, Some(0)) => command_run::Status::Completed,
                    (true, _) => command_run::Status::Failed,
                };
                vec![Event::Task(Kind::Command(CommandRun {
                    item_id: id,
                    command: str_of(&item["command"]),
                    status: status as i32,
                    exit_code: item["exit_code"].as_i64().map(|c| c as i32),
                    output: if completed {
                        truncate_tail(&str_of(&item["aggregated_output"]), MAX_OUTPUT_BYTES)
                    } else {
                        String::new()
                    },
                }))]
            }
            "file_change" if completed => {
                let changes = item["changes"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|c| file_change::Change {
                                path: str_of(&c["path"]),
                                kind: match c["kind"].as_str().unwrap_or_default() {
                                    "add" => file_change::Kind::Add,
                                    "delete" => file_change::Kind::Delete,
                                    _ => file_change::Kind::Modify,
                                } as i32,
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                vec![Event::Task(Kind::FileChange(FileChange {
                    item_id: id,
                    changes,
                }))]
            }
            "todo_list" => {
                let steps = item["items"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|s| plan_update::Step {
                                text: str_of(&s["text"]),
                                done: s["completed"].as_bool().unwrap_or(false),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                vec![Event::Task(Kind::Plan(PlanUpdate { steps }))]
            }
            "web_search" if completed => {
                vec![log(&format!("web search: {}", str_of(&item["query"])))]
            }
            "mcp_tool_call" if completed => vec![log(&format!(
                "tool call: {}.{}",
                str_of(&item["server"]),
                str_of(&item["tool"])
            ))],
            "error" if completed => vec![log(&format!("error: {}", str_of(&item["message"])))],
            _ => vec![],
        }
    }
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

/// Prompt Sling sends Codex. The Runner does all committing and pushing, so
/// Codex is told not to, and to keep git out of its summary.
pub fn build_prompt(title: &str, objective: &str, writes: bool) -> String {
    let rules = if writes {
        "- Work only inside the current directory.\n\
         - Do not commit, push, or open pull requests. Sling commits your work when you finish and handles the rest.\n\
         - Run the relevant tests if the project has them.\n\
         - When you finish, reply with a short summary of what you changed and what the tests showed. Don't mention committing. Sling does that after you."
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

pub fn worktree_is_git(path: &Path) -> bool {
    path.join(".git").exists()
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
    fn parses_the_spike_transcript() {
        let mut p = Parser::default();
        assert!(matches!(
            p.line(r#"{"type":"thread.started","thread_id":"t1"}"#)[0],
            Event::ThreadStarted(_)
        ));
        let started = kinds(
            &mut p,
            r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#,
        );
        let Kind::Command(c) = &started[0] else {
            panic!()
        };
        assert_eq!(c.status(), command_run::Status::Started);

        let done = kinds(
            &mut p,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"a.txt\n","exit_code":0,"status":"completed"}}"#,
        );
        let Kind::Command(c) = &done[0] else { panic!() };
        assert_eq!(c.status(), command_run::Status::Completed);
        assert_eq!(c.output, "a.txt\n");

        kinds(
            &mut p,
            r#"{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done."}}"#,
        );
        assert_eq!(p.last_message, "Done.");

        let usage = kinds(
            &mut p,
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}"#,
        );
        let Kind::Usage(u) = &usage[0] else { panic!() };
        assert_eq!((u.input_tokens, u.output_tokens), (10, 2));
        assert!(p.failure.is_none());
    }

    #[test]
    fn records_failures_and_file_changes() {
        let mut p = Parser::default();
        let fc = kinds(
            &mut p,
            r#"{"type":"item.completed","item":{"id":"i","type":"file_change","changes":[{"path":"a.rs","kind":"update"},{"path":"b.rs","kind":"add"}],"status":"completed"}}"#,
        );
        let Kind::FileChange(f) = &fc[0] else {
            panic!()
        };
        assert_eq!(f.changes.len(), 2);
        assert_eq!(f.changes[1].kind(), file_change::Kind::Add);
        p.line(r#"{"type":"turn.failed","error":{"message":"rate limited"}}"#);
        assert_eq!(p.failure.as_deref(), Some("rate limited"));
    }

    #[test]
    fn reads_version_and_login_with_warnings() {
        let warning = "WARNING: proceeding, even though we could not create PATH aliases\n";
        assert_eq!(parse_version("codex-cli 0.166.0\n"), "0.166.0");
        assert_eq!(
            parse_version(&format!("{warning}codex-cli 0.166.0\n")),
            "0.166.0"
        );
        assert_eq!(
            login_state("Logged in using ChatGPT\n"),
            (true, "Logged in using ChatGPT".to_string())
        );
        assert_eq!(
            login_state(&format!(
                "{warning}API key configured - ***\nAuthentication is checked when you send a request.\n"
            )),
            (true, "API key configured - ***".to_string())
        );
        assert!(!login_state("Not logged in\n").0);
    }

    #[test]
    fn reads_the_model_catalog() {
        let text = r#"WARNING: proceeding, even though we could not create PATH aliases
{"models":[
  {"slug":"gpt-b","display_name":"GPT B","description":"Second.","default_reasoning_level":"medium",
   "supported_reasoning_levels":[{"effort":"low","description":"x"},{"effort":"medium"},{"effort":"high"}],
   "visibility":"list","priority":2,"additional_speed_tiers":[],"service_tiers":[]},
  {"slug":"gpt-hidden","display_name":"Hidden","visibility":"hide","priority":0},
  {"slug":"gpt-a","display_name":"GPT A","description":"First.","default_reasoning_level":"low",
   "supported_reasoning_levels":[{"effort":"low"},{"effort":"xhigh"}],
   "visibility":"list","priority":1,"additional_speed_tiers":["fast"],"service_tiers":[]},
  {"slug":"gpt-c","display_name":"","visibility":"list","priority":3,
   "additional_speed_tiers":[],"service_tiers":[{"id":"priority","name":"Fast"}]},
  {"slug":"bad\"slug","visibility":"list","priority":4}
]}"#;
        let models = parse_models(text);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-a", "gpt-b", "gpt-c"]);
        let a = &models[0];
        assert!(a.is_default);
        assert!(a.fast);
        assert_eq!(a.display_name, "GPT A");
        assert_eq!(a.efforts, ["low", "xhigh"]);
        assert_eq!(a.default_effort, "low");
        let b = &models[1];
        assert!(!b.is_default);
        assert!(!b.fast);
        assert_eq!(b.description, "Second.");
        assert_eq!(b.efforts, ["low", "medium", "high"]);
        let c = &models[2];
        assert!(c.fast, "a service tier means a fast tier");
        assert_eq!(c.display_name, "gpt-c");
        assert!(c.efforts.is_empty());
    }

    #[test]
    fn a_bad_catalog_gives_no_models() {
        assert!(parse_models("").is_empty());
        assert!(parse_models("error: unknown command").is_empty());
        assert!(parse_models(r#"{"models": "nope"}"#).is_empty());
        assert!(parse_models(r#"{"models": [{"slug": "x"#).is_empty());
    }

    #[test]
    fn settings_use_a_safe_charset() {
        for ok in ["gpt-6.1-sol", "high", "o3:latest", "a_b"] {
            assert!(valid_setting(ok), "{ok}");
        }
        for bad in [
            "",
            "high\"",
            "a b",
            "x\n",
            "é",
            "-p",
            "--yolo",
            &"x".repeat(65),
        ] {
            assert!(!valid_setting(bad), "{bad:?}");
        }
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

    #[test]
    fn network_flag_only_applies_to_workspace_write() {
        let mut opts = RunOptions {
            bin: "codex".into(),
            cwd: "/tmp/w".into(),
            prompt: String::new(),
            sandbox: "workspace-write".into(),
            network: true,
            env: None,
            model: None,
            effort: None,
            fast: false,
        };
        let has = |opts: &RunOptions, arg: &str| args_for(opts).contains(&arg.to_string());
        assert!(has(&opts, "sandbox_workspace_write.network_access=true"));
        assert!(has(&opts, "sandbox_workspace_write.writable_roots=[]"));
        opts.network = false;
        assert!(has(&opts, "sandbox_workspace_write.network_access=false"));
        assert!(has(&opts, "sandbox_workspace_write.writable_roots=[]"));
        opts.sandbox = "read-only".into();
        opts.network = true;
        assert!(
            !args_for(&opts)
                .iter()
                .any(|a| a.starts_with("sandbox_workspace_write"))
        );
        assert_eq!(args_for(&opts).last().unwrap(), "-");
    }

    #[test]
    fn passes_model_effort_and_fast_tier() {
        let mut opts = RunOptions {
            bin: "codex".into(),
            cwd: "/tmp/w".into(),
            prompt: String::new(),
            sandbox: "workspace-write".into(),
            network: false,
            env: None,
            model: None,
            effort: None,
            fast: false,
        };
        let plain = args_for(&opts);
        assert!(!plain.iter().any(|a| a == "-m"
            || a.starts_with("model_reasoning_effort")
            || a.starts_with("service_tier")));

        opts.model = Some("gpt-6.1-sol".into());
        opts.effort = Some("xhigh".into());
        opts.fast = true;
        let args = args_for(&opts);
        assert!(args.windows(2).any(|w| w == ["-m", "gpt-6.1-sol"]));
        assert!(
            args.windows(2)
                .any(|w| w == ["-c", "model_reasoning_effort=\"xhigh\""])
        );
        assert!(
            args.windows(2)
                .any(|w| w == ["-c", "service_tier=\"fast\""])
        );
        assert_eq!(args.last().unwrap(), "-", "the prompt still comes last");
    }

    #[tokio::test]
    async fn refuses_settings_that_could_break_out_of_toml() {
        let opts = RunOptions {
            bin: "/nonexistent/codex".into(),
            cwd: "/tmp".into(),
            prompt: String::new(),
            sandbox: "read-only".into(),
            network: false,
            env: None,
            model: None,
            effort: Some("high\"\nsandbox_mode=\"danger-full-access".into()),
            fast: false,
        };
        let (tx, _rx) = mpsc::channel(1);
        let err = Run::start(&opts, tx).await.err().expect("refused");
        assert!(err.to_string().contains("refusing model setting"), "{err}");
    }
}
