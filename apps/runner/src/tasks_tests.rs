//! Policy tests for the task manager against real git repos and a scripted
//! stand-in for Codex. These cover the Runner-side guards that hold even if
//! the control plane misbehaves (stage1.md M6 exit criteria).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sling_runner_protocol::{
    ActionRequest, PermissionMode, TaskAssign, TaskEvent, action_request, action_result,
    task_event::Kind, task_finished, task_rejected,
};

use crate::config::{Config, Mode, Paths, RepoEntry};
use crate::tasks::Manager;

const FAKE_CODEX: &str = r#"#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.166.0" ;;
  login) echo "Logged in using test" ;;
  exec)
    cat > /dev/null
    sandbox=""; dir="."
    while [ $# -gt 0 ]; do
      case "$1" in -s) sandbox="$2"; shift ;; -C) dir="$2"; shift ;; esac
      shift
    done
    if [ "$sandbox" != "read-only" ]; then
      echo "changed" >> "$dir/CHANGED.md"
      echo "build output" > "$dir/build.log"
      echo "{\"type\":\"item.completed\",\"item\":{\"id\":\"f1\",\"type\":\"file_change\",\"changes\":[{\"path\":\"$dir/CHANGED.md\",\"kind\":\"add\"}],\"status\":\"completed\"}}"
    fi
    echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done"}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
    ;;
esac
"#;

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
    std::fs::write(&codex, FAKE_CODEX).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let paths = Paths {
        config_dir: root.join("home"),
        data_dir: root.join("home/data"),
    };
    let cfg = Config {
        server_url: Some("http://localhost".into()),
        runner_id: Some("rnr_test".into()),
        max_mode,
        codex_bin: Some(codex.display().to_string()),
        repos: vec![RepoEntry {
            name: "site".into(),
            path: std::fs::canonicalize(&repo).unwrap(),
            network: false,
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

fn assign(id: &str, mode: PermissionMode, branch: &str, repo: &str) -> TaskAssign {
    TaskAssign {
        task_id: id.into(),
        repo: repo.into(),
        title: "Change something".into(),
        objective: "Edit a file.".into(),
        mode: mode as i32,
        harness: "codex".into(),
        branch: branch.into(),
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

fn rejected_reason(events: &[TaskEvent]) -> Option<task_rejected::Reason> {
    events.iter().find_map(|e| match &e.kind {
        Some(Kind::Rejected(r)) => Some(r.reason()),
        _ => None,
    })
}

#[tokio::test]
async fn refuses_a_branch_that_is_the_default_branch() {
    let env = setup(Mode::FullAccess);
    env.mgr
        .assign(
            assign("t1", PermissionMode::FullAccess, "main", "site"),
            true,
        )
        .await;
    let events = wait_for(&env.mgr, "t1", |k| matches!(k, Kind::Rejected(_))).await;
    assert_eq!(
        rejected_reason(&events),
        Some(task_rejected::Reason::Invalid)
    );
}

#[tokio::test]
async fn refuses_a_mode_above_the_local_cap() {
    let env = setup(Mode::Supervised);
    env.mgr
        .assign(
            assign("t2", PermissionMode::FullAccess, "sling/t2", "site"),
            true,
        )
        .await;
    let events = wait_for(&env.mgr, "t2", |k| matches!(k, Kind::Rejected(_))).await;
    assert_eq!(
        rejected_reason(&events),
        Some(task_rejected::Reason::ModeAboveCap)
    );
}

#[tokio::test]
async fn refuses_a_repo_that_is_not_in_the_local_config() {
    let env = setup(Mode::FullAccess);
    env.mgr
        .assign(
            assign("t3", PermissionMode::Auto, "sling/t3", "secrets"),
            true,
        )
        .await;
    let events = wait_for(&env.mgr, "t3", |k| matches!(k, Kind::Rejected(_))).await;
    assert_eq!(
        rejected_reason(&events),
        Some(task_rejected::Reason::UnknownRepo)
    );
}

#[tokio::test]
async fn commits_and_pushes_the_task_branch() {
    let env = setup(Mode::FullAccess);
    env.mgr
        .assign(
            assign("t4", PermissionMode::Auto, "sling/t4-change", "site"),
            true,
        )
        .await;
    let events = wait_for(&env.mgr, "t4", |k| matches!(k, Kind::Finished(_))).await;
    let finished = events
        .iter()
        .find_map(|e| match &e.kind {
            Some(Kind::Finished(f)) => Some(f.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        finished.outcome(),
        task_finished::Outcome::Succeeded,
        "{finished:?}"
    );
    assert!(!finished.commit_sha.is_empty());
    // CHANGED.md was reported by the harness; build.log wasn't, so it stays out.
    assert_eq!(finished.diff_stats.unwrap().files_changed, 1);
    let left_out_logged = events
        .iter()
        .any(|e| matches!(&e.kind, Some(Kind::Log(l)) if l.text.contains("build.log")));
    assert!(left_out_logged, "the left-out file is mentioned in the log");

    env.mgr
        .action(ActionRequest {
            action_id: "a1".into(),
            task_id: "t4".into(),
            kind: action_request::Kind::Push as i32,
            ..Default::default()
        })
        .await;
    let events = wait_for(&env.mgr, "t4", |k| matches!(k, Kind::ActionResult(_))).await;
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
        "{result:?}"
    );
    let branches = std::process::Command::new("git")
        .args(["branch", "--list", "sling/t4-change"])
        .current_dir(&env.remote)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&branches.stdout).contains("sling/t4-change"));
    // The default branch on the remote is untouched.
    let main = std::process::Command::new("git")
        .args(["log", "--oneline", "main"])
        .current_dir(&env.remote)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&main.stdout).lines().count(), 1);
}

#[tokio::test]
async fn read_only_tasks_change_nothing_and_cannot_push() {
    let env = setup(Mode::FullAccess);
    env.mgr
        .assign(
            assign("t5", PermissionMode::ReadOnly, "sling/t5", "site"),
            true,
        )
        .await;
    let events = wait_for(&env.mgr, "t5", |k| matches!(k, Kind::Finished(_))).await;
    let finished = events
        .iter()
        .find_map(|e| match &e.kind {
            Some(Kind::Finished(f)) => Some(f.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(finished.outcome(), task_finished::Outcome::Succeeded);
    assert!(finished.commit_sha.is_empty());

    env.mgr
        .action(ActionRequest {
            action_id: "a2".into(),
            task_id: "t5".into(),
            kind: action_request::Kind::Push as i32,
            ..Default::default()
        })
        .await;
    let events = wait_for(&env.mgr, "t5", |k| matches!(k, Kind::ActionResult(_))).await;
    let outcome = events.iter().find_map(|e| match &e.kind {
        Some(Kind::ActionResult(r)) => Some(r.outcome()),
        _ => None,
    });
    assert_eq!(outcome, Some(action_result::Outcome::Refused));
}

#[tokio::test]
async fn a_cancel_that_arrives_first_still_wins() {
    let env = setup(Mode::FullAccess);
    env.mgr.cancel("t6");
    env.mgr
        .assign(assign("t6", PermissionMode::Auto, "sling/t6", "site"), true)
        .await;
    let events = wait_for(&env.mgr, "t6", |k| matches!(k, Kind::Finished(_))).await;
    let outcome = events.iter().find_map(|e| match &e.kind {
        Some(Kind::Finished(f)) => Some(f.outcome()),
        _ => None,
    });
    assert_eq!(outcome, Some(task_finished::Outcome::Cancelled));
}
