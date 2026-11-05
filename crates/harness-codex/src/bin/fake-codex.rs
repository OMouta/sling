//! A stand-in for the `codex` CLI, for tests and local development without a
//! Codex login. Point the Runner at it with `codex_bin` in runner.toml.
//!
//! It answers `--version`, `login status`, and `exec --json ... -`, printing
//! the same JSONL shape as real Codex. Pick a scenario with
//! `FAKE_CODEX_SCENARIO`, or put `[fake:<scenario>]` in the prompt:
//!
//! - `success` (default): edits `SLING_FAKE.md`, runs a command, finishes.
//! - `noop`: finishes without changing anything.
//! - `fail`: reports a failed turn and exits 1.
//! - `hang`: starts, then sleeps until killed. For cancel and crash tests.
//! - `crash`: exits with code 101 after the first event.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") => println!("codex-cli 0.166.0"),
        Some("login") => {
            if std::env::var("FAKE_CODEX_LOGGED_OUT").is_ok() {
                println!("Not logged in");
                std::process::exit(1);
            }
            println!("Logged in using fake-codex");
        }
        Some("exec") => exec(&args[1..]),
        _ => {
            eprintln!("fake-codex: unsupported arguments {args:?}");
            std::process::exit(2);
        }
    }
}

fn exec(args: &[String]) {
    let mut cwd = std::env::current_dir().unwrap();
    let mut sandbox = "read-only".to_string();
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
