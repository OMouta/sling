//! Merges and deploys against real git repos with a bare remote, and a
//! stand-in `gh` that records its arguments and prints canned JSON. These
//! cover the Runner's own guards, which hold whatever the control plane asks.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sling_runner_protocol::envelope::Body;
use sling_runner_protocol::{RepoAction, RepoActionResult, repo_action, repo_action_result};

use super::*;
use crate::config::{Config, Mode, Paths, RepoEntry};
use crate::tasks::Manager;

const TASK: &str = "tsk_01jcabcdefk3v9qa";
const BRANCH: &str = "sling/tsk_01jcabcdefk3v9qa-change";
const GITHUB: &str = "https://github.com/acme/site.git";
const PR: &str = "https://github.com/acme/site/pull/7";
const MERGE_OID: &str = "0123456789abcdef0123456789abcdef01234567";

/// Records where it ran and its arguments, and answers from files in its
/// directory.
const FAKE_GH: &str = r#"#!/bin/sh
dir=DIR
echo "$(pwd)|$*" >> "$dir/gh.log"
case "$1 $2" in
  "auth status") [ -f "$dir/gh-logged-out" ] && exit 1; exit 0 ;;
  "pr view") cat "$dir/pr.json" ;;
  "pr checks")
    if [ -f "$dir/checks.json" ]; then cat "$dir/checks.json"; exit "$(cat "$dir/checks-exit" 2>/dev/null || echo 0)"; fi
    echo "no checks reported on the 'x' branch" >&2; exit 1 ;;
  "pr merge")
    if [ -f "$dir/merge-fails" ]; then echo "Pull request is not mergeable" >&2; exit 1; fi
    if [ -f "$dir/pr-after.json" ]; then cp "$dir/pr-after.json" "$dir/pr.json"; fi
    echo "Merged" ;;
  "--version ") echo "gh version 2.80.0 (2026-01-01)" ;;
esac
"#;

struct Env {
    dir: tempfile::TempDir,
    mgr: Arc<Manager>,
    repo: PathBuf,
    remote: PathBuf,
    paths: Paths,
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=t"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn script(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A repo with a bare remote, and a pushed task branch that changes
/// CHANGED.md. With `github`, origin reads as a GitHub URL but git still
/// reaches the bare remote, so both the `gh` and git paths can run.
fn setup_with(github: bool, edit: impl FnOnce(&mut Config)) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let remote = root.join("remote.git");
    let repo = root.join("site");
    std::fs::create_dir_all(&repo).unwrap();
    git(
        &root,
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
    if github {
        git(&repo, &["remote", "add", "origin", GITHUB]);
        git(
            &repo,
            &[
                "config",
                &format!("url.{}.insteadOf", remote.display()),
                GITHUB,
            ],
        );
    } else {
        git(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
    }
    git(&repo, &["push", "-q", "-u", "origin", "main"]);

    // The task's commit, made the way the Runner makes it, on its branch.
    git(&repo, &["checkout", "-q", "-b", BRANCH]);
    std::fs::write(repo.join("CHANGED.md"), "changed\n").unwrap();
    git(&repo, &["add", "CHANGED.md"]);
    git(
        &repo,
        &[
            "commit",
            "-qm",
            &format!("Change something\n\nSling-Task: {TASK}"),
        ],
    );
    git(&repo, &["push", "-q", "origin", BRANCH]);
    git(&repo, &["checkout", "-q", "main"]);

    let gh = root.join("fake-gh.sh");
    script(&gh, &FAKE_GH.replace("DIR", root.to_str().unwrap()));
    let paths = Paths {
        config_dir: root.join("home"),
        data_dir: root.join("home/data"),
    };
    let mut cfg = Config {
        server_url: Some("http://localhost".into()),
        runner_id: Some("rnr_test".into()),
        codex_bin: Some(root.join("no-codex").display().to_string()),
        claude_bin: Some(root.join("no-claude").display().to_string()),
        gh_bin: Some(gh.display().to_string()),
        repos: vec![RepoEntry {
            name: "site".into(),
            path: repo.clone(),
            ..RepoEntry::default()
        }],
        ..Config::default()
    };
    edit(&mut cfg);
    cfg.save(&paths).unwrap();
    let mgr = Manager::new(paths.clone(), cfg).unwrap();
    Env {
        dir,
        mgr,
        repo,
        remote,
        paths,
    }
}

fn setup() -> Env {
    setup_with(false, |_| {})
}

impl Env {
    fn root(&self) -> PathBuf {
        std::fs::canonicalize(self.dir.path()).unwrap()
    }

    fn remote_head(&self) -> String {
        git(&self.remote, &["rev-parse", "refs/heads/main"])
    }

    fn edit_config(&self, edit: impl FnOnce(&mut Config)) {
        let mut cfg = Config::load(&self.paths).unwrap();
        edit(&mut cfg);
        cfg.save(&self.paths).unwrap();
    }

    fn gh_log(&self) -> String {
        std::fs::read_to_string(self.root().join("gh.log")).unwrap_or_default()
    }

    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.root().join(name), text).unwrap();
    }

    /// Pushes a commit to the remote's main from a second clone, as someone
    /// else would.
    fn push_to_main(&self, file: &str, text: &str) -> String {
        let other = self
            .root()
            .join(format!("other-{}", file.replace('.', "-")));
        git(
            &self.root(),
            &[
                "clone",
                "-q",
                self.remote.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        );
        std::fs::write(other.join(file), text).unwrap();
        git(&other, &["add", file]);
        git(&other, &["commit", "-qm", &format!("Edit {file}")]);
        git(&other, &["push", "-q", "origin", "main"]);
        git(&other, &["rev-parse", "HEAD"])
    }

    /// What `git worktree list` shows for the user's repo.
    fn worktrees(&self) -> usize {
        git(&self.repo, &["worktree", "list", "--porcelain"])
            .lines()
            .filter(|l| l.starts_with("worktree "))
            .count()
    }

    fn actions_left(&self) -> usize {
        std::fs::read_dir(self.paths.actions_dir())
            .map(|d| d.count())
            .unwrap_or(0)
    }

    /// The user's checkout: branch, commit, and status.
    fn checkout(&self) -> (String, String, String) {
        (
            git(&self.repo, &["branch", "--show-current"]),
            git(&self.repo, &["rev-parse", "HEAD"]),
            git(&self.repo, &["status", "--porcelain"]),
        )
    }
}

fn merge(id: &str) -> RepoAction {
    RepoAction {
        request_id: id.into(),
        kind: repo_action::Kind::Merge as i32,
        task_id: TASK.into(),
        repo: "site".into(),
        branch: BRANCH.into(),
        default_branch: "main".into(),
        merge_method: "squash".into(),
        title: "Change something".into(),
        body: "Edits CHANGED.md.".into(),
        ..Default::default()
    }
}

fn deploy(id: &str, commit: &str) -> RepoAction {
    RepoAction {
        request_id: id.into(),
        kind: repo_action::Kind::Deploy as i32,
        task_id: TASK.into(),
        repo: "site".into(),
        commit_sha: commit.into(),
        ..Default::default()
    }
}

/// Runs `req` and waits for its result, collecting its output on the way.
async fn run_action(mgr: &Arc<Manager>, req: RepoAction) -> (RepoActionResult, String) {
    let id = req.request_id.clone();
    mgr.repo_action(req);
    wait_result(mgr, &id).await
}

async fn wait_result(mgr: &Arc<Manager>, id: &str) -> (RepoActionResult, String) {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut output = String::new();
    while Instant::now() < deadline {
        for body in mgr.repo_actions.unsent() {
            match body {
                Body::RepoActionOutput(o) if o.request_id == id => output.push_str(&o.chunk),
                Body::RepoActionResult(r) if r.request_id == id => return (r, output),
                _ => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("no result for {id}; output so far: {output}");
}

fn outcome(r: &RepoActionResult) -> repo_action_result::Outcome {
    r.outcome()
}

fn parents(dir: &Path, rev: &str) -> usize {
    git(dir, &["rev-list", "--parents", "-n", "1", rev])
        .split_whitespace()
        .count()
        - 1
}

// ---------------------------------------------------------------- merge with git

#[tokio::test]
async fn squash_merges_a_task_branch_into_the_default_branch() {
    let env = setup();
    let before = env.checkout();
    let (r, _) = run_action(&env.mgr, merge("m1")).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}",
        r.message
    );
    assert_eq!(r.kind(), repo_action::Kind::Merge);
    let head = env.remote_head();
    assert_eq!(r.commit_sha, head);
    assert!(r.message.starts_with("Squash-merged"), "{}", r.message);
    assert_eq!(parents(&env.remote, &head), 1, "a squash has one parent");
    assert_eq!(
        git(&env.remote, &["log", "-1", "--format=%B", &head]),
        format!("Change something\n\nEdits CHANGED.md.\n\nSling-Task: {TASK}")
    );
    assert_eq!(
        git(&env.remote, &["show", &format!("{head}:CHANGED.md")]),
        "changed"
    );
    assert_eq!(env.checkout(), before, "the user's checkout is untouched");
    assert_eq!(env.worktrees(), 1, "the temporary worktree is gone");
    assert_eq!(env.actions_left(), 0);
}

#[tokio::test]
async fn merges_with_a_merge_commit() {
    let env = setup();
    let mut req = merge("m1");
    req.merge_method = "merge".into();
    let (r, _) = run_action(&env.mgr, req).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}",
        r.message
    );
    let head = env.remote_head();
    assert_eq!(r.commit_sha, head);
    assert!(r.message.starts_with("Merged"), "{}", r.message);
    assert_eq!(parents(&env.remote, &head), 2);
    assert!(
        git(&env.remote, &["log", "-1", "--format=%B", &head])
            .ends_with(&format!("Sling-Task: {TASK}"))
    );
}

#[tokio::test]
async fn rebase_falls_back_to_squash_without_gh() {
    let env = setup();
    let mut req = merge("m1");
    req.merge_method = "rebase".into();
    let (r, _) = run_action(&env.mgr, req).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}",
        r.message
    );
    assert!(r.message.contains("squash-merged"), "{}", r.message);
    assert!(r.message.contains("Rebasing needs gh"), "{}", r.message);
    assert_eq!(parents(&env.remote, &env.remote_head()), 1);
}

#[tokio::test]
async fn merging_twice_finds_the_earlier_merge_by_its_trailer() {
    let env = setup();
    let (first, _) = run_action(&env.mgr, merge("m1")).await;
    assert_eq!(outcome(&first), repo_action_result::Outcome::Succeeded);
    // Someone else lands a commit after it.
    let later = env.push_to_main("OTHER.md", "other\n");
    for method in ["squash", "merge"] {
        let mut again = merge(&format!("m2-{method}"));
        again.merge_method = method.into();
        let (r, _) = run_action(&env.mgr, again).await;
        assert_eq!(
            outcome(&r),
            repo_action_result::Outcome::Succeeded,
            "{}",
            r.message
        );
        assert_eq!(r.commit_sha, first.commit_sha, "the earlier merge commit");
        assert!(r.message.contains("already merged"), "{}", r.message);
    }
    assert_eq!(env.remote_head(), later, "nothing new was pushed");
}

#[tokio::test]
async fn a_branch_merged_without_its_trailer_still_counts_as_merged() {
    let env = setup();
    // A fast-forward done outside Sling: the task's own commit is on main.
    git(
        &env.repo,
        &["push", "-q", "origin", &format!("{BRANCH}:refs/heads/main")],
    );
    let head = env.remote_head();
    let (r, _) = run_action(&env.mgr, merge("m1")).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}",
        r.message
    );
    assert!(r.message.contains("already"), "{}", r.message);
    assert_eq!(r.commit_sha, head);
    assert_eq!(env.remote_head(), head);
}

#[tokio::test]
async fn a_branch_with_no_changes_does_not_merge() {
    let env = setup();
    let empty = "sling/tsk_01jcabcdefk3v9qa-empty";
    git(
        &env.repo,
        &["push", "-q", "origin", &format!("main:refs/heads/{empty}")],
    );
    let before = env.remote_head();
    let mut req = merge("m1");
    req.branch = empty.into();
    let (r, _) = run_action(&env.mgr, req).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Failed,
        "{}",
        r.message
    );
    assert!(r.message.contains("no changes"), "{}", r.message);
    assert_eq!(env.remote_head(), before);
}

#[tokio::test]
async fn a_conflict_aborts_the_merge_and_names_the_files() {
    let env = setup();
    // The task branch and main both change CHANGED.md and README.md.
    git(&env.repo, &["checkout", "-q", BRANCH]);
    std::fs::write(env.repo.join("README.md"), "# site, from the task\n").unwrap();
    git(&env.repo, &["commit", "-qam", "Task edit"]);
    git(&env.repo, &["push", "-q", "origin", BRANCH]);
    git(&env.repo, &["checkout", "-q", "main"]);
    env.push_to_main("CHANGED.md", "someone else\n");
    let before = env.push_to_main("README.md", "# site, from main\n");

    for method in ["squash", "merge"] {
        let mut req = merge(&format!("m-{method}"));
        req.merge_method = method.into();
        let (r, _) = run_action(&env.mgr, req).await;
        assert_eq!(
            outcome(&r),
            repo_action_result::Outcome::Failed,
            "{}",
            r.message
        );
        assert!(r.message.contains("conflicts"), "{}", r.message);
        assert!(r.message.contains("README.md"), "{}", r.message);
        assert!(r.message.contains("CHANGED.md"), "{}", r.message);
        assert_eq!(env.remote_head(), before, "nothing was pushed");
        assert_eq!(env.worktrees(), 1, "the temporary worktree is gone");
    }
}

#[tokio::test]
async fn a_default_branch_that_moves_during_the_push_is_merged_again_on_top() {
    let env = setup();
    // Someone else's commit, ready to land on main the moment Sling pushes.
    let other = env.root().join("other");
    git(
        &env.root(),
        &[
            "clone",
            "-q",
            env.remote.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    std::fs::write(other.join("OTHER.md"), "other\n").unwrap();
    git(&other, &["add", "OTHER.md"]);
    git(&other, &["commit", "-qm", "Someone else's change"]);
    git(
        &other,
        &["push", "-q", "origin", "HEAD:refs/heads/elsewhere"],
    );
    let theirs = git(&other, &["rev-parse", "HEAD"]);
    script(
        &env.remote.join("hooks/pre-receive"),
        r#"#!/bin/sh
if [ ! -f moved ]; then
  touch moved
  env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
    git update-ref refs/heads/main refs/heads/elsewhere
fi
"#,
    );

    let (r, _) = run_action(&env.mgr, merge("m1")).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}",
        r.message
    );
    assert!(r.message.contains("moved"), "{}", r.message);
    let head = env.remote_head();
    assert_eq!(r.commit_sha, head);
    assert_eq!(
        git(&env.remote, &["rev-parse", &format!("{head}^")]),
        theirs
    );
    assert_eq!(
        git(&env.remote, &["show", &format!("{head}:OTHER.md")]),
        "other"
    );
    assert_eq!(
        git(&env.remote, &["show", &format!("{head}:CHANGED.md")]),
        "changed"
    );
}

// ---------------------------------------------------------------- CI

fn ci(id: &str) -> RepoAction {
    RepoAction {
        request_id: id.into(),
        kind: repo_action::Kind::Ci as i32,
        repo: "site".into(),
        pr_url: PR.into(),
        ..Default::default()
    }
}

#[tokio::test]
async fn reads_a_prs_ci_with_gh_even_with_deploys_off() {
    let env = setup_with(true, |c| c.deploys = false);
    env.write(
        "checks.json",
        r#"[{"name":"lint","bucket":"pass"},{"name":"test","bucket":"pending"}]"#,
    );
    // gh exits 8 while checks are still running, and prints them all the same.
    env.write("checks-exit", "8");
    let (r, _) = run_action(&env.mgr, ci("c1")).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}",
        r.message
    );
    let got: Vec<(String, String)> = r
        .ci_checks
        .iter()
        .map(|c| (c.name.clone(), c.bucket.clone()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("lint".to_string(), "pass".to_string()),
            ("test".to_string(), "pending".to_string())
        ]
    );
    let log = env.gh_log();
    assert!(
        log.contains(&format!("|pr checks {PR} --json name,bucket")),
        "{log}"
    );
}

#[tokio::test]
async fn a_pr_with_no_checks_yet_has_an_empty_list() {
    let env = setup_with(true, |_| {});
    let (r, _) = run_action(&env.mgr, ci("c2")).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}",
        r.message
    );
    assert!(r.ci_checks.is_empty());
}

#[tokio::test]
async fn reads_ci_only_for_a_pr_of_the_repos_remote_and_with_gh_logged_in() {
    let env = setup_with(true, |_| {});
    let other = RepoAction {
        pr_url: "https://github.com/someone/else/pull/3".into(),
        ..ci("c3")
    };
    let (r, _) = run_action(&env.mgr, other).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Refused,
        "{}",
        r.message
    );
    assert!(env.gh_log().is_empty(), "gh never ran: {}", env.gh_log());

    env.write("gh-logged-out", "");
    let (r, _) = run_action(&env.mgr, ci("c4")).await;
    assert_eq!(outcome(&r), repo_action_result::Outcome::Failed);
    assert!(r.message.starts_with("gh isn't logged in"), "{}", r.message);
}

// ---------------------------------------------------------------- merge with gh

fn pr_json(head: &str, base: &str, state: &str, oid: Option<&str>) -> String {
    let commit = match oid {
        Some(o) => format!("{{\"oid\":\"{o}\"}}"),
        None => "null".into(),
    };
    format!(
        r#"{{"headRefName":"{head}","baseRefName":"{base}","state":"{state}","mergeCommit":{commit}}}"#
    )
}

fn pr_merge(id: &str) -> RepoAction {
    RepoAction {
        pr_url: PR.into(),
        ..merge(id)
    }
}

#[tokio::test]
async fn merges_a_pr_with_gh_from_outside_the_repo() {
    let env = setup_with(true, |_| {});
    env.write("pr.json", &pr_json(BRANCH, "main", "OPEN", None));
    env.write(
        "pr-after.json",
        &pr_json(BRANCH, "main", "MERGED", Some(MERGE_OID)),
    );
    let before = env.remote_head();
    let local = git(&env.repo, &["rev-parse", BRANCH]);

    let (r, _) = run_action(&env.mgr, pr_merge("m1")).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}",
        r.message
    );
    assert_eq!(r.commit_sha, MERGE_OID);
    assert_eq!(r.url, PR);
    assert!(r.message.contains("Squash-merged the PR"), "{}", r.message);

    let log = env.gh_log();
    let merge_line = log
        .lines()
        .find(|l| l.contains("|pr merge "))
        .unwrap_or_else(|| panic!("no merge call in {log}"));
    let (cwd, args) = merge_line.split_once('|').unwrap();
    assert_eq!(
        args,
        format!("pr merge {PR} --squash --match-head-commit {local}")
    );
    assert!(
        Path::new(cwd).starts_with(env.paths.actions_dir()),
        "gh runs outside the repo, in {cwd}"
    );
    assert!(log.contains(&format!(
        "pr view {PR} --json headRefName,baseRefName,state,mergeCommit"
    )));
    assert_eq!(env.remote_head(), before, "git itself pushed nothing");
    assert_eq!(env.actions_left(), 0);
}

#[tokio::test]
async fn gh_merges_with_the_targets_method() {
    let env = setup_with(true, |_| {});
    for (method, flag) in [("merge", "--merge"), ("rebase", "--rebase")] {
        env.write("pr.json", &pr_json(BRANCH, "main", "OPEN", None));
        env.write(
            "pr-after.json",
            &pr_json(BRANCH, "main", "MERGED", Some(MERGE_OID)),
        );
        let mut req = pr_merge(&format!("m-{method}"));
        req.merge_method = method.into();
        let (r, _) = run_action(&env.mgr, req).await;
        assert_eq!(
            outcome(&r),
            repo_action_result::Outcome::Succeeded,
            "{}",
            r.message
        );
        assert!(
            env.gh_log().contains(&format!("pr merge {PR} {flag} ")),
            "{}",
            env.gh_log()
        );
    }
}

#[tokio::test]
async fn an_already_merged_pr_answers_with_its_merge_commit() {
    let env = setup_with(true, |_| {});
    env.write(
        "pr.json",
        &pr_json(BRANCH, "main", "MERGED", Some(MERGE_OID)),
    );
    let (r, _) = run_action(&env.mgr, pr_merge("m1")).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}",
        r.message
    );
    assert_eq!(r.commit_sha, MERGE_OID);
    assert!(r.message.contains("already merged"), "{}", r.message);
    assert!(!env.gh_log().contains("pr merge"), "{}", env.gh_log());
}

#[tokio::test]
async fn refuses_a_pr_whose_head_or_base_does_not_match() {
    let env = setup_with(true, |_| {});
    for (i, (head, base)) in [("sling/tsk_other-x", "main"), (BRANCH, "release")]
        .into_iter()
        .enumerate()
    {
        env.write("pr.json", &pr_json(head, base, "OPEN", None));
        let (r, _) = run_action(&env.mgr, pr_merge(&format!("m{i}"))).await;
        assert_eq!(
            outcome(&r),
            repo_action_result::Outcome::Refused,
            "{}",
            r.message
        );
        assert!(
            r.message.contains(head) && r.message.contains(base),
            "{}",
            r.message
        );
    }
    assert!(!env.gh_log().contains("pr merge"), "{}", env.gh_log());
}

#[tokio::test]
async fn refuses_a_pr_of_another_repo() {
    let env = setup_with(true, |_| {});
    let mut req = pr_merge("m1");
    req.pr_url = "https://github.com/someone/else/pull/7".into();
    let (r, _) = run_action(&env.mgr, req).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Refused,
        "{}",
        r.message
    );
    assert!(env.gh_log().is_empty(), "gh never ran: {}", env.gh_log());
}

#[tokio::test]
async fn a_pr_github_does_not_merge_fails() {
    let env = setup_with(true, |_| {});
    env.write("pr.json", &pr_json(BRANCH, "main", "CLOSED", None));
    let (r, _) = run_action(&env.mgr, pr_merge("m1")).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Failed,
        "{}",
        r.message
    );
    assert!(r.message.contains("closed"), "{}", r.message);

    env.write("pr.json", &pr_json(BRANCH, "main", "OPEN", None));
    env.write("merge-fails", "");
    let (r, _) = run_action(&env.mgr, pr_merge("m2")).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Failed,
        "{}",
        r.message
    );
    assert!(r.message.contains("not mergeable"), "{}", r.message);

    // Queued instead of merged: still open afterwards.
    std::fs::remove_file(env.root().join("merge-fails")).unwrap();
    let (r, _) = run_action(&env.mgr, pr_merge("m3")).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Failed,
        "{}",
        r.message
    );
    assert!(r.message.contains("didn't merge"), "{}", r.message);
}

#[tokio::test]
async fn merges_with_git_when_gh_is_not_logged_in() {
    let env = setup_with(true, |_| {});
    env.write("gh-logged-out", "");
    let (r, _) = run_action(&env.mgr, pr_merge("m1")).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}",
        r.message
    );
    assert!(r.message.starts_with("gh isn't logged in"), "{}", r.message);
    let head = env.remote_head();
    assert_eq!(r.commit_sha, head);
    assert_eq!(r.url, PR);
    assert!(!env.gh_log().contains("pr merge"));
}

// ---------------------------------------------------------------- deploy

fn with_command(command: &str, timeout: Option<u32>) -> impl FnOnce(&mut Config) {
    let command = command.to_string();
    move |cfg: &mut Config| {
        cfg.repos[0].deploy_command = Some(command);
        cfg.repos[0].deploy_timeout_secs = timeout;
    }
}

#[tokio::test]
async fn deploys_a_merged_commit_in_a_checkout_of_it() {
    let env = setup_with(
        false,
        with_command(
            r#"echo "commit=$SLING_DEPLOY_COMMIT repo=$SLING_DEPLOY_REPO"
echo "sling vars: $(env | grep '^SLING_' | cut -d= -f1 | sort | tr '\n' ' ')"
echo "dir=$(pwd)"
cat CHANGED.md
echo "to stderr" >&2"#,
            None,
        ),
    );
    let (merged, _) = run_action(&env.mgr, merge("m1")).await;
    assert_eq!(outcome(&merged), repo_action_result::Outcome::Succeeded);
    let short = merged.commit_sha[..12].to_string();
    let (r, output) = run_action(&env.mgr, deploy("d1", &short)).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}\n{output}",
        r.message
    );
    assert_eq!(r.kind(), repo_action::Kind::Deploy);
    assert_eq!(r.exit_code, Some(0));
    assert_eq!(r.commit_sha, merged.commit_sha, "the full SHA");
    assert!(
        output.contains(&format!("commit={} repo=site", merged.commit_sha)),
        "{output}"
    );
    assert!(
        output.contains("sling vars: SLING_DEPLOY_COMMIT SLING_DEPLOY_REPO \n"),
        "only the deploy's own SLING_ variables: {output}"
    );
    assert!(
        output.contains("changed\n"),
        "runs in the merged commit: {output}"
    );
    assert!(output.contains("to stderr"), "{output}");
    let dir = output.lines().find_map(|l| l.strip_prefix("dir=")).unwrap();
    assert!(
        Path::new(dir).starts_with(env.paths.actions_dir()),
        "not the user's checkout: {dir}"
    );
    assert!(
        !Path::new(dir).exists(),
        "the checkout is removed afterwards"
    );
    assert_eq!(env.worktrees(), 1);
}

#[tokio::test]
async fn a_failing_deploy_reports_its_exit_code_and_last_output() {
    let env = setup_with(
        false,
        with_command("echo starting; echo 'Error: app not found'; exit 3", None),
    );
    let head = env.remote_head();
    let (r, output) = run_action(&env.mgr, deploy("d1", &head)).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Failed,
        "{}",
        r.message
    );
    assert_eq!(r.exit_code, Some(3));
    assert!(r.message.contains("exited with code 3"), "{}", r.message);
    assert!(r.message.contains("Error: app not found"), "{}", r.message);
    assert!(output.contains("starting"), "{output}");
    assert_eq!(env.worktrees(), 1);
}

#[tokio::test]
async fn a_deploy_past_its_limit_is_stopped_with_everything_it_started() {
    let env = setup();
    let pid_file = env.root().join("child.pid");
    // The limit counts the login shell's startup, which takes over a second
    // on some CI runners, so it leaves room for the command to print.
    env.edit_config(with_command(
        &format!(
            "sleep 30 & echo $! > {}; echo waiting; wait",
            pid_file.display()
        ),
        Some(3),
    ));
    let head = env.remote_head();
    let started = Instant::now();
    let (r, output) = run_action(&env.mgr, deploy("d1", &head)).await;
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Failed,
        "{}",
        r.message
    );
    assert!(r.message.contains("3s limit"), "{}", r.message);
    assert_eq!(r.exit_code, None);
    assert!(output.contains("waiting"), "{output}");
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // SAFETY: signal 0 only checks whether the process exists.
    let alive = unsafe { libc::kill(pid, 0) } == 0;
    assert!(!alive, "the background sleep was killed with its group");
    assert_eq!(env.worktrees(), 1);
}

#[tokio::test]
async fn deploy_output_is_redacted_and_capped() {
    let env = setup_with(
        false,
        with_command(
            "echo token ghp_abcdefghijklmnopqrstuvwxyz0123; head -c 400000 /dev/zero | tr '\\0' 'x'; echo; echo done",
            None,
        ),
    );
    let head = env.remote_head();
    let (r, output) = run_action(&env.mgr, deploy("d1", &head)).await;
    assert_eq!(
        outcome(&r),
        repo_action_result::Outcome::Succeeded,
        "{}",
        r.message
    );
    assert!(!output.contains("ghp_abcdef"), "redacted");
    assert!(output.contains("[redacted]"));
    assert!(output.contains("output cut here"), "a note says it was cut");
    assert!(output.len() < MAX_OUTPUT_BYTES + 200, "{}", output.len());
    assert!(!output.contains("done"), "nothing after the cap");
}

#[tokio::test]
async fn deploy_output_streams_in_batches() {
    // Two bursts of builtin echoes, a few flushes apart. A sleep between every
    // line would start a process per line, and on a slow machine each one can
    // take longer than a flush, so every line would go out alone.
    let env = setup_with(
        false,
        with_command(
            "for i in 1 2 3 4 5; do echo line $i; done; sleep 0.3; \
             for i in 6 7 8 9 10; do echo line $i; done",
            None,
        ),
    );
    let head = env.remote_head();
    env.mgr.repo_action(deploy("d1", &head));
    let mut chunks = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(Instant::now() < deadline, "no result");
        let mut done = false;
        for body in env.mgr.repo_actions.unsent() {
            match body {
                Body::RepoActionOutput(o) => chunks.push(o.chunk),
                Body::RepoActionResult(_) => done = true,
                _ => {}
            }
        }
        if done {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let all: String = chunks.concat();
    for i in 1..=10 {
        assert!(all.contains(&format!("line {i}\n")), "{all}");
    }
    assert!(chunks.len() > 1, "it streamed: {chunks:?}");
    assert!(chunks.len() < 10, "batched, not one per line: {chunks:?}");
    assert!(
        chunks.iter().all(|c| c.ends_with('\n')),
        "whole lines: {chunks:?}"
    );
}

#[tokio::test]
async fn refuses_to_deploy_a_commit_that_is_not_on_the_default_branch() {
    let env = setup_with(false, with_command("touch deployed", None));
    let task_commit = git(&env.repo, &["rev-parse", BRANCH]);
    for (i, commit) in [
        task_commit.as_str(),
        "0123456789abcdef0123456789abcdef01234567",
    ]
    .into_iter()
    .enumerate()
    {
        let (r, output) = run_action(&env.mgr, deploy(&format!("d{i}"), commit)).await;
        assert_eq!(
            outcome(&r),
            repo_action_result::Outcome::Refused,
            "{}",
            r.message
        );
        assert!(r.message.contains("isn't on origin/main"), "{}", r.message);
        assert!(output.is_empty());
    }
    for (i, bad) in ["HEAD", "--all", "main", ""].into_iter().enumerate() {
        let (r, _) = run_action(&env.mgr, deploy(&format!("bad{i}"), bad)).await;
        assert_eq!(
            outcome(&r),
            repo_action_result::Outcome::Refused,
            "{bad}: {}",
            r.message
        );
    }
    assert_eq!(env.worktrees(), 1);
    assert_eq!(env.actions_left(), 0);
}

// ---------------------------------------------------------------- guards

#[tokio::test]
async fn refuses_everything_with_deploys_off_at_once() {
    let env = setup_with(false, with_command("touch deployed", None));
    // Turned off on disk after the Runner started: it applies at once.
    env.edit_config(|c| c.deploys = false);
    let head = env.remote_head();
    for req in [merge("m1"), pr_merge("m2"), deploy("d1", &head)] {
        let (r, _) = run_action(&env.mgr, req).await;
        assert_eq!(outcome(&r), repo_action_result::Outcome::Refused);
        assert!(r.message.contains("config set deploys on"), "{}", r.message);
    }
    assert_eq!(env.remote_head(), head);
    assert!(env.gh_log().is_empty());
}

#[tokio::test]
async fn refuses_everything_at_read_only() {
    let env = setup_with(false, |c| {
        c.max_mode = Mode::ReadOnly;
        c.repos[0].deploy_command = Some("touch deployed".into());
    });
    let head = env.remote_head();
    for req in [merge("m1"), deploy("d1", &head)] {
        let (r, _) = run_action(&env.mgr, req).await;
        assert_eq!(outcome(&r), repo_action_result::Outcome::Refused);
        assert!(r.message.contains("read-only"), "{}", r.message);
    }
    assert_eq!(env.remote_head(), head);
}

#[tokio::test]
async fn refuses_an_unknown_repo_or_kind() {
    let env = setup();
    let mut req = merge("m1");
    req.repo = "secrets".into();
    let (r, _) = run_action(&env.mgr, req).await;
    assert_eq!(outcome(&r), repo_action_result::Outcome::Refused);
    assert!(
        r.message.contains("no repo named \"secrets\""),
        "{}",
        r.message
    );

    let mut req = merge("m2");
    req.kind = repo_action::Kind::Unspecified as i32;
    let (r, _) = run_action(&env.mgr, req).await;
    assert_eq!(outcome(&r), repo_action_result::Outcome::Refused);
}

#[tokio::test]
async fn refuses_to_merge_anything_but_a_task_branch_into_the_default_branch() {
    let env = setup();
    git(
        &env.repo,
        &["push", "-q", "origin", "main:refs/heads/feature/x"],
    );
    let before = env.remote_head();
    let base = merge("m");
    let cases = [
        (
            "the default branch",
            RepoAction {
                branch: "main".into(),
                ..base.clone()
            },
        ),
        (
            "a branch outside sling/",
            RepoAction {
                branch: "feature/x".into(),
                ..base.clone()
            },
        ),
        (
            "a branch with ..",
            RepoAction {
                branch: "sling/../main".into(),
                ..base.clone()
            },
        ),
        (
            "another target branch",
            RepoAction {
                default_branch: "release".into(),
                ..base.clone()
            },
        ),
        (
            "a task ID that adds lines",
            RepoAction {
                task_id: "tsk_1\nSling-Task: other".into(),
                ..base.clone()
            },
        ),
        (
            "an unknown method",
            RepoAction {
                merge_method: "octopus".into(),
                ..base.clone()
            },
        ),
    ];
    for (i, (what, req)) in cases.into_iter().enumerate() {
        let req = RepoAction {
            request_id: format!("m{i}"),
            ..req
        };
        let (r, _) = run_action(&env.mgr, req).await;
        assert_eq!(
            outcome(&r),
            repo_action_result::Outcome::Refused,
            "{what}: {}",
            r.message
        );
    }
    assert_eq!(env.remote_head(), before);
}

#[tokio::test]
async fn refuses_to_deploy_a_repo_without_a_deploy_command() {
    let env = setup();
    let head = env.remote_head();
    let (r, _) = run_action(&env.mgr, deploy("d1", &head)).await;
    assert_eq!(outcome(&r), repo_action_result::Outcome::Refused);
    assert!(
        r.message.contains("repo set site deploy-command"),
        "{}",
        r.message
    );
}

// ---------------------------------------------------------------- results

#[tokio::test]
async fn results_stay_until_acknowledged_and_go_out_again_after_a_reconnect() {
    let env = setup();
    let (r, _) = run_action(&env.mgr, merge("m1")).await;
    let results = |bodies: Vec<Body>| -> Vec<RepoActionResult> {
        bodies
            .into_iter()
            .filter_map(|b| match b {
                Body::RepoActionResult(r) => Some(r),
                _ => None,
            })
            .collect()
    };
    assert!(
        results(env.mgr.repo_actions.unsent()).is_empty(),
        "sent once per connection"
    );
    env.mgr.reset_sent();
    let again = results(env.mgr.repo_actions.unsent());
    assert_eq!(again, vec![r.clone()], "sent again after a reconnect");
    env.mgr.repo_action_ack("m1");
    env.mgr.reset_sent();
    assert!(
        results(env.mgr.repo_actions.unsent()).is_empty(),
        "gone once acknowledged"
    );
}

#[tokio::test]
async fn a_repeated_request_runs_once() {
    let env = setup();
    let counter = env.root().join("runs");
    env.edit_config(with_command(
        &format!("echo run >> {}; sleep 0.5", counter.display()),
        None,
    ));
    let head = env.remote_head();
    let runs = || {
        std::fs::read_to_string(&counter)
            .unwrap_or_default()
            .lines()
            .count()
    };

    // While it runs.
    env.mgr.repo_action(deploy("d1", &head));
    tokio::time::sleep(Duration::from_millis(200)).await;
    env.mgr.repo_action(deploy("d1", &head));
    let (first, _) = wait_result(&env.mgr, "d1").await;
    assert_eq!(
        outcome(&first),
        repo_action_result::Outcome::Succeeded,
        "{}",
        first.message
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        env.mgr.repo_actions.unsent().is_empty(),
        "one result for both"
    );

    // After it finished, and after it was acknowledged.
    let (again, _) = run_action(&env.mgr, deploy("d1", &head)).await;
    assert_eq!(again, first, "the stored result");
    env.mgr.repo_action_ack("d1");
    let (after_ack, _) = run_action(&env.mgr, deploy("d1", &head)).await;
    assert_eq!(after_ack, first);
    assert_eq!(runs(), 1, "the command ran once");
    assert!(!env.mgr.busy());
}

#[tokio::test]
async fn a_second_deploy_of_the_same_repo_waits_for_the_first() {
    let env = setup_with(false, with_command("sleep 1", None));
    let head = env.remote_head();
    env.mgr.repo_action(deploy("d1", &head));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(env.mgr.busy(), "a running deploy keeps the Runner busy");
    let (second, _) = run_action(&env.mgr, deploy("d2", &head)).await;
    assert_eq!(outcome(&second), repo_action_result::Outcome::Failed);
    assert!(
        second.message.contains("Another deploy"),
        "{}",
        second.message
    );
    let (first, _) = wait_result(&env.mgr, "d1").await;
    assert_eq!(
        outcome(&first),
        repo_action_result::Outcome::Succeeded,
        "{}",
        first.message
    );
}

#[tokio::test]
async fn a_restart_clears_checkouts_left_behind() {
    let env = setup();
    // A checkout a Runner left when it stopped mid-deploy.
    let left = env.paths.actions_dir().join("0011223344556677");
    git(
        &env.repo,
        &[
            "worktree",
            "add",
            "-q",
            "--detach",
            left.to_str().unwrap(),
            "main",
        ],
    );
    assert_eq!(env.worktrees(), 2);
    let cfg = Config::load(&env.paths).unwrap();
    let _mgr = Manager::new(env.paths.clone(), cfg).unwrap();
    assert!(!left.exists());
    assert_eq!(env.worktrees(), 1, "git forgot it too");
}

// ---------------------------------------------------------------- settings

#[tokio::test]
async fn the_inventory_reports_deploy_settings() {
    let env = setup_with(
        false,
        with_command(
            "fly deploy --token ghp_abcdefghijklmnopqrstuvwxyz0123",
            Some(600),
        ),
    );
    let sandbox = crate::exec::Sandbox::Missing("test".into());
    let cfg = Config::load(&env.paths).unwrap();
    let inv = crate::inventory::build(&cfg, &[], &sandbox).await;
    assert!(inv.deploys);
    assert_eq!(inv.repos[0].deploy_command, "fly deploy --token [redacted]");
    assert_eq!(inv.repos[0].deploy_timeout_seconds, 600);

    let read_only = Config {
        max_mode: Mode::ReadOnly,
        ..cfg.clone()
    };
    assert!(
        !crate::inventory::build(&read_only, &[], &sandbox)
            .await
            .deploys
    );
    let off = Config {
        deploys: false,
        ..cfg.clone()
    };
    assert!(!crate::inventory::build(&off, &[], &sandbox).await.deploys);
    let mut none = cfg;
    none.repos[0].deploy_command = None;
    let inv = crate::inventory::build(&none, &[], &sandbox).await;
    assert_eq!(inv.repos[0].deploy_command, "");
    assert_eq!(inv.repos[0].deploy_timeout_seconds, 0);
}

#[test]
fn repo_deploy_settings_are_set_and_unset() {
    let env = setup();
    let get = || Config::load(&env.paths).unwrap().repos[0].clone();
    crate::repos::set(&env.paths, "site", "deploy-command", " fly deploy ").unwrap();
    assert_eq!(get().deploy_command.as_deref(), Some("fly deploy"));
    assert_eq!(get().deploy_timeout_secs(), 900);
    crate::repos::set(&env.paths, "site", "deploy-timeout", "120").unwrap();
    assert_eq!(get().deploy_timeout_secs(), 120);
    assert!(crate::repos::set(&env.paths, "site", "deploy-timeout", "0").is_err());
    assert!(crate::repos::set(&env.paths, "site", "deploy-command", "").is_err());
    assert!(crate::repos::set(&env.paths, "site", "network", "on").is_err());
    assert!(crate::repos::set(&env.paths, "nope", "deploy-command", "x").is_err());
    crate::repos::unset(&env.paths, "site", "deploy-timeout").unwrap();
    assert_eq!(get().deploy_timeout_secs(), 900);
    crate::repos::unset(&env.paths, "site", "deploy-command").unwrap();
    assert_eq!(get().deploy_command, None);
}

#[test]
fn the_deploy_environment_drops_slings_own_variables() {
    let vars = [
        ("PATH", "/bin"),
        ("SLING_GIT_TOKEN", "x"),
        ("SLING_RUNNER_HOME", "/tmp"),
        ("GH_TOKEN", "mine"),
        ("SLING_DEPLOY_COMMIT", "stale"),
    ]
    .map(|(k, v)| (k.to_string(), v.to_string()));
    let env = deploy_env_from(vars, "abc1234", "site");
    let names: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(
        names,
        [
            "PATH",
            "GH_TOKEN",
            "SLING_DEPLOY_COMMIT",
            "SLING_DEPLOY_REPO"
        ]
    );
    assert_eq!(env[2].1, "abc1234");
    assert_eq!(env[3].1, "site");
}
