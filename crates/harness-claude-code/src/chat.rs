//! Chat turns: one `claude -p` turn for Sling's assistant. Claude Code gets
//! no built-in tools, only the MCP server in the turn's config, and may call
//! that server's tools without asking. Anything else is denied, never
//! prompted for.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use anyhow::{Result, ensure};
use serde_json::{Value, json};
use sling_runner_protocol::{ChatDelta, ChatToolUse, chat_event, task_event::Kind};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use crate::{Event, Parser, Run, Spawned, spawn, truncate_tail};

/// Name of Sling's MCP server. Claude Code calls its tools
/// `mcp__sling__<tool>`.
pub const MCP_SERVER: &str = "sling";
/// Written in the turn's directory, readable only by this user.
pub const MCP_CONFIG_FILE: &str = "sling-mcp.json";
pub const INSTRUCTIONS_FILE: &str = "sling-instructions.md";
/// What Claude Code reports when the session to resume isn't on this
/// machine.
const NO_SESSION: &str = "No conversation found with session ID";
/// Lines of stderr kept for error messages.
const STDERR_LINES: usize = 20;

/// The MCP server Claude Code starts for the turn.
pub struct McpServer {
    pub command: PathBuf,
    pub args: Vec<String>,
    /// Environment for the server alone. It goes in the config file, so it
    /// never shows up in a command line.
    pub env: Vec<(String, String)>,
}

pub struct ChatOptions {
    pub bin: String,
    /// The turn's own empty directory. The MCP config and instructions are
    /// written here.
    pub dir: PathBuf,
    /// Sent on stdin.
    pub prompt: String,
    /// Appended to Claude Code's system prompt.
    pub instructions: String,
    pub mcp: McpServer,
    /// Environment for Claude Code. `None` inherits the Runner's.
    pub env: Option<Vec<(String, String)>>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Fast mode, for a model that has it.
    pub fast: bool,
    /// Session to resume.
    pub resume: Option<String>,
}

/// Session IDs are UUIDs. Anything else is refused, so an ID can never pass
/// as a flag.
pub fn valid_session_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

fn file_arg(dir: &Path, name: &str) -> String {
    dir.join(name).display().to_string()
}

pub fn chat_args(o: &ChatOptions) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // No built-in tools at all: no files, no shell, no web.
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .map(String::from)
    .to_vec();
    args.push(file_arg(&o.dir, MCP_CONFIG_FILE));
    args.extend(
        [
            // Sling's tools run without a prompt, which print mode can't
            // answer. Everything else is denied, whatever the user's own
            // settings say.
            "--permission-mode",
            "dontAsk",
            "--allowedTools",
            "mcp__sling",
            // A message starting with `/` is text, not a command or skill.
            "--disable-slash-commands",
        ]
        .map(String::from),
    );
    if !o.instructions.trim().is_empty() {
        args.push("--append-system-prompt-file".into());
        args.push(file_arg(&o.dir, INSTRUCTIONS_FILE));
    }
    if let Some(model) = &o.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = &o.effort {
        args.extend(["--effort".into(), effort.clone()]);
    }
    if o.fast && crate::has_fast(o.model.as_deref()) {
        args.extend(["--settings".into(), json!({ "fastMode": true }).to_string()]);
    }
    if let Some(id) = &o.resume {
        args.extend(["--resume".into(), id.clone()]);
    }
    args
}

/// The `--mcp-config` file.
pub fn mcp_config(m: &McpServer) -> Value {
    let env: serde_json::Map<String, Value> = m
        .env
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    json!({ "mcpServers": { MCP_SERVER: {
        "type": "stdio",
        "command": m.command.to_string_lossy(),
        "args": m.args,
        "env": env,
    }}})
}

/// What goes on stdin. Claude Code reads a message that starts with `/` as
/// a command even with commands turned off, and then never sends it to the
/// model. A leading space keeps it a message.
pub fn chat_stdin(prompt: &str) -> String {
    if prompt.starts_with('/') {
        format!(" {prompt}")
    } else {
        prompt.to_string()
    }
}

fn write_private(path: &Path, text: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(text.as_bytes())?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, text)?;
    Ok(())
}

/// How a chat turn ended.
#[derive(Debug, Default)]
pub struct ChatOutcome {
    pub exit_code: Option<i32>,
    /// The whole reply: every delta sent, in order.
    pub text: String,
    pub session_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub failure: Option<String>,
    /// The session to resume isn't on this machine.
    pub session_missing: bool,
}

/// Turns stream-json lines into reply text and tool calls. Text comes from
/// the partial messages as it streams, or from whole messages if Claude Code
/// sends no partial ones. Text blocks are joined with a blank line, in the
/// deltas as well as the whole reply.
#[derive(Default)]
pub struct ChatParser {
    inner: Parser,
    text: String,
    streaming: bool,
    new_block: bool,
    input_tokens: u64,
    output_tokens: u64,
}

impl ChatParser {
    pub fn line(&mut self, line: &str) -> Vec<chat_event::Kind> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let top_level = v["parent_tool_use_id"].is_null();
        let mut out = Vec::new();
        match v["type"].as_str().unwrap_or_default() {
            "stream_event" if top_level => self.stream_event(&v["event"], &mut out),
            "assistant" if top_level => self.assistant(&v, &mut out),
            _ => {}
        }
        for ev in self.inner.value(&v) {
            if let Event::Task(Kind::Usage(u)) = ev {
                self.input_tokens = u.input_tokens;
                self.output_tokens = u.output_tokens;
            }
        }
        out
    }

    fn stream_event(&mut self, e: &Value, out: &mut Vec<chat_event::Kind>) {
        self.streaming = true;
        match e["type"].as_str().unwrap_or_default() {
            "content_block_start" if e["content_block"]["type"] == "text" => {
                self.new_block = true;
            }
            "content_block_delta" if e["delta"]["type"] == "text_delta" => {
                self.push(e["delta"]["text"].as_str().unwrap_or_default(), out);
            }
            _ => {}
        }
    }

    fn assistant(&mut self, v: &Value, out: &mut Vec<chat_event::Kind>) {
        let Some(content) = v["message"]["content"].as_array() else {
            return;
        };
        for block in content {
            match block["type"].as_str().unwrap_or_default() {
                "tool_use" => {
                    let name = block["name"].as_str().unwrap_or_default();
                    if let Some(tool) = name.strip_prefix("mcp__sling__") {
                        out.push(chat_event::Kind::ToolUse(ChatToolUse { name: tool.into() }));
                    }
                }
                "text" if !self.streaming => {
                    self.new_block = true;
                    self.push(block["text"].as_str().unwrap_or_default(), out);
                }
                _ => {}
            }
        }
    }

    fn push(&mut self, text: &str, out: &mut Vec<chat_event::Kind>) {
        if text.is_empty() {
            return;
        }
        let mut delta = String::new();
        if self.new_block && !self.text.is_empty() {
            delta.push_str("\n\n");
        }
        self.new_block = false;
        delta.push_str(text);
        self.text.push_str(&delta);
        out.push(chat_event::Kind::Delta(ChatDelta { text: delta }));
    }

    pub fn outcome(self, exit_code: Option<i32>, stderr: &[String]) -> ChatOutcome {
        let session_id = self.inner.session_id.clone();
        let saw_result = self.inner.saw_result;
        let o = self.inner.outcome(exit_code);
        let mut failure = o.failure;
        if !saw_result && !stderr.is_empty() {
            failure = Some(format!(
                "Claude Code ended without a reply: {}",
                stderr.join("\n")
            ));
        } else if failure.is_none() && exit_code != Some(0) {
            failure = Some(format!("Claude Code exited with code {exit_code:?}."));
        }
        let session_missing = failure.as_deref().is_some_and(|f| f.contains(NO_SESSION))
            || stderr.iter().any(|l| l.contains(NO_SESSION));
        let text = if self.text.is_empty() && failure.is_none() {
            o.summary
        } else {
            self.text
        };
        ChatOutcome {
            exit_code,
            text,
            session_id,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            failure,
            session_missing,
        }
    }
}

pub struct ChatReader {
    stdout_task: tokio::task::JoinHandle<ChatParser>,
    stderr_task: tokio::task::JoinHandle<Vec<String>>,
}

impl ChatReader {
    /// Waits for the output streams to close and returns how the turn ended.
    pub async fn finish(self, exit_code: Option<i32>) -> ChatOutcome {
        let parser = self.stdout_task.await.unwrap_or_default();
        let stderr = self.stderr_task.await.unwrap_or_default();
        parser.outcome(exit_code, &stderr)
    }
}

impl Run {
    /// Writes the turn's files and starts Claude Code. Reply text and tool
    /// calls arrive on `tx` until the process exits; then call `wait`.
    pub async fn start_chat(
        o: &ChatOptions,
        tx: mpsc::Sender<chat_event::Kind>,
    ) -> Result<(Run, ChatReader)> {
        if let Some(id) = &o.resume {
            ensure!(valid_session_id(id), "refusing session ID {id:?}");
        }
        write_private(
            &o.dir.join(MCP_CONFIG_FILE),
            &mcp_config(&o.mcp).to_string(),
        )?;
        write_private(&o.dir.join(INSTRUCTIONS_FILE), &o.instructions)?;
        let Spawned {
            child,
            pid,
            stdout,
            stderr,
        } = spawn(
            &o.bin,
            &chat_args(o),
            &o.dir,
            o.env.as_deref(),
            &chat_stdin(&o.prompt),
        )
        .await?;

        let stderr_task = tokio::spawn(async move {
            let mut tail = VecDeque::new();
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                if tail.len() == STDERR_LINES {
                    tail.pop_front();
                }
                tail.push_back(truncate_tail(line.trim(), 500));
            }
            tail.into()
        });
        let stdout_task = tokio::spawn(async move {
            let mut parser = ChatParser::default();
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
            ChatReader {
                stdout_task,
                stderr_task,
            },
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> ChatOptions {
        ChatOptions {
            bin: "claude".into(),
            dir: "/data/chat/abc".into(),
            prompt: "hi".into(),
            instructions: "Be brief.".into(),
            mcp: McpServer {
                command: "/usr/local/bin/sling-runner".into(),
                args: vec!["mcp".into()],
                env: vec![
                    (
                        "SLING_TOOLS_URL".into(),
                        "https://sling.test/api/tools".into(),
                    ),
                    ("SLING_TOOLS_TOKEN".into(), "tok-secret-123".into()),
                ],
            },
            env: None,
            model: None,
            effort: None,
            fast: false,
            resume: None,
        }
    }

    #[test]
    fn builds_a_turn_with_only_slings_tools() {
        let mut o = opts();
        let args = chat_args(&o);
        assert_eq!(
            &args[..5],
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages"
            ]
        );
        assert!(args.windows(2).any(|w| w == ["--tools", ""]));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert!(
            args.windows(2)
                .any(|w| w == ["--mcp-config", "/data/chat/abc/sling-mcp.json"])
        );
        assert!(
            args.windows(2)
                .any(|w| w == ["--permission-mode", "dontAsk"])
        );
        assert!(
            args.windows(2)
                .any(|w| w == ["--allowedTools", "mcp__sling"])
        );
        assert!(args.contains(&"--disable-slash-commands".to_string()));
        assert!(args.windows(2).any(|w| w
            == [
                "--append-system-prompt-file",
                "/data/chat/abc/sling-instructions.md"
            ]));
        assert!(
            !args
                .iter()
                .any(|a| a == "--model" || a == "--effort" || a == "--resume")
        );
        assert!(!args.iter().any(|a| a.contains("tok-secret-123")));
        assert!(!args.iter().any(|a| a.contains("Be brief")));
        assert!(!args.iter().any(|a| a == "--settings"));

        o.model = Some("claude-haiku-5-5".into());
        o.effort = Some("low".into());
        o.resume = Some("6f1b2c3d-1111-4222-8333-444455556666".into());
        o.instructions = String::new();
        let args = chat_args(&o);
        assert!(
            args.windows(2)
                .any(|w| w == ["--model", "claude-haiku-5-5"])
        );
        assert!(args.windows(2).any(|w| w == ["--effort", "low"]));
        assert!(
            args.windows(2)
                .any(|w| w == ["--resume", "6f1b2c3d-1111-4222-8333-444455556666"])
        );
        assert!(!args.contains(&"--append-system-prompt-file".to_string()));
    }

    #[test]
    fn the_token_goes_in_the_mcp_config() {
        let config = mcp_config(&opts().mcp);
        let sling = &config["mcpServers"]["sling"];
        assert_eq!(sling["type"], "stdio");
        assert_eq!(sling["command"], "/usr/local/bin/sling-runner");
        assert_eq!(sling["args"], json!(["mcp"]));
        assert_eq!(sling["env"]["SLING_TOOLS_TOKEN"], "tok-secret-123");
        assert_eq!(
            sling["env"]["SLING_TOOLS_URL"],
            "https://sling.test/api/tools"
        );
    }

    #[test]
    fn a_leading_slash_stays_a_message() {
        assert_eq!(chat_stdin("/cost"), " /cost");
        assert_eq!(chat_stdin("hi /cost"), "hi /cost");
    }

    #[test]
    fn session_ids_are_safe() {
        assert!(valid_session_id("6f1b2c3d-1111-4222-8333-444455556666"));
        for bad in [
            "",
            "-r",
            "--dangerously-skip-permissions",
            "a b",
            "a/b",
            "é",
        ] {
            assert!(!valid_session_id(bad), "{bad:?}");
        }
        assert!(!valid_session_id(&"a".repeat(65)));
    }

    fn deltas(events: &[chat_event::Kind]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                chat_event::Kind::Delta(d) => Some(d.text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn whole_messages_stand_in_when_nothing_streams() {
        let mut p = ChatParser::default();
        let mut events = Vec::new();
        for line in [
            r#"{"type":"system","subtype":"init","session_id":"s-1","model":"m"}"#,
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Checking."},{"type":"tool_use","id":"t1","name":"mcp__sling__list_machines","input":{}}]},"parent_tool_use_id":null}"#,
            r#"{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t2","name":"mcp__other__x","input":{}}]},"parent_tool_use_id":null}"#,
            r#"{"type":"assistant","message":{"id":"m3","content":[{"type":"text","text":"sub-agent text"}]},"parent_tool_use_id":"t9"}"#,
            r#"{"type":"assistant","message":{"id":"m4","content":[{"type":"text","text":"You have two."}]},"parent_tool_use_id":null}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"You have two.","session_id":"s-1","usage":{"input_tokens":3,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"output_tokens":7}}"#,
        ] {
            events.extend(p.line(line));
        }
        let tools: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                chat_event::Kind::ToolUse(t) => Some(t.name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(tools, ["list_machines"], "only Sling's tools count");
        assert_eq!(deltas(&events), "Checking.\n\nYou have two.");
        let o = p.outcome(Some(0), &[]);
        assert_eq!(o.text, "Checking.\n\nYou have two.");
        assert_eq!(o.session_id, "s-1");
        assert_eq!((o.input_tokens, o.output_tokens), (33, 7));
        assert!(o.failure.is_none() && !o.session_missing);
    }

    #[test]
    fn a_crash_reports_stderr() {
        let p = ChatParser::default();
        let o = p.outcome(Some(1), &["error: unknown option '--nope'".into()]);
        assert_eq!(
            o.failure.as_deref(),
            Some("Claude Code ended without a reply: error: unknown option '--nope'")
        );
        assert!(!o.session_missing);
    }

    #[test]
    fn turns_on_fast_mode_for_opus_only() {
        let mut o = opts();
        o.fast = true;
        o.model = Some("claude-opus-5-5".into());
        assert!(
            chat_args(&o)
                .windows(2)
                .any(|w| w == ["--settings", r#"{"fastMode":true}"#])
        );
        o.model = Some("claude-haiku-5-5".into());
        assert!(!chat_args(&o).iter().any(|a| a == "--settings"));
    }
}
