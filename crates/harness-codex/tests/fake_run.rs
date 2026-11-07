use std::time::Duration;

use sling_harness_codex::{Event, Run, RunOptions, build_prompt, detect, list_models};
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
        env: None,
        model: None,
        effort: None,
        fast: false,
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
async fn lists_the_fakes_models() {
    let d = detect(BIN).await;
    let ids: Vec<&str> = d.models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        ["fake-large", "fake-mini"],
        "hidden models are left out"
    );
    assert!(d.models[0].is_default && d.models[0].fast);
    assert_eq!(d.models[0].default_effort, "medium");
    assert!(!d.models[1].is_default && !d.models[1].fast);
    assert!(list_models("/nonexistent/codex").await.is_empty());
}

#[tokio::test]
async fn model_settings_reach_codex() {
    unsafe { std::env::set_var("FAKE_CODEX_DELAY_MS", "1") };
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = mpsc::channel(64);
    let mut o = opts(dir.path(), "[fake:noop] go".into(), "read-only");
    o.model = Some("fake-mini".into());
    o.effort = Some("high".into());
    o.fast = true;
    let (mut run, reader) = Run::start(&o, tx).await.unwrap();
    let events = tokio::spawn(collect(rx));
    let code = run.wait().await.unwrap();
    reader.finish(code).await;
    let said: Vec<String> = events
        .await
        .unwrap()
        .into_iter()
        .filter_map(|k| match k {
            Kind::AgentMessage(m) => Some(m.text),
            _ => None,
        })
        .collect();
    assert!(
        said.contains(
            &"Settings: model=fake-mini model_reasoning_effort=high service_tier=fast".to_string()
        ),
        "{said:?}"
    );
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

mod chat {
    use super::BIN;
    use sling_harness_codex::Run;
    use sling_harness_codex::chat::{ChatOptions, ChatOutcome, McpServer};
    use sling_runner_protocol::chat_event::Kind;
    use tokio::sync::mpsc;

    fn opts(dir: &std::path::Path, prompt: &str, resume: Option<String>) -> ChatOptions {
        ChatOptions {
            bin: BIN.into(),
            dir: dir.to_path_buf(),
            prompt: prompt.into(),
            instructions: "You are Sling's assistant.".into(),
            mcp: McpServer {
                command: "/nonexistent/sling-runner".into(),
                args: vec!["mcp".into()],
                env_vars: vec!["SLING_TOOLS_TOKEN".into()],
            },
            env: None,
            model: Some("fake-mini".into()),
            effort: Some("low".into()),
            fast: false,
            resume,
            web: false,
            images: Vec::new(),
        }
    }

    async fn turn(o: &ChatOptions) -> (Vec<Kind>, ChatOutcome) {
        let (tx, mut rx) = mpsc::channel(64);
        let (mut run, reader) = Run::start_chat(o, tx).await.unwrap();
        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }
        let code = run.wait().await.unwrap();
        (events, reader.finish(code).await)
    }

    #[tokio::test]
    async fn replies_and_resumes_its_session() {
        let dir = tempfile::tempdir().unwrap();
        let (events, first) = turn(&opts(dir.path(), "hello", None)).await;
        assert!(first.failure.is_none(), "{:?}", first.failure);
        let deltas: String = events
            .iter()
            .filter_map(|e| match e {
                Kind::Delta(d) => Some(d.text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, first.text);
        assert!(first.text.contains("new session, with instructions"));
        assert!(first.text.ends_with("You said: hello"));
        assert!(!first.session_id.is_empty());
        assert_eq!((first.input_tokens, first.output_tokens), (1200, 90));

        let (_, second) = turn(&opts(dir.path(), "again", Some(first.session_id.clone()))).await;
        assert!(second.failure.is_none(), "{:?}", second.failure);
        assert!(second.text.contains("resumed session"));
        assert_eq!(second.session_id, first.session_id);
    }

    #[tokio::test]
    async fn a_session_that_isnt_here_is_reported_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let o = opts(
            dir.path(),
            "hello",
            Some("00000000-dead-7000-8000-000000000000".into()),
        );
        let (events, out) = turn(&o).await;
        assert!(events.is_empty());
        assert!(out.session_missing);
        assert!(out.failure.unwrap().contains("no rollout found"));
    }

    #[tokio::test]
    async fn refuses_a_session_id_that_looks_like_a_flag() {
        let dir = tempfile::tempdir().unwrap();
        let o = opts(
            dir.path(),
            "hello",
            Some("--dangerously-bypass-approvals-and-sandbox".into()),
        );
        let (tx, _rx) = mpsc::channel(1);
        let err = Run::start_chat(&o, tx).await.err().expect("refused");
        assert!(err.to_string().contains("refusing session ID"), "{err}");
    }

    #[tokio::test]
    async fn cancel_ends_a_turn() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, mut rx) = mpsc::channel(64);
        let (mut run, reader) = Run::start_chat(&opts(dir.path(), "[fake:hang]", None), tx)
            .await
            .unwrap();
        assert!(matches!(rx.recv().await, Some(Kind::Delta(_))));
        let started = std::time::Instant::now();
        run.cancel(std::time::Duration::from_secs(2)).await;
        while rx.recv().await.is_some() {}
        let code = run.wait().await.unwrap();
        reader.finish(code).await;
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}
