//! Chat turns end to end, once per agent: the Manager starts `fake-codex` or
//! `fake-claude`, which starts the real `sling-runner mcp` from its MCP
//! config, which calls a stand-in for Sling's tools API.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use sling_runner_protocol::envelope::Body;
use sling_runner_protocol::{ChatDone, ChatTurn, chat_event::Kind};
use tokio::sync::mpsc;

use crate::config::{Config, Paths};
use crate::tasks::Manager;
use crate::test_http::Stub;

const AGENTS: [&str; 2] = ["codex", "claude-code"];
const TOKEN: &str = "turn-token-0123456789";

fn all_ready() -> Vec<String> {
    AGENTS.iter().map(|a| a.to_string()).collect()
}

/// A binary from this workspace, next to the test binary. `cargo test
/// --workspace` builds them all; otherwise it's built here.
fn workspace_bin(package: &str, name: &str) -> PathBuf {
    static BUILDING: Mutex<()> = Mutex::new(());
    let _guard = BUILDING.lock().unwrap();
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().parent().unwrap();
    let bin = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    if !bin.exists() {
        let mut cmd = std::process::Command::new(env!("CARGO"));
        cmd.args(["build", "-q", "-p", package, "--bin", name]);
        if dir.ends_with("release") {
            cmd.arg("--release");
        }
        assert!(cmd.status().unwrap().success(), "building {name}");
    }
    bin
}

struct Env {
    _dir: tempfile::TempDir,
    mgr: Arc<Manager>,
    paths: Paths,
    tools: Stub,
}

fn setup() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let paths = Paths {
        config_dir: root.join("home"),
        data_dir: root.join("home/data"),
    };
    let tools = Stub::start(|req| {
        if req.auth.as_deref() != Some(&format!("Bearer {TOKEN}")) {
            return (401, r#"{"error":"bad token"}"#.into());
        }
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/tools") => (
                200,
                json!({"tools": [{"name": "list_machines", "description": "Lists machines.",
                                  "inputSchema": {"type": "object", "properties": {}}}]})
                .to_string(),
            ),
            ("POST", "/tools/list_machines") => (
                200,
                json!({"content": "You have 2 machines: laptop, desktop.", "isError": false})
                    .to_string(),
            ),
            _ => (404, r#"{"error":"no such tool"}"#.into()),
        }
    });
    let cfg = Config {
        // Paired with the stub, so the bridge may call it.
        server_url: Some(tools.url.clone()),
        runner_id: Some("rnr_test".into()),
        max_concurrent_tasks: 1,
        codex_bin: Some(
            workspace_bin("sling-harness-codex", "fake-codex")
                .display()
                .to_string(),
        ),
        claude_bin: Some(
            workspace_bin("sling-harness-claude-code", "fake-claude")
                .display()
                .to_string(),
        ),
        ..Config::default()
    };
    let mgr = Manager::new(paths.clone(), cfg).unwrap();
    mgr.chats
        .set_mcp_command(workspace_bin("sling-runner", "sling-runner"));
    Env {
        _dir: dir,
        mgr,
        paths,
        tools,
    }
}

fn turn(env: &Env, agent: &str, id: &str, prompt: &str) -> ChatTurn {
    ChatTurn {
        turn_id: id.into(),
        harness: agent.into(),
        prompt: prompt.into(),
        instructions: "You are Sling's assistant.".into(),
        tools_url: format!("{}/tools", env.tools.url),
        tools_token: TOKEN.into(),
        ..Default::default()
    }
}

/// Events for one turn until its ChatDone.
async fn collect(rx: &mut mpsc::Receiver<Body>, id: &str) -> (Vec<Kind>, ChatDone) {
    let mut events = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let body = tokio::time::timeout_at(deadline.into(), rx.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out; saw {events:?}"))
            .expect("channel open");
        let Body::ChatEvent(ev) = body else {
            panic!("not a chat event: {body:?}")
        };
        assert_eq!(ev.turn_id, id);
        match ev.kind.unwrap() {
            Kind::Done(done) => return (events, done),
            other => events.push(other),
        }
    }
}

async fn run(env: &Env, t: ChatTurn) -> (Vec<Kind>, ChatDone) {
    let (tx, mut rx) = mpsc::channel(256);
    let id = t.turn_id.clone();
    env.mgr.chat_turn(t, &all_ready(), tx);
    collect(&mut rx, &id).await
}

fn deltas(events: &[Kind]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            Kind::Delta(d) => Some(d.text.as_str()),
            _ => None,
        })
        .collect()
}

/// The working directory the fake names in its reply.
fn reported_dir(text: &str) -> PathBuf {
    let first = text.lines().next().unwrap();
    let (_, dir) = first.split_once(" instructions, in ").unwrap();
    PathBuf::from(dir.strip_suffix('.').unwrap())
}

#[tokio::test]
async fn a_turn_streams_its_reply_and_finishes_with_a_session() {
    let env = setup();
    for agent in AGENTS {
        let (events, done) = run(&env, turn(&env, agent, &format!("{agent}-1"), "hello")).await;
        assert_eq!(done.error, "", "{agent}");
        assert!(!events.is_empty(), "{agent}: text streams before the end");
        assert_eq!(deltas(&events), done.text, "{agent}");
        assert!(
            done.text.contains("new session, with instructions"),
            "{agent}: {}",
            done.text
        );
        assert!(done.text.ends_with("You said: hello"), "{agent}");
        assert!(!done.session_id.is_empty(), "{agent}");
        assert!(done.input_tokens > 0 && done.output_tokens > 0, "{agent}");
    }
    assert_eq!(env.mgr.chats.running_count(), 0);
}

#[tokio::test]
async fn the_agent_calls_slings_tools_through_the_bridge() {
    let env = setup();
    for agent in AGENTS {
        let (events, done) = run(
            &env,
            turn(
                &env,
                agent,
                &format!("{agent}-tool"),
                "[fake:tool] what machines?",
            ),
        )
        .await;
        assert_eq!(done.error, "", "{agent}");
        let tools: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                Kind::ToolUse(t) => Some(t.name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(tools, ["list_machines"], "{agent}");
        assert_eq!(
            done.text, "Tool said: You have 2 machines: laptop, desktop.",
            "{agent}"
        );
    }
    let requests = env.tools.requests();
    let seen: Vec<(&str, &str)> = requests
        .iter()
        .map(|r| (r.method.as_str(), r.path.as_str()))
        .collect();
    assert_eq!(
        seen,
        [
            ("GET", "/tools"),
            ("POST", "/tools/list_machines"),
            ("GET", "/tools"),
            ("POST", "/tools/list_machines")
        ]
    );
    let bearer = format!("Bearer {TOKEN}");
    assert!(requests.iter().all(|r| r.auth.as_deref() == Some(&bearer)));
    assert_eq!(requests[1].body, r#"{"arguments":{}}"#);
}

#[tokio::test]
async fn resumes_a_session_or_starts_over_with_the_history() {
    let env = setup();
    let history = "User: which repos do I have?\nAssistant: site and api.";
    for agent in AGENTS {
        let (_, first) = run(&env, turn(&env, agent, &format!("{agent}-r1"), "hello")).await;
        assert_eq!(first.error, "", "{agent}");

        let mut t = turn(&env, agent, &format!("{agent}-r2"), "and now?");
        t.session_id = first.session_id.clone();
        t.history = history.into();
        let (_, second) = run(&env, t).await;
        assert_eq!(second.error, "", "{agent}");
        assert!(
            second.text.contains("resumed session"),
            "{agent}: {}",
            second.text
        );
        assert!(
            !second.text.contains("site and api"),
            "{agent}: a resumed session has its own history"
        );
        assert_eq!(second.session_id, first.session_id, "{agent}");

        for gone in ["00000000-dead-4000-8000-000000000000", "--not-a-session"] {
            let mut t = turn(&env, agent, &format!("{agent}-r3{gone}"), "and now?");
            t.session_id = gone.into();
            t.history = history.into();
            let (_, third) = run(&env, t).await;
            assert_eq!(third.error, "", "{agent}");
            assert!(
                third.text.contains("new session"),
                "{agent}: {}",
                third.text
            );
            assert!(
                third.text.contains("which repos do I have?")
                    && third.text.contains("site and api."),
                "{agent}: the history comes first: {}",
                third.text
            );
            assert!(third.text.ends_with("and now?"), "{agent}");
            assert!(!third.session_id.is_empty(), "{agent}");
            assert_ne!(
                third.session_id, gone,
                "{agent}: the new session is reported"
            );
        }
    }
}

#[tokio::test]
async fn cancel_ends_a_turn_with_an_error() {
    let env = setup();
    for agent in AGENTS {
        let id = format!("{agent}-cancel");
        let (tx, mut rx) = mpsc::channel(256);
        env.mgr
            .chat_turn(turn(&env, agent, &id, "[fake:hang]"), &all_ready(), tx);
        let Some(Body::ChatEvent(first)) = rx.recv().await else {
            panic!("{agent}: expected a chat event");
        };
        assert!(matches!(first.kind, Some(Kind::Delta(_))), "{agent}");
        let started = Instant::now();
        env.mgr.chat_cancel(&id);
        let (_, done) = collect(&mut rx, &id).await;
        assert_eq!(done.error, "Cancelled.", "{agent}");
        assert!(done.text.starts_with("Working on it."), "{agent}");
        assert!(started.elapsed() < Duration::from_secs(8), "{agent}");
    }
    assert_eq!(env.mgr.chats.running_count(), 0);
}

#[tokio::test]
async fn each_turn_gets_its_own_directory_and_it_is_removed() {
    let env = setup();
    let mut dirs = Vec::new();
    for agent in AGENTS {
        let (_, done) = run(&env, turn(&env, agent, &format!("{agent}-dir"), "hi")).await;
        let dir = reported_dir(&done.text);
        assert!(
            dir.parent().unwrap().ends_with("data/chat"),
            "{agent}: {}",
            dir.display()
        );
        assert!(!dir.exists(), "{agent}: {} is gone", dir.display());
        dirs.push(dir);
    }
    assert_ne!(dirs[0], dirs[1]);
    let left: Vec<_> = std::fs::read_dir(env.paths.chat_dir()).unwrap().collect();
    assert!(left.is_empty(), "{left:?}");

    // A directory left behind by a Runner that stopped mid-turn goes at start.
    let stale = env.paths.chat_dir().join("0123456789abcdef");
    std::fs::create_dir_all(&stale).unwrap();
    std::fs::write(stale.join("sling-mcp.json"), "{}").unwrap();
    let _again = Manager::new(env.paths.clone(), env.mgr.config()).unwrap();
    assert!(!stale.exists());
}

#[tokio::test]
async fn refuses_turns_it_cannot_run() {
    let env = setup();
    let cases: Vec<(ChatTurn, Vec<String>, &str)> = vec![
        (
            turn(&env, "opencode", "x1", "hi"),
            all_ready(),
            "Unknown coding agent \"opencode\".",
        ),
        (
            turn(&env, "claude-code", "x2", "hi"),
            vec!["codex".into()],
            "Claude Code is not installed or not logged in on this machine.",
        ),
        (
            ChatTurn {
                model: "gpt\" -c sandbox_mode=\"danger-full-access".into(),
                ..turn(&env, "codex", "x3", "hi")
            },
            all_ready(),
            "Refusing model",
        ),
        (
            ChatTurn {
                effort: "--yolo".into(),
                ..turn(&env, "claude-code", "x4", "hi")
            },
            all_ready(),
            "Refusing effort",
        ),
        (
            ChatTurn {
                tools_url: "file:///etc/passwd".into(),
                ..turn(&env, "codex", "x5", "hi")
            },
            all_ready(),
            "Refusing tools URL",
        ),
    ];
    for (t, ready, want) in cases {
        let id = t.turn_id.clone();
        let (tx, mut rx) = mpsc::channel(16);
        env.mgr.chat_turn(t, &ready, tx);
        let (events, done) = collect(&mut rx, &id).await;
        assert!(events.is_empty(), "{id}");
        assert!(done.error.starts_with(want), "{id}: {}", done.error);
    }
    assert!(env.tools.requests().is_empty());
}

#[tokio::test]
async fn runs_at_most_four_turns_alongside_tasks() {
    let env = setup();
    let (tx, mut rx) = mpsc::channel(256);
    for i in 0..4 {
        let agent = AGENTS[i % 2];
        env.mgr.chat_turn(
            turn(&env, agent, &format!("busy-{i}"), "[fake:hang]"),
            &all_ready(),
            tx.clone(),
        );
    }
    let mut started = std::collections::HashSet::new();
    while started.len() < 4 {
        let Some(Body::ChatEvent(ev)) = rx.recv().await else {
            panic!("expected chat events");
        };
        assert!(matches!(ev.kind, Some(Kind::Delta(_))), "{ev:?}");
        started.insert(ev.turn_id);
    }
    assert_eq!(env.mgr.chats.running_count(), 4);
    assert_eq!(env.mgr.running_count(), 0, "turns aren't tasks");

    let (tx5, mut rx5) = mpsc::channel(16);
    env.mgr
        .chat_turn(turn(&env, "codex", "busy-4", "hi"), &all_ready(), tx5);
    let (_, done) = collect(&mut rx5, "busy-4").await;
    assert_eq!(done.error, "This machine is already running 4 chat turns.");

    // A repeat of a running turn is ignored.
    env.mgr.chat_turn(
        turn(&env, "codex", "busy-0", "hi"),
        &all_ready(),
        tx.clone(),
    );
    for i in 0..4 {
        env.mgr.chat_cancel(&format!("busy-{i}"));
    }
    let mut finished = 0;
    while finished < 4 {
        let Some(Body::ChatEvent(ev)) = rx.recv().await else {
            panic!("expected chat events");
        };
        if let Some(Kind::Done(done)) = ev.kind {
            assert_eq!(done.error, "Cancelled.", "{}", ev.turn_id);
            finished += 1;
        }
    }
    assert_eq!(env.mgr.chats.running_count(), 0);
}

#[tokio::test]
async fn a_dropped_connection_stops_its_turns() {
    let env = setup();
    for agent in AGENTS {
        let (tx, mut rx) = mpsc::channel(256);
        env.mgr.chat_turn(
            turn(&env, agent, &format!("{agent}-drop"), "[fake:hang]"),
            &all_ready(),
            tx,
        );
        assert!(matches!(rx.recv().await, Some(Body::ChatEvent(_))));
        drop(rx);
        let deadline = Instant::now() + Duration::from_secs(8);
        while env.mgr.chats.running_count() > 0 {
            assert!(Instant::now() < deadline, "{agent}: the turn kept running");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    let left: Vec<_> = std::fs::read_dir(env.paths.chat_dir()).unwrap().collect();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn a_new_session_gets_the_history_first() {
    use crate::chat::new_session_prompt;
    assert_eq!(new_session_prompt("", "hi"), "hi");
    assert_eq!(new_session_prompt("  \n", "hi"), "hi");
    let p = new_session_prompt("User: a\nAssistant: b\n", "next");
    assert!(p.starts_with("The conversation so far"));
    assert!(p.contains("<conversation>\nUser: a\nAssistant: b\n</conversation>"));
    assert!(p.ends_with("\n\nnext"));
}
