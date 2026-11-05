use std::time::Duration;

use sling_harness_codex::{Event, Run, RunOptions, build_prompt, detect};
use sling_runner_protocol::task_event::Kind;
use tokio::sync::mpsc;

const BIN: &str = env!("CARGO_BIN_EXE_fake-codex");

fn opts(dir: &std::path::Path, prompt: String, sandbox: &str) -> RunOptions {
    RunOptions {
        bin: BIN.into(),
        cwd: dir.to_path_buf(),
        prompt,
        sandbox: sandbox.into(),
        network: false,
    }
}

async fn collect(mut rx: mpsc::Receiver<Event>) -> Vec<Kind> {
    let mut out = vec![];
    while let Some(ev) = rx.recv().await {
        if let Event::Task(k) = ev {
            out.push(k);
        }
    }
    out
}

#[tokio::test]
async fn detects_the_fake_as_ready() {
    let d = detect(BIN).await;
    assert!(d.ready(), "{d:?}");
    assert_eq!(d.version, "0.166.0");
}

#[tokio::test]
async fn success_scenario_edits_and_summarizes() {
    unsafe { std::env::set_var("FAKE_CODEX_DELAY_MS", "1") };
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(64);
    let o = opts(
        dir.path(),
        build_prompt("Fix footer", "Make it dynamic.", true),
        "workspace-write",
    );
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    let events = tokio::spawn(collect(rx));
    let code = run.wait().await.unwrap();
    let outcome = reader.finish(code).await;
    let events = events.await.unwrap();

    assert_eq!(outcome.exit_code, Some(0));
    assert!(outcome.failure.is_none());
    assert!(outcome.summary.contains("3 passed"));
    assert!(events.iter().any(|k| matches!(k, Kind::FileChange(_))));
    assert!(events.iter().any(|k| matches!(k, Kind::Usage(_))));
    let text = std::fs::read_to_string(dir.path().join("SLING_FAKE.md")).unwrap();
    assert!(text.contains("Fix footer"));
}

#[tokio::test]
async fn read_only_sandbox_writes_nothing() {
    unsafe { std::env::set_var("FAKE_CODEX_DELAY_MS", "1") };
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(64);
    let o = opts(
        dir.path(),
        build_prompt("Look", "Just look.", false),
        "read-only",
    );
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    tokio::spawn(collect(rx));
    let code = run.wait().await.unwrap();
    reader.finish(code).await;
    assert!(!dir.path().join("SLING_FAKE.md").exists());
}

#[tokio::test]
async fn failure_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(64);
    let o = opts(dir.path(), "[fake:fail] go".into(), "workspace-write");
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    tokio::spawn(collect(rx));
    let code = run.wait().await.unwrap();
    let outcome = reader.finish(code).await;
    assert_eq!(outcome.exit_code, Some(1));
    assert_eq!(
        outcome.failure.as_deref(),
        Some("fake-codex was told to fail")
    );
}

#[tokio::test]
async fn cancel_stops_a_hanging_run() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(64);
    let o = opts(dir.path(), "[fake:hang] go".into(), "workspace-write");
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    tokio::spawn(collect(rx));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = std::time::Instant::now();
    run.cancel(Duration::from_secs(2)).await;
    let code = run.wait().await.unwrap();
    reader.finish(code).await;
    assert!(started.elapsed() < Duration::from_secs(5));
}
