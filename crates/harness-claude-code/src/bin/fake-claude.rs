//! A stand-in for the `claude` CLI, for tests and local development without a
//! Claude Code login. Point the Runner at it with `claude_bin` in runner.toml.
//!
//! It answers `--version`, `auth status`, and `-p --output-format
//! stream-json ...`, printing the same stream-json shapes as real Claude Code.
//! Pick a scenario with `FAKE_CLAUDE_SCENARIO`, or put `[fake:<scenario>]` in
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

use std::io::{Read, Write};
use std::path::PathBuf;
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
    let mode = if args.iter().any(|a| a == "--dangerously-skip-permissions") {
        "bypassPermissions".to_string()
    } else {
        args.iter()
            .position(|a| a == "--permission-mode")
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| "default".into())
    };
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
        json!({"type": "assistant", "message": {"id": format!("msg_fake_{msg}"), "type": "message", "role": "assistant", "model": "claude-fake", "content": [{"type": "text", "text": t}]}, "parent_tool_use_id": null, "session_id": SESSION})
    };

    emit(json!({
        "type": "system", "subtype": "init", "cwd": cwd.display().to_string(), "session_id": SESSION,
        "tools": ["Bash", "Edit", "Read", "Write"], "mcp_servers": [], "model": "claude-fake",
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
            json!({"type": "assistant", "message": {"id": "msg_fake_w", "type": "message", "role": "assistant", "model": "claude-fake", "content": [{"type": "tool_use", "id": "toolu_fake_write", "name": "Write", "input": {"file_path": path, "content": body}}]}, "parent_tool_use_id": null, "session_id": SESSION}),
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
        json!({"type": "assistant", "message": {"id": "msg_fake_b", "type": "message", "role": "assistant", "model": "claude-fake", "content": [{"type": "tool_use", "id": "toolu_fake_bash", "name": "Bash", "input": {"command": "echo tests", "description": "Run the tests"}}]}, "parent_tool_use_id": null, "session_id": SESSION}),
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

#[cfg(unix)]
extern "C" fn on_sigint(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::SeqCst);
}
