use std::time::Duration;

use sling_harness_claude_code::{Access, Event, Run, RunOptions, build_prompt, detect};
use sling_runner_protocol::{file_change, task_event::Kind};
use tokio::sync::mpsc;

const BIN: &str = env!("CARGO_BIN_EXE_fake-claude");

fn opts(dir: &std::path::Path, prompt: String, access: Access) -> RunOptions {
    RunOptions {
        bin: BIN.into(),
        cwd: dir.to_path_buf(),
        prompt,
        access,
        network: false,
        env: Some(vec![
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            ("FAKE_CLAUDE_DELAY_MS".into(), "1".into()),
        ]),
        model: None,
        effort: None,
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
    assert_eq!(d.version, "2.1.318");
    assert_eq!(d.detail, "Logged in using claude.ai");
}

#[tokio::test]
async fn a_missing_binary_is_not_installed() {
    let d = detect("/nonexistent/claude").await;
    assert!(!d.installed && !d.ready());
}

#[tokio::test]
async fn lists_models_once_installed() {
    assert_eq!(detect(BIN).await.models.len(), 4);
    assert!(detect("/nonexistent/claude").await.models.is_empty());
}

#[tokio::test]
async fn the_model_reaches_claude_code() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, mut rx) = mpsc::channel(64);
    let mut o = opts(dir.path(), "[fake:noop] go".into(), Access::ReadOnly);
    o.model = Some("opus".into());
    o.effort = Some("max".into());
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    let mut model = None;
    while let Some(ev) = rx.recv().await {
        if let Event::SessionStarted { model: m, .. } = ev {
            model = Some(m);
        }
    }
    let code = run.wait().await.unwrap();
    let outcome = reader.finish(code).await;
    assert_eq!(outcome.exit_code, Some(0), "{:?}", outcome.failure);
    assert_eq!(model.as_deref(), Some("opus"));
}

#[tokio::test]
async fn success_scenario_writes_and_summarizes() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(64);
    let o = opts(
        dir.path(),
        build_prompt("Fix footer", "Make it dynamic.", true),
        Access::Edit,
    );
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    let events = tokio::spawn(collect(rx));
    let code = run.wait().await.unwrap();
    let outcome = reader.finish(code).await;
    let events = events.await.unwrap();

    assert_eq!(outcome.exit_code, Some(0));
    assert!(outcome.failure.is_none(), "{:?}", outcome.failure);
    assert!(outcome.summary.contains("3 passed"));
    let added = events.iter().any(|k| {
        matches!(k, Kind::FileChange(f) if f.changes[0].kind() == file_change::Kind::Add
            && f.changes[0].path.ends_with("SLING_FAKE.md"))
    });
    assert!(added, "{events:?}");
    assert!(events.iter().any(|k| matches!(k, Kind::Command(_))));
    assert!(events.iter().any(|k| matches!(k, Kind::Usage(_))));
    let text = std::fs::read_to_string(dir.path().join("SLING_FAKE.md")).unwrap();
    assert!(text.contains("Fix footer"));
}

#[tokio::test]
async fn plan_mode_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(64);
    let o = opts(
        dir.path(),
        build_prompt("Look", "Just look.", false),
        Access::ReadOnly,
    );
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    tokio::spawn(collect(rx));
    let code = run.wait().await.unwrap();
    let outcome = reader.finish(code).await;
    assert!(outcome.failure.is_none());
    assert!(!dir.path().join("SLING_FAKE.md").exists());
}

#[tokio::test]
async fn failure_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(64);
    let o = opts(dir.path(), "[fake:fail] go".into(), Access::Edit);
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    tokio::spawn(collect(rx));
    let code = run.wait().await.unwrap();
    let outcome = reader.finish(code).await;
    assert_eq!(outcome.exit_code, Some(1));
    assert_eq!(
        outcome.failure.as_deref(),
        Some("fake-claude was told to fail")
    );
}

#[tokio::test]
async fn a_crash_has_no_result() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(64);
    let o = opts(dir.path(), "[fake:crash] go".into(), Access::Edit);
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    let events = tokio::spawn(collect(rx));
    let code = run.wait().await.unwrap();
    let outcome = reader.finish(code).await;
    assert_eq!(outcome.exit_code, Some(101));
    assert!(outcome.failure.is_some());
    let events = events.await.unwrap();
    assert!(
        events
            .iter()
            .any(|k| matches!(k, Kind::Log(l) if l.text.contains("crashing on purpose")))
    );
}

#[tokio::test]
async fn cancel_stops_a_hanging_run() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(64);
    let o = opts(dir.path(), "[fake:hang] go".into(), Access::Edit);
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    let mut rx = rx;
    // Wait until it's working, so the interrupt doesn't land during startup.
    while let Some(ev) = rx.recv().await {
        if matches!(ev, Event::Task(Kind::AgentMessage(_))) {
            break;
        }
    }
    tokio::spawn(collect(rx));
    let started = std::time::Instant::now();
    run.cancel(Duration::from_secs(5)).await;
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "SIGINT was enough"
    );
    let code = run.wait().await.unwrap();
    let outcome = reader.finish(code).await;
    // Like real Claude Code: exit 0, with an error result.
    assert_eq!(code, Some(0));
    assert!(outcome.failure.is_some());
}

#[tokio::test]
async fn the_environment_is_replaced_not_inherited() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(64);
    let mut o = opts(dir.path(), "[fake:env] go".into(), Access::Edit);
    o.env
        .as_mut()
        .unwrap()
        .push(("ANTHROPIC_API_KEY".into(), "sk-ant-test".into()));
    unsafe { std::env::set_var("SLING_FAKE_PARENT_ONLY", "1") };
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    let events = tokio::spawn(collect(rx));
    let code = run.wait().await.unwrap();
    reader.finish(code).await;
    let report = events
        .await
        .unwrap()
        .into_iter()
        .find_map(|k| match k {
            Kind::AgentMessage(m) if m.text.starts_with("Sensitive environment") => Some(m.text),
            _ => None,
        })
        .unwrap();
    assert_eq!(report, "Sensitive environment: [ANTHROPIC_API_KEY]");
}
