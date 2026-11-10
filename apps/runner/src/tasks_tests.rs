//! Policy tests for the task manager against real git repos and scripted
//! stand-ins for Codex and Claude Code. These cover the Runner-side guards
//! that hold even if the control plane misbehaves, and run once per agent,
//! since everything but the agent itself is shared.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sling_runner_protocol::{
    ActionRequest, PermissionMode, RepoChange, TaskAssign, TaskEvent, action_request,
    action_result, repo_change, task_event::Kind, task_finished, task_rejected,
};

use crate::config::{Config, Mode, Paths, RepoEntry};
use crate::spool::{SpoolState, TaskMeta, TaskSpool};
use crate::tasks::Manager;
use sling_runner_protocol::envelope::Body;
use tokio::sync::mpsc;

/// Reports the sensitive variables it can see as an agent message.
const ENV_REPORT: &str = r#"seen=$(env | cut -d= -f1 | grep -E '^(SLING_|GH_TOKEN$|GITHUB_TOKEN$|OPENAI_API_KEY$|ANTHROPIC_API_KEY$)' | sort | tr '\n' ' ')"#;

/// Writes CHANGED.md (reported) and build.log (not reported) unless the run
/// is read-only, like a test run that leaves build output behind.
const FAKE_CODEX: &str = r#"#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.166.0" ;;
  login) echo "Logged in using test" ;;
  exec)
    prompt=$(cat)
    case "$prompt" in *"[hang]"*)
      echo '{"type":"thread.started","thread_id":"t1"}'
      while true; do sleep 0.05; done ;;
    esac
    sandbox=""; dir="."; settings=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -s) sandbox="$2"; shift ;;
        -C) dir="$2"; shift ;;
        -m) settings="$settings model=$2"; shift ;;
        -c)
          case "$2" in model_reasoning_effort=*|service_tier=*)
            settings="$settings $(printf '%s' "$2" | tr -d '"')" ;;
          esac
          shift ;;
      esac
      shift
    done
    echo "{\"type\":\"item.completed\",\"item\":{\"id\":\"s1\",\"type\":\"agent_message\",\"text\":\"settings:$settings\"}}"
    if [ "$sandbox" != "read-only" ]; then
      echo "changed" >> "$dir/CHANGED.md"
      echo "build output" > "$dir/build.log"
      echo "{\"type\":\"item.completed\",\"item\":{\"id\":\"f1\",\"type\":\"file_change\",\"changes\":[{\"path\":\"$dir/CHANGED.md\",\"kind\":\"add\"}],\"status\":\"completed\"}}"
    fi
    ENV_REPORT
    echo "{\"type\":\"item.completed\",\"item\":{\"id\":\"e1\",\"type\":\"agent_message\",\"text\":\"env: $seen\"}}"
    echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done"}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
    ;;
esac
"#;

/// The same behavior in Claude Code's stream-json shape. Claude Code runs in
/// the worktree, so the paths come from the working directory.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
case "$1" in
  --version) echo "2.1.318 (Claude Code)" ;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}' ;;
  -p)
    prompt=$(cat)
    case "$prompt" in *"[hang]"*)
      # Like Claude Code: an interrupt ends the run with an error result and exit 0.
      trap 'echo "{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true}"; exit 0' INT
      echo '{"type":"system","subtype":"init","session_id":"s1","model":"m"}'
      while true; do sleep 0.05; done ;;
    esac
    mode=""; settings=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --permission-mode) mode="$2"; shift ;;
        --dangerously-skip-permissions) mode="bypassPermissions" ;;
        --model) settings="$settings model=$2"; shift ;;
        --effort) settings="$settings effort=$2"; shift ;;
        --settings) case "$2" in *fastMode*) settings="$settings fast" ;; esac; shift ;;
      esac
      shift
    done
    dir="$PWD"
    echo "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s1\",\"model\":\"m\",\"permissionMode\":\"$mode\"}"
    echo "{\"type\":\"assistant\",\"message\":{\"id\":\"m0\",\"content\":[{\"type\":\"text\",\"text\":\"settings:$settings\"}]},\"parent_tool_use_id\":null}"
    if [ "$mode" != "plan" ]; then
      echo "changed" >> "$dir/CHANGED.md"
      echo "build output" > "$dir/build.log"
      echo "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"w1\",\"name\":\"Write\",\"input\":{\"file_path\":\"$dir/CHANGED.md\",\"content\":\"changed\"}}]},\"parent_tool_use_id\":null}"
      echo "{\"type\":\"user\",\"message\":{\"content\":[{\"tool_use_id\":\"w1\",\"type\":\"tool_result\",\"content\":\"ok\"}]},\"parent_tool_use_id\":null,\"tool_use_result\":{\"type\":\"create\",\"filePath\":\"$dir/CHANGED.md\"}}"
    fi
    ENV_REPORT
    echo "{\"type\":\"assistant\",\"message\":{\"id\":\"m2\",\"content\":[{\"type\":\"text\",\"text\":\"env: $seen\"}]},\"parent_tool_use_id\":null}"
    echo '{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}'
    ;;
esac
"#;

const AGENTS: [&str; 2] = ["codex", "claude-code"];

fn all_ready() -> Vec<String> {
    AGENTS.iter().map(|a| a.to_string()).collect()
}

struct Env {
    _dir: tempfile::TempDir,
    mgr: Arc<Manager>,
    remote: PathBuf,
}

fn git(dir: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=t"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?}");
}

fn script(path: &Path, body: &str) {
    std::fs::write(path, body.replace("ENV_REPORT", ENV_REPORT)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn setup(max_mode: Mode) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let remote = root.join("remote.git");
    let repo = root.join("site");
    std::fs::create_dir_all(&repo).unwrap();
    git(
        root,
        &[
            "init",
            "-q",
            "--bare",
            "-b",
            "main",
            remote.to_str().unwrap(),
        ],
    );
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "# site\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    git(
        &repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&repo, &["push", "-q", "-u", "origin", "main"]);

    let codex = root.join("fake-codex.sh");
    script(&codex, FAKE_CODEX);
    let claude = root.join("fake-claude.sh");
    script(&claude, FAKE_CLAUDE);

    let paths = Paths {
        config_dir: root.join("home"),
        data_dir: root.join("home/data"),
    };
    let cfg = Config {
        server_url: Some("http://localhost".into()),
        runner_id: Some("rnr_test".into()),
        max_mode,
        max_concurrent_tasks: 4,
        codex_bin: Some(codex.display().to_string()),
        claude_bin: Some(claude.display().to_string()),
        repos: vec![RepoEntry {
            name: "site".into(),
            path: std::fs::canonicalize(&repo).unwrap(),
            network: false,
            ..RepoEntry::default()
        }],
        ..Config::default()
    };
    let mgr = Manager::new(paths, cfg).unwrap();
    Env {
        _dir: dir,
        mgr,
        remote,
    }
}

fn assign(agent: &str, id: &str, mode: PermissionMode, branch: &str, repo: &str) -> TaskAssign {
    TaskAssign {
        task_id: id.into(),
        repo: repo.into(),
        title: "Change something".into(),
        objective: "Edit a file.".into(),
        mode: mode as i32,
        harness: agent.into(),
        branch: branch.into(),
        ..Default::default()
    }
}

/// Waits until `pred` matches an event for `task_id`, collecting along the way.
async fn wait_for(
    mgr: &Arc<Manager>,
    task_id: &str,
    pred: impl Fn(&Kind) -> bool,
) -> Vec<TaskEvent> {
    let mut seen = Vec::new();
    for _ in 0..200 {
        for ev in mgr.unsent() {
            if ev.task_id == task_id {
                seen.push(ev);
            }
        }
        if seen.iter().any(|e| e.kind.as_ref().is_some_and(&pred)) {
            return seen;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!(
        "timed out waiting for event; saw {:?}",
        seen.iter().map(|e| &e.kind).collect::<Vec<_>>()
    );
}

fn rejected(events: &[TaskEvent]) -> Option<(task_rejected::Reason, String)> {
    events.iter().find_map(|e| match &e.kind {
        Some(Kind::Rejected(r)) => Some((r.reason(), r.message.clone())),
        _ => None,
    })
}

fn rejected_reason(events: &[TaskEvent]) -> Option<task_rejected::Reason> {
    rejected(events).map(|(r, _)| r)
}

fn finished(events: &[TaskEvent]) -> sling_runner_protocol::TaskFinished {
    events
        .iter()
        .find_map(|e| match &e.kind {
            Some(Kind::Finished(f)) => Some(f.clone()),
            _ => None,
        })
        .expect("a finished event")
}

#[tokio::test]
async fn refuses_a_branch_that_is_the_default_branch() {
    let env = setup(Mode::FullAccess);
    for agent in AGENTS {
        let id = format!("{agent}-t1");
        env.mgr
            .assign(
                assign(agent, &id, PermissionMode::FullAccess, "main", "site"),
                &all_ready(),
            )
            .await;
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Rejected(_))).await;
        assert_eq!(
            rejected_reason(&events),
            Some(task_rejected::Reason::Invalid),
            "{agent}"
        );
    }
}

#[tokio::test]
async fn refuses_a_mode_above_the_local_cap() {
    let env = setup(Mode::Supervised);
    for agent in AGENTS {
        let id = format!("{agent}-t2");
        env.mgr
            .assign(
                assign(agent, &id, PermissionMode::FullAccess, "sling/t2", "site"),
                &all_ready(),
            )
            .await;
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Rejected(_))).await;
        assert_eq!(
            rejected_reason(&events),
            Some(task_rejected::Reason::ModeAboveCap),
            "{agent}"
        );
    }
}

#[test]
fn a_reloaded_config_keeps_the_pairing_the_runner_started_with() {
    let env = setup(Mode::Auto);
    let mut next = env.mgr.config();
    next.runner_id = Some("rnr_other".into());
    next.server_url = Some("https://other.example".into());
    next.max_concurrent_tasks = 2;
    env.mgr.set_config(next);
    let cfg = env.mgr.config();
    assert_eq!(cfg.runner_id.as_deref(), Some("rnr_test"));
    assert_eq!(cfg.server_url.as_deref(), Some("http://localhost"));
    assert_eq!(cfg.max_concurrent_tasks, 2);
}

#[tokio::test]
async fn refuses_a_repo_that_is_not_in_the_local_config() {
    let env = setup(Mode::FullAccess);
    for agent in AGENTS {
        let id = format!("{agent}-t3");
        env.mgr
            .assign(
                assign(agent, &id, PermissionMode::Auto, "sling/t3", "secrets"),
                &all_ready(),
            )
            .await;
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Rejected(_))).await;
        assert_eq!(
            rejected_reason(&events),
            Some(task_rejected::Reason::UnknownRepo),
            "{agent}"
        );
    }
}

#[tokio::test]
async fn refuses_an_agent_that_is_not_ready_or_unknown() {
    let env = setup(Mode::FullAccess);
    env.mgr
        .assign(
            assign(
                "claude-code",
                "t8",
                PermissionMode::Auto,
                "sling/t8",
                "site",
            ),
            &["codex".to_string()],
        )
        .await;
    let events = wait_for(&env.mgr, "t8", |k| matches!(k, Kind::Rejected(_))).await;
    let (reason, message) = rejected(&events).unwrap();
    assert_eq!(reason, task_rejected::Reason::HarnessUnavailable);
    assert_eq!(
        message,
        "Claude Code is not installed or not logged in on this machine."
    );

    env.mgr
        .assign(
            assign("opencode", "t9", PermissionMode::Auto, "sling/t9", "site"),
            &all_ready(),
        )
        .await;
    let events = wait_for(&env.mgr, "t9", |k| matches!(k, Kind::Rejected(_))).await;
    assert_eq!(
        rejected_reason(&events),
        Some(task_rejected::Reason::HarnessUnavailable)
    );
}

#[tokio::test]
async fn commits_and_pushes_the_task_branch() {
    for agent in AGENTS {
        let env = setup(Mode::FullAccess);
        let id = format!("{agent}-t4");
        let branch = format!("sling/t4-{agent}");
        env.mgr
            .assign(
                assign(agent, &id, PermissionMode::Auto, &branch, "site"),
                &all_ready(),
            )
            .await;
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Finished(_))).await;
        let done = finished(&events);
        assert_eq!(
            done.outcome(),
            task_finished::Outcome::Succeeded,
            "{agent}: {done:?}"
        );
        assert_eq!(done.summary, "done", "{agent}");
        assert!(!done.commit_sha.is_empty(), "{agent}");
        // CHANGED.md was reported by the agent; build.log wasn't, so it stays out.
        assert_eq!(done.diff_stats.unwrap().files_changed, 1, "{agent}");
        let left_out_logged = events
            .iter()
            .any(|e| matches!(&e.kind, Some(Kind::Log(l)) if l.text.contains("build.log")));
        assert!(left_out_logged, "{agent}: the left-out file is in the log");
        let started = events
            .iter()
            .find_map(|e| match &e.kind {
                Some(Kind::Started(s)) => Some(s.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(started.harness, agent);
        assert!(!started.harness_version.is_empty(), "{agent}");

        env.mgr
            .action(ActionRequest {
                action_id: "a1".into(),
                task_id: id.clone(),
                kind: action_request::Kind::Push as i32,
                ..Default::default()
            })
            .await;
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::ActionResult(_))).await;
        let result = events
            .iter()
            .find_map(|e| match &e.kind {
                Some(Kind::ActionResult(r)) => Some(r.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            result.outcome(),
            action_result::Outcome::Succeeded,
            "{agent}: {result:?}"
        );
        let branches = std::process::Command::new("git")
            .args(["branch", "--list", &branch])
            .current_dir(&env.remote)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).contains(&branch));
        // The default branch on the remote is untouched.
        let main = std::process::Command::new("git")
            .args(["log", "--oneline", "main"])
            .current_dir(&env.remote)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&main.stdout).lines().count(), 1);
    }
}

#[tokio::test]
async fn read_only_tasks_change_nothing_and_cannot_push() {
    let env = setup(Mode::FullAccess);
    for agent in AGENTS {
        let id = format!("{agent}-t5");
        env.mgr
            .assign(
                assign(
                    agent,
                    &id,
                    PermissionMode::ReadOnly,
                    &format!("sling/t5-{agent}"),
                    "site",
                ),
                &all_ready(),
            )
            .await;
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Finished(_))).await;
        let done = finished(&events);
        assert_eq!(done.outcome(), task_finished::Outcome::Succeeded, "{agent}");
        assert!(done.commit_sha.is_empty(), "{agent}");

        env.mgr
            .action(ActionRequest {
                action_id: "a2".into(),
                task_id: id.clone(),
                kind: action_request::Kind::Push as i32,
                ..Default::default()
            })
            .await;
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::ActionResult(_))).await;
        let outcome = events.iter().find_map(|e| match &e.kind {
            Some(Kind::ActionResult(r)) => Some(r.outcome()),
            _ => None,
        });
        assert_eq!(outcome, Some(action_result::Outcome::Refused), "{agent}");
    }
}

#[tokio::test]
async fn a_cancel_that_arrives_first_still_wins() {
    let env = setup(Mode::FullAccess);
    for agent in AGENTS {
        let id = format!("{agent}-t6");
        env.mgr.cancel(&id);
        env.mgr
            .assign(
                assign(agent, &id, PermissionMode::Auto, "sling/t6", "site"),
                &all_ready(),
            )
            .await;
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Finished(_))).await;
        assert_eq!(
            finished(&events).outcome(),
            task_finished::Outcome::Cancelled,
            "{agent}"
        );
    }
}

#[tokio::test]
async fn cancelling_a_running_task_stops_the_agent() {
    let env = setup(Mode::FullAccess);
    for agent in AGENTS {
        let id = format!("{agent}-t10");
        let mut a = assign(
            agent,
            &id,
            PermissionMode::Auto,
            &format!("sling/t10-{agent}"),
            "site",
        );
        a.objective = "[hang]".into();
        env.mgr.assign(a, &all_ready()).await;
        wait_for(
            &env.mgr,
            &id,
            |k| matches!(k, Kind::Log(l) if l.text.contains("session")),
        )
        .await;
        env.mgr.cancel(&id);
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Finished(_))).await;
        let done = finished(&events);
        assert_eq!(
            done.outcome(),
            task_finished::Outcome::Cancelled,
            "{agent}: {done:?}"
        );
        assert!(done.commit_sha.is_empty(), "{agent}");
    }
}

#[tokio::test]
async fn stopping_the_runner_interrupts_running_tasks() {
    let env = setup(Mode::FullAccess);
    for agent in AGENTS {
        let id = format!("{agent}-t11");
        let mut a = assign(
            agent,
            &id,
            PermissionMode::Auto,
            &format!("sling/t11-{agent}"),
            "site",
        );
        a.objective = "[hang]".into();
        env.mgr.assign(a, &all_ready()).await;
        wait_for(
            &env.mgr,
            &id,
            |k| matches!(k, Kind::Log(l) if l.text.contains("session")),
        )
        .await;
        env.mgr.interrupt_all();
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Finished(_))).await;
        let done = finished(&events);
        assert_eq!(
            done.outcome(),
            task_finished::Outcome::Interrupted,
            "{agent}: {done:?}"
        );
    }
}

#[tokio::test]
async fn the_agent_never_sees_sling_variables_or_tokens() {
    // SAFETY: tests only add variables; nothing reads these concurrently in a
    // way that matters.
    unsafe {
        std::env::set_var("SLING_TEST_ONLY", "1");
        std::env::set_var("GH_TOKEN", "gh-test-token-value");
        std::env::set_var("OPENAI_API_KEY", "sk-test-only-value");
        std::env::set_var("ANTHROPIC_API_KEY", "sk-ant-test-only-value");
    }
    let env = setup(Mode::FullAccess);
    env.mgr.remove_from_agent_env("codex", "OPENAI_API_KEY");
    env.mgr.remove_from_agent_env("codex", "ANTHROPIC_API_KEY");
    env.mgr
        .remove_from_agent_env("claude-code", "OPENAI_API_KEY");
    for (agent, want) in [("codex", "env:"), ("claude-code", "env: ANTHROPIC_API_KEY")] {
        let id = format!("{agent}-t7");
        env.mgr
            .assign(
                assign(
                    agent,
                    &id,
                    PermissionMode::Auto,
                    &format!("sling/t7-{agent}"),
                    "site",
                ),
                &all_ready(),
            )
            .await;
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Finished(_))).await;
        let seen = events
            .iter()
            .find_map(|e| match &e.kind {
                Some(Kind::AgentMessage(m)) if m.text.starts_with("env:") => Some(m.text.clone()),
                _ => None,
            })
            .expect("the fake reports its environment");
        assert_eq!(seen.trim(), want, "{agent}");
    }
}

fn agent_said(events: &[TaskEvent], prefix: &str) -> Option<String> {
    events.iter().find_map(|e| match &e.kind {
        Some(Kind::AgentMessage(m)) if m.text.starts_with(prefix) => Some(m.text.clone()),
        _ => None,
    })
}

fn logged(events: &[TaskEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match &e.kind {
            Some(Kind::Log(l)) => Some(l.text.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn model_settings_reach_each_agent() {
    let env = setup(Mode::FullAccess);
    for (agent, model, want, note) in [
        (
            "codex",
            "fake-mini",
            "settings: model=fake-mini model_reasoning_effort=high service_tier=fast",
            "Codex: model fake-mini, effort high, fast tier",
        ),
        (
            "claude-code",
            "opus",
            "settings: model=opus effort=high fast",
            "Claude Code: model opus, effort high, fast tier",
        ),
        (
            "claude-code",
            "claude-haiku-5-5",
            "settings: model=claude-haiku-5-5 effort=high",
            "Claude Code: model claude-haiku-5-5, effort high, no fast tier (claude-haiku-5-5 doesn't have one)",
        ),
    ] {
        let id = format!("{agent}-m1-{model}");
        let mut a = assign(
            agent,
            &id,
            PermissionMode::Auto,
            &format!("sling/m1-{agent}-{model}"),
            "site",
        );
        a.model = model.into();
        a.effort = "high".into();
        a.fast = true;
        env.mgr.assign(a, &all_ready()).await;
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Finished(_))).await;
        assert_eq!(
            finished(&events).outcome(),
            task_finished::Outcome::Succeeded,
            "{agent}"
        );
        assert_eq!(agent_said(&events, "settings:").as_deref(), Some(want));
        assert!(logged(&events).iter().any(|l| l == note), "{agent}");
    }
}

#[tokio::test]
async fn empty_model_settings_leave_the_agents_defaults() {
    let env = setup(Mode::FullAccess);
    for agent in AGENTS {
        let id = format!("{agent}-m2");
        env.mgr
            .assign(
                assign(
                    agent,
                    &id,
                    PermissionMode::Auto,
                    &format!("sling/m2-{agent}"),
                    "site",
                ),
                &all_ready(),
            )
            .await;
        let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Finished(_))).await;
        assert_eq!(
            agent_said(&events, "settings:").as_deref(),
            Some("settings:"),
            "{agent}"
        );
    }
}

#[tokio::test]
async fn refuses_model_settings_that_could_inject_options() {
    let env = setup(Mode::FullAccess);
    let cases: [(&str, &str); 4] = [
        ("x\" sandbox_mode=\"danger-full-access", ""),
        ("--dangerously-skip-permissions", ""),
        ("", "high\"\napproval_policy=\"never"),
        ("", &"x".repeat(65)),
    ];
    for agent in AGENTS {
        for (i, (model, effort)) in cases.iter().enumerate() {
            let id = format!("{agent}-m3-{i}");
            let mut a = assign(
                agent,
                &id,
                PermissionMode::Auto,
                &format!("sling/m3-{agent}-{i}"),
                "site",
            );
            a.model = model.to_string();
            a.effort = effort.to_string();
            env.mgr.assign(a, &all_ready()).await;
            let events = wait_for(&env.mgr, &id, |k| matches!(k, Kind::Rejected(_))).await;
            let (reason, message) = rejected(&events).unwrap();
            assert_eq!(reason, task_rejected::Reason::Invalid, "{agent} {i}");
            assert!(message.starts_with("Refusing "), "{message}");
        }
    }
}

#[tokio::test]
async fn a_restart_stops_an_agent_left_running() {
    for (agent, marker) in [("codex", "codex"), ("claude-code", "claude")] {
        let dir = tempfile::tempdir().unwrap();
        // A process whose command line names the agent, in its own group.
        let bin = dir.path().join(format!("fake-{marker}-sleep"));
        std::fs::copy("/bin/sleep", &bin).unwrap();
        let mut child = {
            use std::os::unix::process::CommandExt;
            std::process::Command::new(&bin)
                .arg("30")
                .process_group(0)
                .spawn()
                .unwrap()
        };
        let paths = Paths {
            config_dir: dir.path().join("home"),
            data_dir: dir.path().join("home/data"),
        };
        let meta = TaskMeta {
            task_id: format!("{agent}-orphan"),
            repo: "site".into(),
            title: "t".into(),
            objective: "o".into(),
            mode: Mode::Auto,
            harness: agent.into(),
            branch: "sling/x".into(),
            default_branch: "main".into(),
            worktree: None,
            base_sha: None,
            harness_pid: Some(child.id()),
            state: SpoolState::Running,
            created_ms: 0,
        };
        TaskSpool::create(&paths.spool_dir(), meta).unwrap();

        let mgr = Manager::new(paths, Config::default()).unwrap();
        let mut status = None;
        for _ in 0..100 {
            status = child.try_wait().unwrap();
            if status.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(status.is_some(), "{agent}: the leftover process was killed");
        let events: Vec<_> = mgr.unsent();
        assert!(
            events
                .iter()
                .any(|e| matches!(&e.kind, Some(Kind::Finished(f))
                if f.outcome() == task_finished::Outcome::Interrupted)),
            "{agent}"
        );
    }
}

/// Makes a committed repo at `root/<rel>` and returns its canonical path.
fn make_repo(root: &Path, rel: &str) -> PathBuf {
    let dir = root.join(rel);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "init"]);
    std::fs::canonicalize(dir).unwrap()
}

/// Saves the manager's config with the temp dir as the only scan root, so
/// repo changes (which read the config from disk) see it.
fn scan_here(env: &Env, edit: impl FnOnce(&mut Config)) -> PathBuf {
    let root = std::fs::canonicalize(env._dir.path()).unwrap();
    let mut cfg = env.mgr.config();
    cfg.scan_roots = vec![root.clone()];
    edit(&mut cfg);
    cfg.save(&env.mgr.paths).unwrap();
    env.mgr.set_config(cfg);
    root
}

fn repo_change(op: repo_change::Op, path: &Path, name: &str) -> RepoChange {
    RepoChange {
        request_id: "rc1".into(),
        op: op as i32,
        path: path.display().to_string(),
        name: name.into(),
        paths: vec![],
    }
}

#[tokio::test]
async fn adds_several_found_repos_in_one_change() {
    let env = setup(Mode::FullAccess);
    let root = scan_here(&env, |_| {});
    let api = make_repo(&root, "code/api");
    let docs = make_repo(&root, "code/docs");
    let other_site = make_repo(&root, "work/site");
    env.mgr.rescan().await;
    let (tx, mut rx) = mpsc::channel(16);
    let req = RepoChange {
        request_id: "rc-all".into(),
        op: repo_change::Op::Add as i32,
        paths: [&api, &docs, &other_site, &root.join("nope")]
            .iter()
            .map(|p| p.display().to_string())
            .collect(),
        ..Default::default()
    };
    env.mgr.repo_change_and_report(req, &tx).await;
    drop(tx);
    let mut bodies = Vec::new();
    while let Some(body) = rx.recv().await {
        bodies.push(body);
    }
    let Some(Body::RepoChangeResult(r)) = bodies.first() else {
        panic!("a result first");
    };
    assert!(r.ok, "{}", r.message);
    assert!(
        r.message.starts_with("Added 3 repos: api, docs, site-2."),
        "{}",
        r.message
    );
    assert!(r.message.contains("Skipped 1"), "{}", r.message);
    // One inventory for the whole change, with every new repo in it.
    let inventories: Vec<_> = bodies
        .iter()
        .filter_map(|b| match b {
            Body::Inventory(inv) => Some(inv),
            _ => None,
        })
        .collect();
    assert_eq!(inventories.len(), 1);
    let names: Vec<&str> = inventories[0]
        .repos
        .iter()
        .map(|r| r.name.as_str())
        .collect();
    for name in ["api", "docs", "site-2"] {
        assert!(names.contains(&name), "{names:?}");
    }
    assert!(env.mgr.found().is_empty(), "nothing left to add");
}

#[tokio::test]
async fn adds_a_repo_the_scan_found() {
    let env = setup(Mode::FullAccess);
    let root = scan_here(&env, |_| {});
    let api = make_repo(&root, "code/api");
    let other_site = make_repo(&root, "work/site");
    env.mgr.rescan().await;
    let found: Vec<PathBuf> = env.mgr.found().into_iter().map(|f| f.path).collect();
    assert_eq!(
        found,
        [api.clone(), other_site.clone()],
        "site is configured"
    );

    let (r, changed) = env
        .mgr
        .repo_change(repo_change(repo_change::Op::Add, &api, ""))
        .await;
    assert!(r.ok && changed, "{}", r.message);
    assert_eq!(r.request_id, "rc1");
    assert!(r.message.starts_with("Added api"), "{}", r.message);
    let saved = Config::load(&env.mgr.paths).unwrap();
    let entry = saved.repo("api").expect("saved");
    assert_eq!(entry.path, api);
    assert!(!entry.network, "network stays off");
    assert!(env.mgr.config().repo("api").is_some(), "config reloaded");
    let found: Vec<PathBuf> = env.mgr.found().into_iter().map(|f| f.path).collect();
    assert_eq!(found, std::slice::from_ref(&other_site), "scanned again");

    // The suggested name is made unique against configured repos.
    let (r, _) = env
        .mgr
        .repo_change(repo_change(repo_change::Op::Add, &other_site, ""))
        .await;
    assert!(r.ok, "{}", r.message);
    let saved = Config::load(&env.mgr.paths).unwrap();
    assert_eq!(saved.repo("site-2").unwrap().path, other_site);
}

#[tokio::test]
async fn back_to_back_changes_end_with_an_inventory_that_has_both() {
    let env = setup(Mode::FullAccess);
    let root = scan_here(&env, |_| {});
    let api = make_repo(&root, "code/api");
    let docs = make_repo(&root, "code/docs");
    env.mgr.rescan().await;
    let (tx, mut rx) = mpsc::channel(16);
    let (a, b) = (env.mgr.clone(), env.mgr.clone());
    let (ta, tb) = (tx.clone(), tx.clone());
    let (ra, rd) = (
        repo_change(repo_change::Op::Add, &api, ""),
        repo_change(repo_change::Op::Add, &docs, ""),
    );
    tokio::join!(
        async move { a.repo_change_and_report(ra, &ta).await },
        async move { b.repo_change_and_report(rd, &tb).await },
    );
    drop(tx);
    let mut last = None;
    while let Some(body) = rx.recv().await {
        if let Body::Inventory(inv) = body {
            last = Some(inv);
        }
    }
    let names: Vec<String> = last
        .expect("an inventory")
        .repos
        .into_iter()
        .map(|r| r.name)
        .collect();
    assert!(names.contains(&"api".to_string()), "{names:?}");
    assert!(names.contains(&"docs".to_string()), "{names:?}");
}

#[tokio::test]
async fn adding_takes_a_valid_name() {
    let env = setup(Mode::FullAccess);
    let root = scan_here(&env, |_| {});
    let api = make_repo(&root, "code/api");
    env.mgr.rescan().await;
    for bad in ["has space", "../up", "site"] {
        let (r, changed) = env
            .mgr
            .repo_change(repo_change(repo_change::Op::Add, &api, bad))
            .await;
        assert!(!r.ok && !changed, "{bad}");
    }
    let (r, _) = env
        .mgr
        .repo_change(repo_change(repo_change::Op::Add, &api, "backend"))
        .await;
    assert!(r.ok, "{}", r.message);
    assert_eq!(
        Config::load(&env.mgr.paths)
            .unwrap()
            .repo("backend")
            .unwrap()
            .path,
        api
    );
}

#[tokio::test]
async fn refuses_to_add_a_path_the_scan_did_not_find() {
    let env = setup(Mode::FullAccess);
    let root = scan_here(&env, |_| {});
    let api = make_repo(&root, "code/api");
    env.mgr.rescan().await;
    let later = make_repo(&root, "code/later");
    let not_a_repo = root.join("code");
    let configured = env.mgr.config().repo("site").unwrap().path.clone();
    let with_slash = PathBuf::from(format!("{}/", api.display()));
    for path in [
        later.as_path(),
        not_a_repo.as_path(),
        configured.as_path(),
        with_slash.as_path(),
        Path::new("/etc"),
        Path::new(""),
    ] {
        let (r, changed) = env
            .mgr
            .repo_change(repo_change(repo_change::Op::Add, path, "x"))
            .await;
        assert!(!r.ok && !changed, "{}", path.display());
        assert!(
            r.message.contains("isn't a repo this machine found"),
            "{}",
            r.message
        );
    }
    assert!(Config::load(&env.mgr.paths).unwrap().repo("x").is_none());

    // A found repo that has since stopped being one is refused too.
    std::fs::remove_dir_all(api.join(".git")).unwrap();
    let (r, _) = env
        .mgr
        .repo_change(repo_change(repo_change::Op::Add, &api, ""))
        .await;
    assert!(!r.ok);
    assert!(r.message.contains("no longer a git repo"), "{}", r.message);
}

#[tokio::test]
async fn refuses_repo_changes_when_remote_repos_is_off() {
    let env = setup(Mode::FullAccess);
    let root = scan_here(&env, |_| {});
    let api = make_repo(&root, "code/api");
    env.mgr.rescan().await;
    assert_eq!(env.mgr.found().len(), 1);
    // Turned off on disk only: the change must still be refused.
    let mut cfg = Config::load(&env.mgr.paths).unwrap();
    cfg.remote_repos = false;
    cfg.save(&env.mgr.paths).unwrap();

    let (r, changed) = env
        .mgr
        .repo_change(repo_change(repo_change::Op::Add, &api, ""))
        .await;
    assert!(!r.ok && !changed);
    assert_eq!(r.message, crate::repos::REMOTE_OFF);
    let (r, _) = env
        .mgr
        .repo_change(repo_change(repo_change::Op::Remove, Path::new(""), "site"))
        .await;
    assert!(!r.ok);
    let saved = Config::load(&env.mgr.paths).unwrap();
    assert!(saved.repo("site").is_some() && saved.repo("api").is_none());

    // While off, nothing is scanned or offered.
    env.mgr.set_config(saved.clone());
    env.mgr.rescan().await;
    assert!(env.mgr.found().is_empty());
    let inv = crate::inventory::build(&saved, &[], &crate::exec::Sandbox::Seatbelt).await;
    assert!(!inv.remote_repos && inv.found_repos.is_empty());
}

#[tokio::test]
async fn removes_a_repo_unless_a_task_is_running_in_it() {
    let env = setup(Mode::FullAccess);
    scan_here(&env, |_| {});
    let mut a = assign(
        "codex",
        "busy1",
        PermissionMode::Auto,
        "sling/busy1",
        "site",
    );
    a.objective = "[hang]".into();
    env.mgr.assign(a, &all_ready()).await;
    wait_for(
        &env.mgr,
        "busy1",
        |k| matches!(k, Kind::Log(l) if l.text.contains("session")),
    )
    .await;

    let (r, changed) = env
        .mgr
        .repo_change(repo_change(repo_change::Op::Remove, Path::new(""), "site"))
        .await;
    assert!(!r.ok && !changed);
    assert!(
        r.message.contains("A task is running in site"),
        "{}",
        r.message
    );
    assert!(Config::load(&env.mgr.paths).unwrap().repo("site").is_some());

    env.mgr.cancel("busy1");
    wait_for(&env.mgr, "busy1", |k| matches!(k, Kind::Finished(_))).await;
    for _ in 0..100 {
        if !env.mgr.running_in_repo("site") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (r, changed) = env
        .mgr
        .repo_change(repo_change(repo_change::Op::Remove, Path::new(""), "site"))
        .await;
    assert!(r.ok && changed, "{}", r.message);
    assert!(Config::load(&env.mgr.paths).unwrap().repo("site").is_none());
    assert!(env.mgr.config().repo("site").is_none());

    let (r, _) = env
        .mgr
        .repo_change(repo_change(repo_change::Op::Remove, Path::new(""), "site"))
        .await;
    assert!(!r.ok);
    assert!(r.message.contains("no repo named"), "{}", r.message);
}

#[tokio::test]
async fn the_inventory_offers_found_repos_with_unique_names() {
    let env = setup(Mode::FullAccess);
    let root = scan_here(&env, |_| {});
    let other_site = make_repo(&root, "work/site");
    let remote = env.remote.display().to_string();
    git(&other_site, &["remote", "add", "origin", &remote]);
    env.mgr.rescan().await;
    let inv = crate::inventory::build(
        &env.mgr.config(),
        &env.mgr.found(),
        &crate::exec::Sandbox::Seatbelt,
    )
    .await;
    assert!(inv.remote_repos);
    assert_eq!(inv.found_repos.len(), 1);
    let f = &inv.found_repos[0];
    assert_eq!(f.path, other_site.display().to_string());
    assert_eq!(f.name, "site-2");
    assert_eq!(f.default_branch, "main");
    assert_eq!(f.remote_url, remote);
}
