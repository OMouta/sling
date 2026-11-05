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

use std::io::{Read, Write};
use std::path::PathBuf;
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
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
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
