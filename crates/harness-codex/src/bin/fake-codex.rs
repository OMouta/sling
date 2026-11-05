//! A stand-in for the `codex` CLI, for tests and local development without a
//! Codex login. Point the Runner at it with `codex_bin` in runner.toml.
//!
//! It answers `--version`, `login status`, `login --with-api-key`,
//! `debug models`, and `exec --json ... -`, printing the same shapes as real
//! Codex. `exec` takes `-m <model>` and `-c` overrides such as
//! `model_reasoning_effort` and `service_tier`, and reports them in an agent
//! message. Pick a scenario with `FAKE_CODEX_SCENARIO`, or put
//! `[fake:<scenario>]` in the prompt:
//!
//! - `success` (default): edits `SLING_FAKE.md`, runs a command, finishes.
//! - `noop`: finishes without changing anything.
//! - `fail`: reports a failed turn and exits 1.
//! - `hang`: starts, then sleeps until killed. For cancel and crash tests.
//! - `crash`: exits with code 101 after the first event.
//! - `env`: like `success`, and also reports which sensitive environment
//!   variables it can see.
//!
//! With `-c mcp_servers.sling.command=...` it runs a chat turn instead (it
//! needs `-s read-only` and `--skip-git-repo-check`): no file changes, just
//! a reply that names the session, whether it got developer instructions,
//! its working directory, and the prompt. Sessions are kept as files under
//! `FAKE_CODEX_SESSIONS` (by default a directory in the temp dir), and
//! `exec resume` of one that isn't there fails the way Codex does. Chat
//! scenarios:
//!
//! - default: replies.
//! - `tool`: starts the `sling` MCP server with only the variables its
//!   `env_vars` names, lists its tools, calls the first one with no
//!   arguments, and replies with the result. Like Codex under
//!   `approval_policy="never"`, the call fails unless the server's
//!   `default_tools_approval_mode` is `approve`.
//! - `hang`, `fail`: as above.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") => println!("codex-cli 0.166.0"),
        Some("login") if args.iter().any(|a| a == "--with-api-key") => {
            let mut key = String::new();
            std::io::stdin().read_to_string(&mut key).unwrap();
            if key.trim().is_empty() {
                eprintln!("fake-codex: no API key on stdin");
                std::process::exit(1);
            }
            println!("Successfully logged in");
        }
        Some("login") => {
            if std::env::var("FAKE_CODEX_LOGGED_OUT").is_ok() {
                println!("Not logged in");
                std::process::exit(1);
            }
            println!("Logged in using fake-codex");
        }
        Some("debug") if args.get(1).map(String::as_str) == Some("models") => models(),
        Some("exec") => exec(&args[1..]),
        _ => {
            eprintln!("fake-codex: unsupported arguments {args:?}");
            std::process::exit(2);
        }
    }
}

/// A small catalog in the shape of `codex debug models`, which also carries
/// fields the Runner ignores, such as `base_instructions`.
fn models() {
    let levels = |efforts: &[&str]| -> Vec<serde_json::Value> {
        efforts
            .iter()
            .map(|e| json!({"effort": e, "description": format!("{e} reasoning")}))
            .collect()
    };
    let catalog = json!({"models": [
        {
            "slug": "fake-large", "display_name": "Fake Large",
            "description": "Workhorse model for coding and everyday work.",
            "default_reasoning_level": "medium",
            "supported_reasoning_levels": levels(&["low", "medium", "high", "xhigh"]),
            "visibility": "list", "priority": 1, "context_window": 272000,
            "additional_speed_tiers": ["fast"],
            "service_tiers": [{"id": "priority", "name": "Fast", "description": "1.5x speed"}],
            "base_instructions": "You are a fake coding agent.",
        },
        {
            "slug": "fake-mini", "display_name": "Fake Mini",
            "description": "Fast and affordable model for easier tasks.",
            "default_reasoning_level": "low",
            "supported_reasoning_levels": levels(&["low", "medium", "high"]),
            "visibility": "list", "priority": 2, "context_window": 128000,
            "additional_speed_tiers": [], "service_tiers": [],
            "base_instructions": "You are a fake coding agent.",
        },
        {
            "slug": "fake-review", "display_name": "Fake Review",
            "description": "Internal review model.",
            "default_reasoning_level": "medium",
            "supported_reasoning_levels": levels(&["medium"]),
            "visibility": "hide", "priority": 3,
            "additional_speed_tiers": [], "service_tiers": [],
            "base_instructions": "You review changes.",
        },
    ]});
    println!("{}", serde_json::to_string_pretty(&catalog).unwrap());
}

fn exec(args: &[String]) {
    let mut cwd = std::env::current_dir().unwrap();
    let mut sandbox = "read-only".to_string();
    let mut settings: Vec<String> = Vec::new();
    let mut overrides: Vec<(String, String)> = Vec::new();
    let mut resume = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-c"
            && let Some((k, v)) = args[i + 1].split_once('=')
        {
            overrides.push((k.to_string(), v.to_string()));
        }
        match args[i].as_str() {
            "resume" => {
                resume = Some(args[i + 1].clone());
                i += 1;
            }
            "-C" => {
                cwd = PathBuf::from(&args[i + 1]);
                i += 1;
            }
            "-s" => {
                sandbox = args[i + 1].clone();
                i += 1;
            }
            "-m" | "--model" => {
                settings.push(format!("model={}", args[i + 1]));
                i += 1;
            }
            "-c" => {
                let kv = &args[i + 1];
                if kv.starts_with("model_reasoning_effort=") || kv.starts_with("service_tier=") {
                    settings.push(kv.replace('"', ""));
                }
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    if overrides
        .iter()
        .any(|(k, _)| k == "mcp_servers.sling.command")
    {
        let skip_git = args.iter().any(|a| a == "--skip-git-repo-check");
        if sandbox != "read-only" || !skip_git {
            eprintln!("fake-codex: a chat turn needs -s read-only and --skip-git-repo-check");
            std::process::exit(2);
        }
        return chat(&cwd, &overrides, resume);
    }
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).unwrap();

    let scenario = prompt
        .split("[fake:")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .map(str::to_string)
        .or_else(|| std::env::var("FAKE_CODEX_SCENARIO").ok())
        .unwrap_or_else(|| "success".into());
    let delay = std::env::var("FAKE_CODEX_DELAY_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(150);
    let pause = || std::thread::sleep(Duration::from_millis(delay));
    let emit = |v: serde_json::Value| {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{v}").unwrap();
        out.flush().unwrap();
    };

    emit(json!({"type": "thread.started", "thread_id": "fake-thread"}));
    emit(json!({"type": "turn.started"}));
    if !settings.is_empty() {
        let text = format!("Settings: {}", settings.join(" "));
        emit(
            json!({"type": "item.completed", "item": {"id": "item_settings", "type": "agent_message", "text": text}}),
        );
    }
    pause();

    match scenario.as_str() {
        "crash" => {
            eprintln!("fake-codex: crashing on purpose");
            std::process::exit(101);
        }
        "hang" => {
            emit(
                json!({"type": "item.completed", "item": {"id": "item_0", "type": "agent_message", "text": "Working on it."}}),
            );
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        "fail" => {
            emit(
                json!({"type": "turn.failed", "error": {"message": "fake-codex was told to fail"}}),
            );
            std::process::exit(1);
        }
        _ => {}
    }

    emit(
        json!({"type": "item.completed", "item": {"id": "item_0", "type": "agent_message", "text": "I'll make the change and run the tests."}}),
    );
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
        let text = format!("Sensitive environment: [{}]", seen.join(","));
        emit(
            json!({"type": "item.completed", "item": {"id": "item_env", "type": "agent_message", "text": text}}),
        );
    }
    emit(
        json!({"type": "item.started", "item": {"id": "item_1", "type": "todo_list", "items": [
            {"text": "Edit SLING_FAKE.md", "completed": false},
            {"text": "Run tests", "completed": false}
        ]}}),
    );
    pause();

    let writes = sandbox != "read-only" && scenario != "noop";
    if writes {
        let file = cwd.join("SLING_FAKE.md");
        let title = prompt
            .lines()
            .find_map(|l| l.strip_prefix("Task: "))
            .unwrap_or("task");
        let mut text = std::fs::read_to_string(&file).unwrap_or_default();
        text.push_str(&format!("- {title}\n"));
        std::fs::write(&file, text).unwrap();
        emit(
            json!({"type": "item.completed", "item": {"id": "item_2", "type": "file_change", "changes": [{"path": file.display().to_string(), "kind": "update"}], "status": "completed"}}),
        );
    }
    pause();

    emit(
        json!({"type": "item.started", "item": {"id": "item_3", "type": "command_execution", "command": "echo tests", "aggregated_output": "", "exit_code": null, "status": "in_progress"}}),
    );
    pause();
    emit(
        json!({"type": "item.completed", "item": {"id": "item_3", "type": "command_execution", "command": "echo tests", "aggregated_output": "3 passed\n", "exit_code": 0, "status": "completed"}}),
    );
    emit(
        json!({"type": "item.completed", "item": {"id": "item_1", "type": "todo_list", "items": [
            {"text": "Edit SLING_FAKE.md", "completed": true},
            {"text": "Run tests", "completed": true}
        ]}}),
    );
    let summary = if writes {
        "Updated SLING_FAKE.md. Tests: 3 passed."
    } else {
        "Looked around and changed nothing."
    };
    emit(
        json!({"type": "item.completed", "item": {"id": "item_4", "type": "agent_message", "text": summary}}),
    );
    emit(
        json!({"type": "turn.completed", "usage": {"input_tokens": 1200, "cached_input_tokens": 800, "output_tokens": 90, "reasoning_output_tokens": 0}}),
    );
}

fn emit(v: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{v}").unwrap();
    out.flush().unwrap();
}

/// A `-c` value. The Runner writes TOML strings and arrays the way JSON
/// does, so they parse as JSON.
fn setting(overrides: &[(String, String)], key: &str) -> Option<serde_json::Value> {
    overrides
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .map(|(_, v)| serde_json::from_str(v).unwrap_or_else(|_| json!(v)))
}

fn chat(cwd: &std::path::Path, overrides: &[(String, String)], resume: Option<String>) {
    let sessions = std::env::var_os("FAKE_CODEX_SESSIONS")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("sling-fake-codex-sessions"));
    std::fs::create_dir_all(&sessions).unwrap();
    let (thread, resumed) = match resume {
        Some(id) if !sessions.join(&id).exists() => {
            eprintln!(
                "Error: thread/resume: thread/resume failed: no rollout found for thread id {id} (code -32600)"
            );
            std::process::exit(1);
        }
        Some(id) => (id, true),
        None => {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = format!(
                "{:08x}-0000-7000-8000-{:012x}",
                std::process::id(),
                nanos & 0xffff_ffff_ffff
            );
            (id, false)
        }
    };
    let instructions = setting(overrides, "developer_instructions")
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).unwrap();
    let scenario = prompt
        .split("[fake:")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .unwrap_or("reply")
        .to_string();

    emit(json!({"type": "thread.started", "thread_id": thread}));
    emit(json!({"type": "turn.started"}));
    let mut reply = format!(
        "fake-codex, {} session, {} instructions, in {}.\nYou said: {}",
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
            emit(
                json!({"type": "item.completed", "item": {"id": "item_0", "type": "agent_message", "text": "Working on it."}}),
            );
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        "fail" => {
            emit(
                json!({"type": "turn.failed", "error": {"message": "fake-codex was told to fail"}}),
            );
            std::process::exit(1);
        }
        "tool" => {
            let approved = setting(overrides, "mcp_servers.sling.default_tools_approval_mode")
                == Some(json!("approve"));
            let (name, result) = match mcp_call(overrides, approved) {
                Ok((name, text, is_error)) => (
                    name,
                    json!({"content": [{"type": "text", "text": text}], "is_error": is_error}),
                ),
                Err((name, e)) => (name, json!({"error": e})),
            };
            let text = result["content"][0]["text"]
                .as_str()
                .or(result["error"].as_str())
                .unwrap_or_default()
                .to_string();
            let started = json!({"id": "item_1", "type": "mcp_tool_call", "server": "sling", "tool": name, "arguments": {}, "result": null, "error": null, "status": "in_progress"});
            emit(json!({"type": "item.started", "item": started}));
            let mut done = started.clone();
            if result.get("error").is_some() {
                done["error"] = json!({"message": text});
                done["status"] = json!("failed");
            } else {
                done["result"] = json!({"content": result["content"], "structured_content": null});
                done["status"] = json!("completed");
            }
            emit(json!({"type": "item.completed", "item": done}));
            reply = format!("Tool said: {text}");
        }
        _ => {}
    }
    emit(
        json!({"type": "item.completed", "item": {"id": "item_2", "type": "agent_message", "text": reply}}),
    );
    std::fs::write(sessions.join(&thread), "").unwrap();
    emit(
        json!({"type": "turn.completed", "usage": {"input_tokens": 1200, "cached_input_tokens": 800, "output_tokens": 90, "reasoning_output_tokens": 0}}),
    );
}

/// Starts the MCP server the way Codex does, with only the variables its
/// `env_vars` names, lists its tools, and calls the first one. Returns the
/// tool's name, the result text, and whether it's an error.
fn mcp_call(
    overrides: &[(String, String)],
    approved: bool,
) -> Result<(String, String, bool), (String, String)> {
    let fail = |e: String| ("none".to_string(), e);
    let command = setting(overrides, "mcp_servers.sling.command")
        .and_then(|v| v.as_str().map(str::to_string))
        .ok_or_else(|| fail("no MCP command".into()))?;
    let mut cmd = Command::new(command);
    for a in setting(overrides, "mcp_servers.sling.args")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
    {
        cmd.arg(a.as_str().unwrap_or_default());
    }
    cmd.env_clear();
    for name in ["PATH", "HOME", "TMPDIR"] {
        if let Some(v) = std::env::var_os(name) {
            cmd.env(name, v);
        }
    }
    for name in setting(overrides, "mcp_servers.sling.env_vars")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
    {
        let name = name.as_str().unwrap_or_default();
        if let Some(v) = std::env::var_os(name) {
            cmd.env(name, v);
        }
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| fail(format!("starting the MCP server: {e}")))?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut ask =
        |id: u64, method: &str, params: serde_json::Value| -> Result<serde_json::Value, String> {
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
                let v: serde_json::Value =
                    serde_json::from_str(&line).map_err(|e| e.to_string())?;
                if v["id"] == json!(id) {
                    if let Some(err) = v.get("error") {
                        return Err(err["message"].as_str().unwrap_or("error").to_string());
                    }
                    return Ok(v["result"].clone());
                }
            }
        };
    let result = (|| {
        ask(1, "initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fake-codex", "version": "0.166.0"}}))
            .map_err(fail)?;
        let tools = ask(2, "tools/list", json!({})).map_err(fail)?;
        let name = tools["tools"][0]["name"]
            .as_str()
            .ok_or_else(|| fail("no tools".into()))?
            .to_string();
        if !approved {
            return Err((
                name,
                "MCP tool call requires approval, but approval policy is never".into(),
            ));
        }
        let r = ask(3, "tools/call", json!({"name": name, "arguments": {}}))
            .map_err(|e| (name.clone(), e))?;
        let text = r["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        Ok((name, text, r["isError"].as_bool().unwrap_or(false)))
    })();
    drop(ask);
    drop(stdin);
    let _ = child.wait();
    result
}
