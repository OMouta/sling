//! A stand-in for the `claude` CLI, for tests and local development without a
//! Claude Code login. Point the Runner at it with `claude_bin` in runner.toml.
//!
//! It answers `--version`, `auth status`, and `-p --output-format
//! stream-json ...`, printing the same stream-json shapes as real Claude Code.
//! It takes `--model` and `--effort`, and reports the model in its init
//! event the way Claude Code does. Pick a scenario with `FAKE_CLAUDE_SCENARIO`, or put `[fake:<scenario>]` in
//! the prompt:
//!
//! - `success` (default): writes `SLING_FAKE.md`, runs a command, finishes.
//! - `noop`: finishes without changing anything.
//! - `fail`: reports an error result and exits 1.
//! - `hang`: starts, then waits until interrupted. On SIGINT it reports an
//!   aborted result and exits 0, like real Claude Code.
//! - `crash`: exits with code 101 after the first event.
//! - `env`: like `success`, and also reports which sensitive environment
//!   variables it can see.
//!
//! With `--mcp-config` it runs a chat turn instead: no repo, no file
//! changes, just a reply that names the session, whether it got
//! instructions, its working directory, and the prompt. Sessions are kept
//! as files under `FAKE_CLAUDE_SESSIONS` (by default a directory in the temp
//! dir), and `--resume` of one that isn't there fails the way Claude Code
//! does. Chat scenarios:
//!
//! - default: replies.
//! - `tool`: starts the `sling` MCP server from the config, lists its tools,
//!   calls the first one with no arguments, and replies with the result. The
//!   call is denied unless `--permission-mode dontAsk --allowedTools
//!   mcp__sling` allow it, as in Claude Code's print mode.
//! - `hang`, `fail`: as above.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

const VERSION: &str = "2.1.318";
const SESSION: &str = "00000000-0000-4000-8000-000000000000";

static INTERRUPTED: AtomicBool = AtomicBool::new(false);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version" | "-v") => println!("{VERSION} (Claude Code)"),
        Some("auth") => auth(),
        _ if args.iter().any(|a| a == "-p" || a == "--print") => print(&args),
        _ => {
            eprintln!("fake-claude: unsupported arguments {args:?}");
            std::process::exit(2);
        }
    }
}

fn auth() {
    if std::env::var_os("FAKE_CLAUDE_LOGGED_OUT").is_some() {
        println!(
            "{}",
            json!({"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"})
        );
        std::process::exit(1);
    }
    println!(
        "{}",
        json!({"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty"})
    );
}

fn print(args: &[String]) {
    if args.iter().any(|a| a == "--mcp-config") {
        return chat(args);
    }
    let mode = if args.iter().any(|a| a == "--dangerously-skip-permissions") {
        "bypassPermissions".to_string()
    } else {
        args.iter()
            .position(|a| a == "--permission-mode")
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| "default".into())
    };
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let model = flag("--model").unwrap_or_else(|| "claude-fake".into());
    if let Some(effort) = flag("--effort")
        && !["low", "medium", "high", "xhigh", "max"].contains(&effort.as_str())
    {
        eprintln!("fake-claude: unknown effort {effort:?}");
        std::process::exit(1);
    }
    let cwd = std::env::current_dir().unwrap();
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).unwrap();

    let scenario = prompt
        .split("[fake:")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .map(str::to_string)
        .or_else(|| std::env::var("FAKE_CLAUDE_SCENARIO").ok())
        .unwrap_or_else(|| "success".into());
    let delay = std::env::var("FAKE_CLAUDE_DELAY_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(150);
    let pause = || std::thread::sleep(Duration::from_millis(delay));
    let emit = |v: Value| {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{v}").unwrap();
        out.flush().unwrap();
    };
    let mut msg = 0;
    let mut text = |t: &str| {
        msg += 1;
        json!({"type": "assistant", "message": {"id": format!("msg_fake_{msg}"), "type": "message", "role": "assistant", "model": model, "content": [{"type": "text", "text": t}]}, "parent_tool_use_id": null, "session_id": SESSION})
    };

    emit(json!({
        "type": "system", "subtype": "init", "cwd": cwd.display().to_string(), "session_id": SESSION,
        "tools": ["Bash", "Edit", "Read", "Write"], "mcp_servers": [], "model": model,
        "permissionMode": mode, "apiKeySource": "none", "claude_code_version": VERSION,
    }));
    pause();

    match scenario.as_str() {
        "crash" => {
            eprintln!("fake-claude: crashing on purpose");
            std::process::exit(101);
        }
        "hang" => {
            #[cfg(unix)]
            // SAFETY: the handler only stores to an atomic.
            unsafe {
                libc::signal(libc::SIGINT, on_sigint as *const () as libc::sighandler_t);
            }
            emit(text("Working on it."));
            while !INTERRUPTED.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(20));
            }
            emit(result(true, "error_during_execution", "", 0));
            std::process::exit(0);
        }
        "fail" => {
            emit(text("fake-claude was told to fail"));
            let mut r = result(true, "success", "fake-claude was told to fail", 0);
            r["api_error_status"] = json!(500);
            emit(r);
            std::process::exit(1);
        }
        _ => {}
    }

    emit(text("I'll make the change and run the tests."));
    pause();

    if scenario == "env" {
        let mut seen: Vec<String> = std::env::vars()
            .map(|(k, _)| k)
            .filter(|k| {
                k.starts_with("SLING_")
                    || matches!(
                        k.as_str(),
                        "GH_TOKEN" | "GITHUB_TOKEN" | "OPENAI_API_KEY" | "ANTHROPIC_API_KEY"
                    )
            })
            .collect();
        seen.sort();
        emit(text(&format!(
            "Sensitive environment: [{}]",
            seen.join(",")
        )));
    }

    let writes = mode != "plan" && scenario != "noop";
    if writes {
        let file: PathBuf = cwd.join("SLING_FAKE.md");
        let existed = file.exists();
        let title = prompt
            .lines()
            .find_map(|l| l.strip_prefix("Task: "))
            .unwrap_or("task");
        let mut body = std::fs::read_to_string(&file).unwrap_or_default();
        body.push_str(&format!("- {title}\n"));
        let path = file.display().to_string();
        emit(
            json!({"type": "assistant", "message": {"id": "msg_fake_w", "type": "message", "role": "assistant", "model": model, "content": [{"type": "tool_use", "id": "toolu_fake_write", "name": "Write", "input": {"file_path": path, "content": body}}]}, "parent_tool_use_id": null, "session_id": SESSION}),
        );
        std::fs::write(&file, &body).unwrap();
        emit(json!({
            "type": "user",
            "message": {"role": "user", "content": [{"tool_use_id": "toolu_fake_write", "type": "tool_result", "content": format!("File created successfully at: {path}")}]},
            "parent_tool_use_id": null, "session_id": SESSION,
            "tool_use_result": {"type": if existed { "update" } else { "create" }, "filePath": path, "content": body, "structuredPatch": [], "originalFile": if existed { Value::String(String::new()) } else { Value::Null }},
        }));
    }
    pause();

    emit(
        json!({"type": "assistant", "message": {"id": "msg_fake_b", "type": "message", "role": "assistant", "model": model, "content": [{"type": "tool_use", "id": "toolu_fake_bash", "name": "Bash", "input": {"command": "echo tests", "description": "Run the tests"}}]}, "parent_tool_use_id": null, "session_id": SESSION}),
    );
    pause();
    emit(json!({
        "type": "user",
        "message": {"role": "user", "content": [{"tool_use_id": "toolu_fake_bash", "type": "tool_result", "content": "3 passed", "is_error": false}]},
        "parent_tool_use_id": null, "session_id": SESSION,
        "tool_use_result": {"stdout": "3 passed", "stderr": "", "interrupted": false, "isImage": false},
    }));
    let summary = if writes {
        "Updated SLING_FAKE.md. Tests: 3 passed."
    } else {
        "Looked around and changed nothing."
    };
    emit(text(summary));
    emit(result(false, "success", summary, 4));
}

fn result(is_error: bool, subtype: &str, text: &str, turns: u32) -> Value {
    json!({
        "type": "result", "subtype": subtype, "is_error": is_error, "num_turns": turns,
        "result": text, "session_id": SESSION, "stop_reason": "end_turn",
        "terminal_reason": if is_error { "aborted_streaming" } else { "completed" },
        "permission_denials": [], "api_error_status": null, "total_cost_usd": 0.01,
        "usage": {"input_tokens": 12, "cache_creation_input_tokens": 400, "cache_read_input_tokens": 800, "output_tokens": 90},
    })
}

fn emit(v: Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{v}").unwrap();
    out.flush().unwrap();
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn sessions_dir() -> PathBuf {
    std::env::var_os("FAKE_CLAUDE_SESSIONS")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("sling-fake-claude-sessions"))
}

fn new_session_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!(
        "{:08x}-0000-4000-8000-{:012x}",
        std::process::id(),
        nanos & 0xffff_ffff_ffff
    )
}

/// One `stream_event` line, the way `--include-partial-messages` sends them.
fn stream(session: &str, event: Value) -> Value {
    json!({"type": "stream_event", "event": event, "parent_tool_use_id": null, "session_id": session})
}

fn chat(args: &[String]) {
    if flag(args, "--tools").as_deref() != Some("") {
        eprintln!("fake-claude: a chat turn needs --tools \"\"");
        std::process::exit(2);
    }
    let config_path = flag(args, "--mcp-config").unwrap();
    let config: Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    let server = config["mcpServers"]["sling"].clone();
    let instructions = flag(args, "--system-prompt-file")
        .map(|f| std::fs::read_to_string(f).unwrap())
        .unwrap_or_default();
    let allowed = flag(args, "--permission-mode").as_deref() == Some("dontAsk")
        && flag(args, "--allowedTools").as_deref() == Some("mcp__sling");
    let model = flag(args, "--model").unwrap_or_else(|| "claude-fake".into());
    let sessions = sessions_dir();
    std::fs::create_dir_all(&sessions).unwrap();
    let (session, resumed) = match flag(args, "--resume") {
        Some(id) if !sessions.join(&id).exists() => {
            let msg = format!("No conversation found with session ID: {id}");
            eprintln!("{msg}");
            emit(json!({
                "type": "result", "subtype": "error_during_execution", "is_error": true,
                "num_turns": 0, "session_id": id, "errors": [msg], "permission_denials": [],
                "usage": {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0},
            }));
            std::process::exit(1);
        }
        Some(id) => (id, true),
        None => (new_session_id(), false),
    };
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).unwrap();
    let scenario = prompt
        .split("[fake:")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .unwrap_or("reply")
        .to_string();
    let cwd = std::env::current_dir().unwrap();
    emit(json!({
        "type": "system", "subtype": "init", "cwd": cwd.display().to_string(), "session_id": session,
        "tools": [], "mcp_servers": [{"name": "sling", "status": "connected"}], "model": model,
        "permissionMode": flag(args, "--permission-mode").unwrap_or_default(),
        "apiKeySource": "none", "claude_code_version": VERSION,
    }));
    let message = |id: &str, content: Value| json!({"type": "assistant", "message": {"id": id, "type": "message", "role": "assistant", "model": model, "content": content}, "parent_tool_use_id": null, "session_id": session});
    let start_message = |id: &str| {
        stream(
            &session,
            json!({"type": "message_start", "message": {"id": id, "type": "message", "role": "assistant", "model": model, "content": []}}),
        )
    };

    let mut reply = format!(
        "fake-claude, {} session, {} instructions, in {}.\nYou said: {}",
        if resumed { "resumed" } else { "new" },
        if instructions.trim().is_empty() {
            "without"
        } else {
            "with"
        },
        cwd.display(),
        prompt.trim(),
    );
    match scenario.as_str() {
        "hang" => {
            #[cfg(unix)]
            // SAFETY: the handler only stores to an atomic.
            unsafe {
                libc::signal(libc::SIGINT, on_sigint as *const () as libc::sighandler_t);
            }
            emit(start_message("msg_hang"));
            emit(stream(
                &session,
                json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ));
            emit(stream(
                &session,
                json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Working on it."}}),
            ));
            while !INTERRUPTED.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(20));
            }
            emit(
                json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "session_id": session, "result": ""}),
            );
            std::process::exit(0);
        }
        "fail" => {
            emit(
                json!({"type": "result", "subtype": "success", "is_error": true, "session_id": session, "result": "fake-claude was told to fail"}),
            );
            std::process::exit(1);
        }
        "tool" => {
            let (name, text, is_error) = match mcp_call(&server, allowed) {
                Ok(r) => r,
                Err(e) => ("none".into(), e, true),
            };
            let tool_id = "toolu_fake_sling";
            let block = json!({"type": "tool_use", "id": tool_id, "name": format!("mcp__sling__{name}"), "input": {}});
            emit(start_message("msg_fake_tool"));
            emit(stream(
                &session,
                json!({"type": "content_block_start", "index": 0, "content_block": block}),
            ));
            emit(message("msg_fake_tool", json!([block])));
            emit(stream(
                &session,
                json!({"type": "content_block_stop", "index": 0}),
            ));
            emit(json!({
                "type": "user", "parent_tool_use_id": null, "session_id": session,
                "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": [{"type": "text", "text": text}], "is_error": is_error}]},
            }));
            reply = format!("Tool said: {text}");
        }
        _ => {}
    }

    emit(start_message("msg_fake_reply"));
    emit(stream(
        &session,
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    ));
    let chars: Vec<char> = reply.chars().collect();
    for chunk in chars.chunks(chars.len().div_ceil(3).max(1)) {
        let text: String = chunk.iter().collect();
        emit(stream(
            &session,
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}),
        ));
    }
    emit(message(
        "msg_fake_reply",
        json!([{"type": "text", "text": reply}]),
    ));
    emit(stream(
        &session,
        json!({"type": "content_block_stop", "index": 0}),
    ));
    emit(stream(&session, json!({"type": "message_stop"})));
    std::fs::write(sessions.join(&session), "").unwrap();
    emit(json!({
        "type": "result", "subtype": "success", "is_error": false, "num_turns": 1,
        "result": reply, "session_id": session, "permission_denials": [],
        "usage": {"input_tokens": 12, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 200, "output_tokens": 30},
    }));
}

/// Starts the MCP server from the config, lists its tools, and calls the
/// first one. Returns the tool's name, the result text, and whether it's an
/// error.
fn mcp_call(server: &Value, allowed: bool) -> Result<(String, String, bool), String> {
    let mut cmd = Command::new(server["command"].as_str().ok_or("no MCP command")?);
    for a in server["args"].as_array().into_iter().flatten() {
        cmd.arg(a.as_str().unwrap_or_default());
    }
    for (k, v) in server["env"].as_object().into_iter().flatten() {
        cmd.env(k, v.as_str().unwrap_or_default());
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("starting the MCP server: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut ask = |id: u64, method: &str, params: Value| -> Result<Value, String> {
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
        )
        .map_err(|e| e.to_string())?;
        if id == 1 {
            writeln!(
                stdin,
                "{}",
                json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
            )
            .map_err(|e| e.to_string())?;
        }
        loop {
            let mut line = String::new();
            if stdout.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("the MCP server closed".into());
            }
            let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if v["id"] == json!(id) {
                if let Some(err) = v.get("error") {
                    return Err(err["message"].as_str().unwrap_or("error").to_string());
                }
                return Ok(v["result"].clone());
            }
        }
    };
    let result = (|| {
        ask(
            1,
            "initialize",
            json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fake-claude", "version": VERSION}}),
        )?;
        let tools = ask(2, "tools/list", json!({}))?;
        let name = tools["tools"][0]["name"]
            .as_str()
            .ok_or("no tools")?
            .to_string();
        if !allowed {
            let text = format!(
                "Claude requested permissions to use mcp__sling__{name}, but you haven't granted it yet."
            );
            return Ok((name, text, true));
        }
        let r = ask(3, "tools/call", json!({"name": name, "arguments": {}}))?;
        let text = r["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        Ok((name, text, r["isError"].as_bool().unwrap_or(false)))
    })();
    drop(stdin);
    let _ = child.wait();
    result
}

#[cfg(unix)]
extern "C" fn on_sigint(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::SeqCst);
}
