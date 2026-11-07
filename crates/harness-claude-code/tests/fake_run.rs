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

mod chat {
    use super::BIN;
    use sling_harness_claude_code::Run;
    use sling_harness_claude_code::chat::{
        ChatOptions, ChatOutcome, INSTRUCTIONS_FILE, MCP_CONFIG_FILE, McpServer,
    };
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
                env: vec![("SLING_TOOLS_TOKEN".into(), "tok-123".into())],
            },
            env: None,
            model: Some("claude-haiku-5-5".into()),
            effort: Some("low".into()),
            fast: false,
            resume,
            web: false,
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
    async fn streams_a_reply_and_resumes_its_session() {
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
        assert_eq!((first.input_tokens, first.output_tokens), (312, 30));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for f in [MCP_CONFIG_FILE, INSTRUCTIONS_FILE] {
                let mode = std::fs::metadata(dir.path().join(f))
                    .unwrap()
                    .permissions()
                    .mode();
                assert_eq!(mode & 0o777, 0o600, "{f}");
            }
        }

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
            Some("00000000-dead-4000-8000-000000000000".into()),
        );
        let (events, out) = turn(&o).await;
        assert!(events.is_empty());
        assert!(out.session_missing);
        assert!(out.failure.is_some());
    }

    #[tokio::test]
    async fn refuses_a_session_id_that_looks_like_a_flag() {
        let dir = tempfile::tempdir().unwrap();
        let o = opts(
            dir.path(),
            "hello",
            Some("--dangerously-skip-permissions".into()),
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
        run.cancel(std::time::Duration::from_secs(5)).await;
        assert!(started.elapsed() < std::time::Duration::from_secs(4));
        while rx.recv().await.is_some() {}
        let code = run.wait().await.unwrap();
        let out = reader.finish(code).await;
        assert!(out.failure.is_some());
    }
}
