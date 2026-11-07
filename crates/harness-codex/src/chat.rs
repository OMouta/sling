//! Chat turns: one `codex exec` turn for Sling's assistant, in an empty
//! directory outside any repo. Codex runs read-only, without your
//! `config.toml`, with its shell, image, browser, and sub-agent tools turned
//! off, web search too unless the turn has it, and with Sling's MCP server
//! added. Sling's tools run without approval.

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;

use anyhow::{Result, ensure};
use serde_json::{Value, json};
use sling_runner_protocol::{
    ChatDelta, ChatThinking, ChatToolResult, ChatToolUse, chat_event, task_event::Kind,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use crate::{Event, FAST_SERVICE_TIER, Parser, Run, Spawned, check_settings, spawn, truncate_tail};

/// Name of Sling's MCP server.
pub const MCP_SERVER: &str = "sling";
/// What Codex reports when the session to resume isn't on this machine.
const NO_SESSION: &str = "no rollout found";
/// Lines of stderr kept for error messages.
const STDERR_LINES: usize = 20;
/// Longest instructions passed as a `-c` value. Linux refuses a single
/// argument over 128 KiB; longer instructions go at the top of the prompt.
const MAX_INSTRUCTIONS_ARG: usize = 64 * 1024;

/// Codex features that give the agent tools of its own. A chat turn turns
/// them all off. Codex only warns about names it doesn't know, so this list
/// can outlive a feature.
pub const DISABLED_FEATURES: &[&str] = &[
    "shell_tool",
    "unified_exec",
    "view_image",
    "multi_agent",
    "multi_agent_v2",
    "goals",
    "apps",
    "plugins",
    "image_generation",
    "browser_use",
    "browser_use_external",
    "in_app_browser",
    "computer_use",
    "tool_suggest",
    "sleep_tool",
    "code_mode",
];

/// The MCP server Codex starts for the turn.
pub struct McpServer {
    pub command: PathBuf,
    pub args: Vec<String>,
    /// Variables Codex passes from its own environment to the server.
    /// Their values go in `ChatOptions::env`, never in a command line.
    pub env_vars: Vec<String>,
}

pub struct ChatOptions {
    pub bin: String,
    /// The turn's own empty directory.
    pub dir: PathBuf,
    /// Sent on stdin.
    pub prompt: String,
    /// Developer instructions. Codex keeps the ones a session started with.
    pub instructions: String,
    pub mcp: McpServer,
    /// Environment for Codex, including the values of `mcp.env_vars`.
    /// `None` inherits the Runner's.
    pub env: Option<Vec<(String, String)>>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: bool,
    /// Session to resume.
    pub resume: Option<String>,
    /// Codex's own live web search, which also opens pages.
    pub web: bool,
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

/// A TOML basic string, for `-c` values.
pub fn toml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn toml_array(items: &[String]) -> String {
    let items: Vec<String> = items.iter().map(|s| toml_string(s)).collect();
    format!("[{}]", items.join(","))
}

fn instructions_fit(o: &ChatOptions) -> bool {
    o.instructions.len() <= MAX_INSTRUCTIONS_ARG
}

pub fn chat_args(o: &ChatOptions) -> Vec<String> {
    let mut args: Vec<String> = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "-C",
    ]
    .map(String::from)
    .to_vec();
    args.push(o.dir.display().to_string());
    args.extend(["-s".into(), "read-only".into()]);
    let mut set = |key: &str, value: String| {
        args.push("-c".into());
        args.push(format!("{key}={value}"));
    };
    set("approval_policy", toml_string("never"));
    for feature in DISABLED_FEATURES {
        set(&format!("features.{feature}"), "false".into());
    }
    set(
        "web_search",
        toml_string(if o.web { "live" } else { "disabled" }),
    );
    // Codex's models default to no summary, so the chat would show no thinking.
    set("model_reasoning_summary", toml_string("auto"));
    if let Some(effort) = &o.effort {
        set("model_reasoning_effort", toml_string(effort));
    }
    if o.fast {
        set("service_tier", toml_string(FAST_SERVICE_TIER));
    }
    let server = format!("mcp_servers.{MCP_SERVER}");
    set(
        &format!("{server}.command"),
        toml_string(&o.mcp.command.to_string_lossy()),
    );
    set(&format!("{server}.args"), toml_array(&o.mcp.args));
    set(&format!("{server}.env_vars"), toml_array(&o.mcp.env_vars));
    // Under approval_policy "never", Codex refuses MCP calls that would need
    // approval, so Sling's tools are approved up front.
    set(
        &format!("{server}.default_tools_approval_mode"),
        toml_string("approve"),
    );
    // Longer than the bridge's own HTTP timeout, so its error arrives first.
    // A call can wait on the user's approval and then a command.
    set(&format!("{server}.tool_timeout_sec"), "720".into());
    if !o.instructions.trim().is_empty() && instructions_fit(o) {
        set("developer_instructions", toml_string(&o.instructions));
    }
    if let Some(model) = &o.model {
        args.extend(["-m".into(), model.clone()]);
    }
    if let Some(id) = &o.resume {
        args.extend(["resume".into(), id.clone()]);
    }
    // The prompt comes from stdin.
    args.push("-".into());
    args
}

/// What goes on stdin. Instructions too long for the command line go at the
/// top of a new session's first prompt.
pub fn chat_stdin(o: &ChatOptions) -> String {
    if instructions_fit(o) || o.resume.is_some() {
        o.prompt.clone()
    } else {
        format!("{}\n\n{}", o.instructions, o.prompt)
    }
}

/// How a chat turn ended.
#[derive(Debug, Default)]
pub struct ChatOutcome {
    pub exit_code: Option<i32>,
    /// The whole reply: every delta sent, in order.
    pub text: String,
    /// Codex's thread ID.
    pub session_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub failure: Option<String>,
    /// The session to resume isn't on this machine.
    pub session_missing: bool,
}

/// Turns `codex exec --json` lines into reply text and tool calls. Codex
/// sends each message whole, so each one is a delta. Messages are joined
/// with a blank line, in the deltas as well as the whole reply.
#[derive(Default)]
pub struct ChatParser {
    inner: Parser,
    text: String,
    /// Reasoning summaries sent so far.
    thought: String,
    session_id: String,
    tools_seen: HashSet<String>,
    input_tokens: u64,
    output_tokens: u64,
}

impl ChatParser {
    pub fn line(&mut self, line: &str) -> Vec<chat_event::Kind> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let item = &v["item"];
        // Codex sends a summary of its reasoning as a whole item.
        if v["type"] == "item.completed" && item["type"] == "reasoning" {
            let text = item["text"].as_str().unwrap_or_default().trim();
            if !text.is_empty() {
                let delta = if self.thought.is_empty() {
                    text.to_string()
                } else {
                    format!("\n\n{text}")
                };
                self.thought.push_str(&delta);
                out.push(chat_event::Kind::Thinking(ChatThinking { text: delta }));
            }
        }
        if matches!(v["type"].as_str(), Some("item.started" | "item.completed"))
            && item["type"] == "mcp_tool_call"
            && item["server"] == MCP_SERVER
            && self
                .tools_seen
                .insert(item["id"].as_str().unwrap_or_default().to_string())
        {
            out.push(chat_event::Kind::ToolUse(ChatToolUse {
                name: item["tool"].as_str().unwrap_or_default().to_string(),
                ..Default::default()
            }));
        }
        if v["type"] == "item.completed" && item["type"] == "web_search" {
            self.web_search(item, &mut out);
        }
        for ev in self.inner.value(&v) {
            match ev {
                Event::ThreadStarted(id) => self.session_id = id,
                Event::Task(Kind::AgentMessage(m)) if !m.text.is_empty() => {
                    let delta = if self.text.is_empty() {
                        m.text
                    } else {
                        format!("\n\n{}", m.text)
                    };
                    self.text.push_str(&delta);
                    out.push(chat_event::Kind::Delta(ChatDelta { text: delta }));
                }
                Event::Task(Kind::Usage(u)) => {
                    self.input_tokens += u.input_tokens;
                    self.output_tokens += u.output_tokens;
                }
                _ => {}
            }
        }
        out
    }

    /// A finished web search item as a step and its result, under the names
    /// and shapes every agent's web steps share. Codex reports a search's
    /// links on some versions, and never a page's text.
    fn web_search(&mut self, item: &Value, out: &mut Vec<chat_event::Kind>) {
        let action = &item["action"];
        let (name, input, output) = match (action["type"].as_str(), action["url"].as_str()) {
            (Some("search"), _) => {
                let query = action["query"].as_str().or(item["query"].as_str());
                let results: Vec<Value> = item["results"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|r| {
                        let url = r["url"].as_str()?;
                        Some(
                            json!({ "title": r["title"].as_str().unwrap_or_default(), "url": url }),
                        )
                    })
                    .collect();
                (
                    "web_search",
                    json!({ "query": query }),
                    json!({ "results": results }),
                )
            }
            (_, Some(url)) => ("web_fetch", json!({ "url": url }), json!({ "text": "" })),
            _ => return,
        };
        let id = item["id"].as_str().unwrap_or_default().to_string();
        if !self.tools_seen.insert(id.clone()) {
            return;
        }
        out.push(chat_event::Kind::ToolUse(ChatToolUse {
            name: name.into(),
            id: id.clone(),
            input_json: input.to_string(),
            builtin: true,
        }));
        out.push(chat_event::Kind::ToolResult(ChatToolResult {
            id,
            output: output.to_string(),
            error: false,
        }));
    }

    pub fn outcome(self, exit_code: Option<i32>, stderr: &[String]) -> ChatOutcome {
        let session_missing = stderr.iter().any(|l| l.to_lowercase().contains(NO_SESSION));
        // Codex can report an error and still finish the turn; only a failed
        // exit counts.
        let failure = (exit_code != Some(0)).then(|| {
            self.inner
                .failure
                .clone()
                .or_else(|| (!stderr.is_empty()).then(|| stderr.join("\n")))
                .unwrap_or_else(|| format!("Codex exited with code {exit_code:?}."))
        });
        ChatOutcome {
            exit_code,
            text: self.text,
            session_id: self.session_id,
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
    /// Starts Codex for a chat turn. Reply text and tool calls arrive on `tx`
    /// until the process exits; then call `wait`.
    pub async fn start_chat(
        o: &ChatOptions,
        tx: mpsc::Sender<chat_event::Kind>,
    ) -> Result<(Run, ChatReader)> {
        check_settings(&o.model, &o.effort)?;
        if let Some(id) = &o.resume {
            ensure!(valid_session_id(id), "refusing session ID {id:?}");
        }
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
            &chat_stdin(o),
        )
        .await?;

        let stderr_task = tokio::spawn(async move {
            let mut tail = VecDeque::new();
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() || line.starts_with("Reading additional input") {
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

    const TOKEN: &str = "tok-secret-123";

    fn opts() -> ChatOptions {
        ChatOptions {
            bin: "codex".into(),
            dir: "/data/chat/abc".into(),
            prompt: "hi".into(),
            instructions: "Be brief. Say \"hi\".\nThen stop.".into(),
            mcp: McpServer {
                command: "/opt/sling runner/sling-runner".into(),
                args: vec!["mcp".into()],
                env_vars: vec!["SLING_TOOLS_URL".into(), "SLING_TOOLS_TOKEN".into()],
            },
            env: Some(vec![("SLING_TOOLS_TOKEN".into(), TOKEN.into())]),
            model: None,
            effort: None,
            fast: false,
            resume: None,
            web: false,
        }
    }

    fn has(args: &[String], pair: [&str; 2]) -> bool {
        args.windows(2).any(|w| w == pair)
    }

    #[test]
    fn builds_a_read_only_turn_with_only_slings_tools() {
        let o = opts();
        let args = chat_args(&o);
        assert_eq!(
            &args[..7],
            [
                "exec",
                "--json",
                "--skip-git-repo-check",
                "--ignore-user-config",
                "-C",
                "/data/chat/abc",
                "-s"
            ]
        );
        assert_eq!(args[7], "read-only");
        assert!(has(&args, ["-c", "approval_policy=\"never\""]));
        assert!(has(&args, ["-c", "features.shell_tool=false"]));
        assert!(has(&args, ["-c", "features.unified_exec=false"]));
        assert!(has(&args, ["-c", "web_search=\"disabled\""]));
        assert!(has(&args, ["-c", "model_reasoning_summary=\"auto\""]));
        assert!(has(
            &args,
            [
                "-c",
                "mcp_servers.sling.command=\"/opt/sling runner/sling-runner\""
            ]
        ));
        assert!(has(&args, ["-c", "mcp_servers.sling.args=[\"mcp\"]"]));
        assert!(has(
            &args,
            [
                "-c",
                "mcp_servers.sling.env_vars=[\"SLING_TOOLS_URL\",\"SLING_TOOLS_TOKEN\"]"
            ]
        ));
        assert!(has(
            &args,
            [
                "-c",
                "mcp_servers.sling.default_tools_approval_mode=\"approve\""
            ]
        ));
        assert!(has(
            &args,
            [
                "-c",
                "developer_instructions=\"Be brief. Say \\\"hi\\\".\\nThen stop.\""
            ]
        ));
        assert!(!args.iter().any(|a| a.contains(TOKEN)), "{args:?}");
        assert!(!args.iter().any(|a| a == "resume" || a == "-m"));
        assert_eq!(args.last().unwrap(), "-");
        assert_eq!(chat_stdin(&o), "hi");
    }

    #[test]
    fn a_web_turn_turns_live_search_on() {
        let mut o = opts();
        o.web = true;
        let args = chat_args(&o);
        assert!(has(&args, ["-c", "web_search=\"live\""]));
        assert!(!has(&args, ["-c", "web_search=\"disabled\""]));
        assert!(has(&args, ["-c", "features.shell_tool=false"]));
    }

    #[test]
    fn web_search_items_become_steps() {
        let mut p = ChatParser::default();
        let mut events = Vec::new();
        for line in [
            r#"{"type":"item.started","item":{"id":"ws_1","type":"web_search","query":"","action":{"type":"other"}}}"#,
            r#"{"type":"item.completed","item":{"id":"ws_1","type":"web_search","query":"eu ai act","action":{"type":"search","query":"eu ai act"}}}"#,
            r#"{"type":"item.completed","item":{"id":"ws_2","type":"web_search","query":"","action":{"type":"open_page","url":"https://eur-lex.europa.eu/x"}}}"#,
            r#"{"type":"item.completed","item":{"id":"ws_3","type":"web_search","query":"","action":{"type":"find_in_page","url":"https://eur-lex.europa.eu/x","pattern":"Article 5"}}}"#,
            r#"{"type":"item.completed","item":{"id":"ws_4","type":"web_search","query":"","action":{"type":"other"}}}"#,
        ] {
            events.extend(p.line(line));
        }
        let steps: Vec<String> = events
            .iter()
            .map(|e| match e {
                chat_event::Kind::ToolUse(t) => {
                    format!("use {} {} {} {}", t.id, t.name, t.input_json, t.builtin)
                }
                chat_event::Kind::ToolResult(r) => format!("result {} {}", r.id, r.output),
                other => format!("{other:?}"),
            })
            .collect();
        assert_eq!(
            steps,
            [
                r#"use ws_1 web_search {"query":"eu ai act"} true"#,
                r#"result ws_1 {"results":[]}"#,
                r#"use ws_2 web_fetch {"url":"https://eur-lex.europa.eu/x"} true"#,
                r#"result ws_2 {"text":""}"#,
                r#"use ws_3 web_fetch {"url":"https://eur-lex.europa.eu/x"} true"#,
                r#"result ws_3 {"text":""}"#,
            ]
        );
    }

    #[test]
    fn passes_model_settings_and_resumes() {
        let mut o = opts();
        o.model = Some("gpt-6.1-sol".into());
        o.effort = Some("xhigh".into());
        o.fast = true;
        o.resume = Some("01a1ad94-9adb-7991-b3a8-3f052f9cc2a3".into());
        let args = chat_args(&o);
        assert!(has(&args, ["-m", "gpt-6.1-sol"]));
        assert!(has(&args, ["-c", "model_reasoning_effort=\"xhigh\""]));
        assert!(has(&args, ["-c", "service_tier=\"fast\""]));
        let n = args.len();
        assert_eq!(
            &args[n - 3..],
            ["resume", "01a1ad94-9adb-7991-b3a8-3f052f9cc2a3", "-"],
            "exec's own flags go before resume"
        );
    }

    #[test]
    fn long_instructions_go_in_a_new_sessions_prompt() {
        let mut o = opts();
        o.instructions = "x".repeat(MAX_INSTRUCTIONS_ARG + 1);
        assert!(
            !chat_args(&o)
                .iter()
                .any(|a| a.starts_with("developer_instructions="))
        );
        assert!(chat_stdin(&o).starts_with("xxx"));
        assert!(chat_stdin(&o).ends_with("\n\nhi"));
        o.resume = Some("abc".into());
        assert_eq!(chat_stdin(&o), "hi", "a session keeps its instructions");
    }

    #[test]
    fn toml_strings_round_trip() {
        for s in [
            "plain",
            "quote \" and backslash \\",
            "lines\nand\ttabs\r",
            "control \u{1} \u{7f}",
            "C:\\Program Files\\sling.exe",
            "ünïcødé ✓",
            "",
        ] {
            let doc: toml::Table = toml::from_str(&format!("v = {}", toml_string(s))).unwrap();
            assert_eq!(doc["v"].as_str(), Some(s));
        }
        let doc: toml::Table =
            toml::from_str(&format!("v = {}", toml_array(&["a\"b".into(), "c".into()]))).unwrap();
        assert_eq!(doc["v"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn session_ids_are_safe() {
        assert!(valid_session_id("01a1ad94-9adb-7991-b3a8-3f052f9cc2a3"));
        for bad in [
            "",
            "-",
            "--dangerously-bypass-approvals-and-sandbox",
            "a b",
            "a/b",
        ] {
            assert!(!valid_session_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_missing_session_and_a_failed_exit() {
        let p = ChatParser::default();
        let o = p.outcome(
            Some(1),
            &["Error: thread/resume: thread/resume failed: no rollout found for thread id abc (code -32600)".into()],
        );
        assert!(o.session_missing);
        assert!(o.failure.unwrap().contains("no rollout found"));
        let o = ChatParser::default().outcome(Some(0), &["a warning".into()]);
        assert!(o.failure.is_none());
    }

    #[test]
    fn passes_reasoning_summaries_on_as_thinking() {
        let mut p = ChatParser::default();
        let mut events = Vec::new();
        for line in [
            r#"{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Checking machines**"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"  "}}"#,
            r#"{"type":"item.completed","item":{"id":"item_2","type":"reasoning","text":"One is online."}}"#,
            r#"{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"You have one."}}"#,
        ] {
            events.extend(p.line(line));
        }
        let thought: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                chat_event::Kind::Thinking(t) => Some(t.text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(thought, ["**Checking machines**", "\n\nOne is online."]);
        assert_eq!(p.outcome(Some(0), &[]).text, "You have one.");
    }
}
