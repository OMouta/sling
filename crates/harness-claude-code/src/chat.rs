//! Chat turns: one `claude -p` turn for Sling's assistant. Claude Code gets
//! no built-in tools, only the MCP server in the turn's config, and may call
//! that server's tools without asking. A turn with web search also gets
//! `WebSearch` and `WebFetch`, which only read. Anything else is denied,
//! never prompted for.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};

use anyhow::{Result, ensure};
use base64::Engine;
use serde_json::{Value, json};
use sling_runner_protocol::{
    ChatDelta, ChatImage, ChatThinking, ChatToolResult, ChatToolUse, chat_event, task_event::Kind,
};
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
    /// Claude Code's whole system prompt, in place of its own coding-agent
    /// one, so an assistant that isn't about code isn't told it is.
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
    /// Claude Code's own web search and page reading.
    pub web: bool,
    /// Images sent with the message. With any, stdin is one stream-json
    /// message instead of plain text.
    pub images: Vec<ChatImage>,
}

/// Claude Code's built-in tools a web turn gets.
pub const WEB_TOOLS: [&str; 2] = ["WebSearch", "WebFetch"];

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
    let tools = if o.web {
        WEB_TOOLS.join(",")
    } else {
        String::new()
    };
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // No built-in tools at all: no files, no shell, and no web unless the
        // turn has it.
        "--tools",
        &tools,
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .map(String::from)
    .to_vec();
    args.push(file_arg(&o.dir, MCP_CONFIG_FILE));
    // Plain text can't carry images; a stream-json message can.
    if !o.images.is_empty() {
        args.extend(["--input-format".into(), "stream-json".into()]);
    }
    args.extend(
        [
            // A message starting with `/` is text, not a command or skill.
            "--disable-slash-commands",
            // Sling's tools run without a prompt, which print mode can't
            // answer. Everything else is denied, whatever the user's own
            // settings say.
            "--permission-mode",
            "dontAsk",
            "--allowedTools",
            "mcp__sling",
        ]
        .map(String::from),
    );
    if o.web {
        args.extend(WEB_TOOLS.map(String::from));
    }
    if !o.instructions.trim().is_empty() {
        args.push("--system-prompt-file".into());
        args.push(file_arg(&o.dir, INSTRUCTIONS_FILE));
    }
    if let Some(model) = &o.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = &o.effort {
        args.extend(["--effort".into(), effort.clone()]);
    }
    // Print mode otherwise sends thinking blocks with their text left out.
    args.extend(["--thinking-display".into(), "summarized".into()]);
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

/// Stdin for a turn: the prompt as text, or, with images, one stream-json
/// user message holding the prompt and an image block for each.
pub fn chat_input(o: &ChatOptions) -> String {
    if o.images.is_empty() {
        return chat_stdin(&o.prompt);
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut content = Vec::with_capacity(o.images.len() + 1);
    if !o.prompt.trim().is_empty() {
        content.push(json!({ "type": "text", "text": chat_stdin(&o.prompt) }));
    }
    for image in &o.images {
        content.push(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": image.media_type,
                "data": b64.encode(&image.data),
            },
        }));
    }
    let message = json!({
        "type": "user",
        "message": { "role": "user", "content": content },
        "parent_tool_use_id": null,
        "session_id": "",
    });
    format!("{message}\n")
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
    /// Thinking sent so far, and whether the next piece starts a new block.
    thought: String,
    new_thought: bool,
    /// Built-in web tools called and not yet answered, by tool use ID.
    web_calls: HashSet<String>,
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
            "user" if top_level => self.tool_results(&v, &mut out),
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
            "content_block_start" if e["content_block"]["type"] == "thinking" => {
                self.new_thought = true;
            }
            "content_block_delta" if e["delta"]["type"] == "text_delta" => {
                self.push(e["delta"]["text"].as_str().unwrap_or_default(), out);
            }
            "content_block_delta" if e["delta"]["type"] == "thinking_delta" => {
                self.think(e["delta"]["thinking"].as_str().unwrap_or_default(), out);
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
                        out.push(chat_event::Kind::ToolUse(ChatToolUse {
                            name: tool.into(),
                            ..Default::default()
                        }));
                    } else if let Some(tool) = self.web_call(block) {
                        out.push(chat_event::Kind::ToolUse(tool));
                    }
                }
                "text" if !self.streaming => {
                    self.new_block = true;
                    self.push(block["text"].as_str().unwrap_or_default(), out);
                }
                "thinking" if !self.streaming => {
                    self.new_thought = true;
                    self.think(block["thinking"].as_str().unwrap_or_default(), out);
                }
                _ => {}
            }
        }
    }

    /// A `WebSearch` or `WebFetch` call, under the names and inputs every
    /// agent's web steps share.
    fn web_call(&mut self, block: &Value) -> Option<ChatToolUse> {
        let input = &block["input"];
        let (name, input) = match block["name"].as_str()? {
            "WebSearch" => ("web_search", json!({ "query": input["query"] })),
            "WebFetch" => ("web_fetch", json!({ "url": input["url"] })),
            _ => return None,
        };
        let id = block["id"].as_str().unwrap_or_default().to_string();
        if !self.web_calls.insert(id.clone()) {
            return None;
        }
        Some(ChatToolUse {
            name: name.into(),
            id,
            input_json: input.to_string(),
            builtin: true,
        })
    }

    /// Results of the web calls, which come back in a user message.
    fn tool_results(&mut self, v: &Value, out: &mut Vec<chat_event::Kind>) {
        let Some(content) = v["message"]["content"].as_array() else {
            return;
        };
        for block in content {
            let id = block["tool_use_id"].as_str().unwrap_or_default();
            if block["type"] != "tool_result" || !self.web_calls.remove(id) {
                continue;
            }
            let text = result_text(&block["content"]);
            let error = block["is_error"].as_bool().unwrap_or(false);
            let output = if error {
                text
            } else if let Some(results) = search_links(&text) {
                json!({ "results": results }).to_string()
            } else {
                json!({ "text": text }).to_string()
            };
            out.push(chat_event::Kind::ToolResult(ChatToolResult {
                id: id.into(),
                output,
                error,
            }));
        }
    }

    fn think(&mut self, text: &str, out: &mut Vec<chat_event::Kind>) {
        if text.is_empty() {
            return;
        }
        let mut delta = String::new();
        if self.new_thought && !self.thought.is_empty() {
            delta.push_str("\n\n");
        }
        self.new_thought = false;
        delta.push_str(text);
        self.thought.push_str(&delta);
        out.push(chat_event::Kind::Thinking(ChatThinking { text: delta }));
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

/// A tool result's content: a string, or text blocks.
fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The links in a `WebSearch` result, whose text has them as a JSON array
/// after `Links: `, as `{ title, url }`.
fn search_links(text: &str) -> Option<Vec<Value>> {
    if !text.starts_with("Web search results for query:") {
        return None;
    }
    let start = text.find("Links: ")? + "Links: ".len();
    let links = serde_json::Deserializer::from_str(&text[start..])
        .into_iter::<Vec<Value>>()
        .next()?
        .ok()?;
    Some(
        links
            .iter()
            .filter_map(|l| {
                let url = l["url"].as_str()?;
                Some(json!({ "title": l["title"].as_str().unwrap_or_default(), "url": url }))
            })
            .collect(),
    )
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
            &chat_input(o),
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
            web: false,
            images: Vec::new(),
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
                "--system-prompt-file",
                "/data/chat/abc/sling-instructions.md"
            ]));
        assert!(
            !args
                .iter()
                .any(|a| a == "--model" || a == "--effort" || a == "--resume")
        );
        assert!(!args.iter().any(|a| a.contains("tok-secret-123")));
        assert!(!args.iter().any(|a| a.contains("Be brief")));
        assert!(
            args.windows(2)
                .any(|w| w == ["--thinking-display", "summarized"])
        );
        assert!(!args.iter().any(|a| a == "--settings"));
        assert!(!args.iter().any(|a| a == "--input-format"));

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
        assert!(!args.contains(&"--system-prompt-file".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("--append-system-prompt")));
    }

    #[test]
    fn a_web_turn_gets_only_the_web_tools_too() {
        let mut o = opts();
        o.web = true;
        let args = chat_args(&o);
        assert!(
            args.windows(2)
                .any(|w| w == ["--tools", "WebSearch,WebFetch"])
        );
        let allowed = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert_eq!(
            &args[allowed..allowed + 5],
            [
                "--allowedTools",
                "mcp__sling",
                "WebSearch",
                "WebFetch",
                "--system-prompt-file"
            ],
            "the list ends at the next flag"
        );
        o.web = false;
        let args = chat_args(&o);
        assert!(!args.iter().any(|a| a.contains("WebSearch")));
    }

    #[test]
    fn web_calls_and_their_results() {
        let mut p = ChatParser::default();
        let mut events = Vec::new();
        for line in [
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"WebSearch","input":{"query":"rust release","mode":"standard"}}]},"parent_tool_use_id":null}"#,
            // Repeated whole messages don't repeat the step.
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"WebSearch","input":{"query":"rust release"}}]},"parent_tool_use_id":null}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"Web search results for query: \"rust release\"\n\nLinks: [{\"title\":\"Rust 1.99\",\"url\":\"https://blog.rust-lang.org/\"},{\"title\":\"x\"}]\n\nRust 1.99 is out. [See](https://x.test)"}]},"parent_tool_use_id":null}"#,
            r#"{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t2","name":"WebFetch","input":{"url":"https://blog.rust-lang.org/","prompt":"Which version?"}}]},"parent_tool_use_id":null}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t2","type":"tool_result","is_error":true,"content":[{"type":"text","text":"Request failed with status code 404"}]}]},"parent_tool_use_id":null}"#,
            // A sub-agent's calls and results of other tools aren't steps.
            r#"{"type":"assistant","message":{"id":"m3","content":[{"type":"tool_use","id":"t3","name":"WebSearch","input":{"query":"sub"}}]},"parent_tool_use_id":"t9"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t8","type":"tool_result","content":"other"}]},"parent_tool_use_id":null}"#,
        ] {
            events.extend(p.line(line));
        }
        let uses: Vec<(&str, &str, &str, bool)> = events
            .iter()
            .filter_map(|e| match e {
                chat_event::Kind::ToolUse(t) => Some((
                    t.name.as_str(),
                    t.id.as_str(),
                    t.input_json.as_str(),
                    t.builtin,
                )),
                _ => None,
            })
            .collect();
        assert_eq!(
            uses,
            [
                ("web_search", "t1", r#"{"query":"rust release"}"#, true),
                (
                    "web_fetch",
                    "t2",
                    r#"{"url":"https://blog.rust-lang.org/"}"#,
                    true
                ),
            ]
        );
        let results: Vec<&ChatToolResult> = events
            .iter()
            .filter_map(|e| match e {
                chat_event::Kind::ToolResult(r) => Some(r),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, "t1");
        assert_eq!(
            serde_json::from_str::<Value>(&results[0].output).unwrap(),
            json!({ "results": [{ "title": "Rust 1.99", "url": "https://blog.rust-lang.org/" }] })
        );
        assert!(!results[0].error);
        assert_eq!(
            (
                results[1].id.as_str(),
                results[1].output.as_str(),
                results[1].error
            ),
            ("t2", "Request failed with status code 404", true)
        );
    }

    #[test]
    fn a_fetch_result_is_its_text() {
        let mut p = ChatParser::default();
        p.line(r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"WebFetch","input":{"url":"https://a.test/"}}]},"parent_tool_use_id":null}"#);
        let events = p.line(r#"{"type":"user","message":{"content":[{"tool_use_id":"t1","type":"tool_result","content":"Links: [] is not a search"}]},"parent_tool_use_id":null}"#);
        let chat_event::Kind::ToolResult(r) = &events[0] else {
            panic!("{events:?}");
        };
        assert_eq!(
            serde_json::from_str::<Value>(&r.output).unwrap(),
            json!({ "text": "Links: [] is not a search" })
        );
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
        assert_eq!(chat_input(&opts()), "hi");
    }

    #[test]
    fn images_go_on_stdin_as_one_stream_json_message() {
        let mut o = opts();
        o.prompt = "/what is this?".into();
        o.images = vec![
            ChatImage {
                name: "sign.png".into(),
                media_type: "image/png".into(),
                data: vec![1, 2, 3],
            },
            ChatImage {
                name: "lease.jpg".into(),
                media_type: "image/jpeg".into(),
                data: b"hi".to_vec(),
            },
        ];
        assert!(
            chat_args(&o)
                .windows(2)
                .any(|w| w == ["--input-format", "stream-json"])
        );
        let input = chat_input(&o);
        assert!(input.ends_with('\n') && input.lines().count() == 1);
        let v: Value = serde_json::from_str(input.trim()).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(
            v["message"]["content"],
            json!([
                { "type": "text", "text": " /what is this?" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AQID" } },
                { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "aGk=" } },
            ])
        );
        // An image alone has no text block.
        o.prompt = String::new();
        let v: Value = serde_json::from_str(chat_input(&o).trim()).unwrap();
        assert_eq!(v["message"]["content"].as_array().unwrap().len(), 2);
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

    fn settings_of(args: &[String]) -> Value {
        let i = args
            .iter()
            .position(|a| a == "--settings")
            .expect("--settings");
        serde_json::from_str(&args[i + 1]).unwrap()
    }

    #[test]
    fn turns_on_fast_mode_for_opus_only() {
        let mut o = opts();
        o.fast = true;
        o.model = Some("claude-opus-5-5".into());
        assert_eq!(settings_of(&chat_args(&o)), json!({ "fastMode": true }));
        o.model = Some("claude-haiku-5-5".into());
        assert!(!chat_args(&o).iter().any(|a| a == "--settings"));
    }

    #[test]
    fn passes_thinking_on_as_it_streams() {
        let mut p = ChatParser::default();
        let mut events = Vec::new();
        for line in [
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}},"parent_tool_use_id":null}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user wants "}},"parent_tool_use_id":null}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"their machines."}},"parent_tool_use_id":null}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}},"parent_tool_use_id":null}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"One is online."}},"parent_tool_use_id":null}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"sub"}},"parent_tool_use_id":"t9"}"#,
            // The whole message repeats it, and isn't sent twice.
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"thinking","thinking":"The user wants their machines."}]},"parent_tool_use_id":null}"#,
        ] {
            events.extend(p.line(line));
        }
        let thought: String = events
            .iter()
            .filter_map(|e| match e {
                chat_event::Kind::Thinking(t) => Some(t.text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(thought, "The user wants their machines.\n\nOne is online.");
        assert_eq!(deltas(&events), "");

        // Without partial messages, whole thinking blocks stand in.
        let mut p = ChatParser::default();
        let events = p.line(
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"thinking","thinking":"Plan it."},{"type":"text","text":"Done."}]},"parent_tool_use_id":null}"#,
        );
        assert!(matches!(&events[0], chat_event::Kind::Thinking(t) if t.text == "Plan it."));
        assert_eq!(deltas(&events), "Done.");
    }
}
