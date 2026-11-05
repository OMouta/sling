//! Codex adapter. Spawns `codex exec --json`, reads its JSONL events from
//! stdout, and turns them into Sling `TaskEvent` kinds.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;
use sling_runner_protocol::{
    AgentMessage, CommandRun, FileChange, LogLine, PlanUpdate, Usage, command_run, file_change,
    log_line, plan_update, task_event::Kind,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// Command output kept per event. The tail matters more than the head.
pub const MAX_OUTPUT_BYTES: usize = 8 * 1024;

/// Codex versions this adapter has been run against.
pub const TESTED_VERSIONS: &[&str] = &["0.166.0"];

#[derive(Debug, Clone, Default)]
pub struct Detection {
    pub installed: bool,
    pub version: String,
    pub logged_in: bool,
    pub detail: String,
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
    let version = version
        .split_whitespace()
        .last()
        .unwrap_or_default()
        .to_string();
    let (logged_in, detail) = match quick(bin, &["login", "status"]).await {
        Ok(text) => {
            let line = text.lines().next().unwrap_or_default().trim().to_string();
            (line.to_lowercase().starts_with("logged in"), line)
        }
        Err(e) => (false, format!("not logged in: {e}")),
    };
    let mut detail = detail;
    if !TESTED_VERSIONS.contains(&version.as_str()) {
        detail.push_str(&format!(" (untested Codex version {version})"));
    }
    Detection {
        installed: true,
        version,
        logged_in,
        detail,
    }
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
}

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
    if opts.network && opts.sandbox == "workspace-write" {
        args.push("-c".into());
        args.push("sandbox_workspace_write.network_access=true".into());
    }
    // Prompt comes from stdin, so it never shows up in `ps`.
    args.push("-".into());
    args
}

impl Run {
    /// Starts Codex. Events arrive on `tx` until the process exits; then call
    /// `wait`.
    pub async fn start(opts: &RunOptions, tx: mpsc::Sender<Event>) -> Result<(Run, Reader)> {
        let mut cmd = Command::new(&opts.bin);
        cmd.args(args_for(opts))
            .current_dir(&opts.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(env) = &opts.env {
            cmd.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
        }
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd
            .spawn()
            .with_context(|| format!("starting {}", opts.bin))?;
        let mut stdin = child.stdin.take().context("no stdin")?;
        stdin.write_all(opts.prompt.as_bytes()).await?;
        stdin.shutdown().await?;
        drop(stdin);

        let stdout = child.stdout.take().context("no stdout")?;
        let stderr = child.stderr.take().context("no stderr")?;
        let pid = child.id();

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
/// Codex is told to leave its changes uncommitted.
pub fn build_prompt(title: &str, objective: &str, writes: bool) -> String {
    let rules = if writes {
        "- Work only inside the current directory.\n\
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
        };
        assert!(
            args_for(&opts).contains(&"sandbox_workspace_write.network_access=true".to_string())
        );
        opts.sandbox = "read-only".into();
        assert!(
            !args_for(&opts).contains(&"sandbox_workspace_write.network_access=true".to_string())
        );
        assert_eq!(args_for(&opts).last().unwrap(), "-");
    }
}
