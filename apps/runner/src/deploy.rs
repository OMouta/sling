//! Merges and deploys that Sling asks for with RepoAction. They aren't tied
//! to a task's spool, so any machine with the repo can take one. The
//! Runner's own rules hold whatever the control plane says: `deploys` must
//! be on, max-mode can't be Read-only, only Sling task branches merge, and
//! only commits on the remote's default branch deploy, with the command set
//! on this machine. Nothing here force-pushes.
//!
//! Each merge and deploy runs in a temporary detached worktree that's
//! removed afterwards, so the user's own checkout is never touched. Results
//! stay in memory until the server acknowledges them, and go out again after
//! a reconnect.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sling_runner_protocol::envelope::Body;
use sling_runner_protocol::{
    CiCheck, RepoAction, RepoActionOutput, RepoActionResult, repo_action, repo_action_result,
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::config::{Config, Paths, RepoEntry};
use crate::git;
use crate::redact::redact;
use crate::spool::valid_task_id;
use crate::sys::{Output, run, run_timeout};
use crate::tasks::Manager;

#[cfg(all(test, unix))]
#[path = "deploy_tests.rs"]
mod tests;

/// Deploy output sent to Sling, in total. The rest is dropped.
pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;
/// Deploy output goes out at most this often.
const OUTPUT_EVERY: Duration = Duration::from_millis(100);
/// A partial line this long goes out without waiting for its newline.
const MAX_PARTIAL_LINE: usize = 8 * 1024;
/// End of the output kept for a failed deploy's message.
const TAIL_BYTES: usize = 1024;
/// How long output may keep coming after the command exits, from processes
/// it left running.
const DRAIN: Duration = Duration::from_millis(500);
/// Between asking a timed-out command to stop and killing it.
const KILL_GRACE: Duration = Duration::from_secs(5);
/// Acknowledged results kept, so a repeated request still gets its answer.
const KEEP_ACKED: usize = 256;
/// Fetches and pushes can be slow on a big repo or a slow link.
const GIT_NETWORK_TIMEOUT: Duration = Duration::from_secs(300);

const OUTCOME_SUCCEEDED: repo_action_result::Outcome = repo_action_result::Outcome::Succeeded;
const OUTCOME_FAILED: repo_action_result::Outcome = repo_action_result::Outcome::Failed;
const OUTCOME_REFUSED: repo_action_result::Outcome = repo_action_result::Outcome::Refused;

/// Merges and deploys running or finished, and their output.
#[derive(Default)]
pub struct RepoActions {
    state: Mutex<State>,
    /// One fetch, merge, or checkout at a time in each repo, by repo name.
    repo_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

#[derive(Default)]
struct State {
    /// Running, by request ID, with the repo a deploy runs in.
    running: HashMap<String, Option<String>>,
    /// Finished and not acknowledged yet, oldest first, with whether the
    /// current connection has been sent it.
    done: Vec<(RepoActionResult, bool)>,
    /// Acknowledged, newest last.
    acked: VecDeque<RepoActionResult>,
    /// Deploy output not handed to a connection yet, oldest first.
    output: VecDeque<RepoActionOutput>,
}

enum Begin {
    Start,
    /// The same request is running. Its result goes out when it ends.
    Running,
    /// The same request has finished. Its result goes out again.
    Answered,
    /// Another deploy of the same repo is running here.
    DeployBusy,
}

impl RepoActions {
    pub fn running_count(&self) -> usize {
        self.state.lock().unwrap().running.len()
    }

    fn begin(&self, req: &RepoAction) -> Begin {
        let mut s = self.state.lock().unwrap();
        let id = &req.request_id;
        if s.running.contains_key(id) {
            return Begin::Running;
        }
        if let Some(done) = s.done.iter_mut().find(|(r, _)| &r.request_id == id) {
            done.1 = false;
            return Begin::Answered;
        }
        if let Some(i) = s.acked.iter().position(|r| &r.request_id == id) {
            let result = s.acked.remove(i).expect("found above");
            s.done.push((result, false));
            return Begin::Answered;
        }
        let deploys = req.kind() == repo_action::Kind::Deploy;
        let busy = deploys
            && s.running
                .values()
                .any(|repo| repo.as_deref() == Some(req.repo.as_str()));
        s.running
            .insert(id.clone(), deploys.then(|| req.repo.clone()));
        if busy {
            Begin::DeployBusy
        } else {
            Begin::Start
        }
    }

    fn finish(&self, result: RepoActionResult) {
        let mut s = self.state.lock().unwrap();
        s.running.remove(&result.request_id);
        s.done.push((result, false));
    }

    fn push_output(&self, request_id: &str, chunk: String) {
        self.state
            .lock()
            .unwrap()
            .output
            .push_back(RepoActionOutput {
                request_id: request_id.to_string(),
                chunk,
            });
    }

    /// Output, then results, not yet sent on the current connection. Output
    /// is handed over once; results again after every reconnect until
    /// they're acknowledged.
    pub fn unsent(&self) -> Vec<Body> {
        let mut s = self.state.lock().unwrap();
        let mut out: Vec<Body> = s.output.drain(..).map(Body::RepoActionOutput).collect();
        for (result, sent) in s.done.iter_mut().filter(|(_, sent)| !*sent) {
            *sent = true;
            out.push(Body::RepoActionResult(result.clone()));
        }
        out
    }

    pub fn reset_sent(&self) {
        for (_, sent) in self.state.lock().unwrap().done.iter_mut() {
            *sent = false;
        }
    }

    pub fn ack(&self, request_id: &str) {
        let mut s = self.state.lock().unwrap();
        if let Some(i) = s.done.iter().position(|(r, _)| r.request_id == request_id) {
            let (result, _) = s.done.remove(i);
            s.acked.push_back(result);
            while s.acked.len() > KEEP_ACKED {
                s.acked.pop_front();
            }
        }
    }

    fn repo_lock(&self, repo: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.repo_locks
            .lock()
            .unwrap()
            .entry(repo.to_string())
            .or_default()
            .clone()
    }
}

/// What a merge, a deploy, or a read of a PR's CI came to.
struct Outcome {
    outcome: repo_action_result::Outcome,
    message: String,
    commit_sha: String,
    url: String,
    exit_code: Option<i32>,
    ci_checks: Vec<CiCheck>,
}

impl Outcome {
    fn new(outcome: repo_action_result::Outcome, message: impl Into<String>) -> Outcome {
        Outcome {
            outcome,
            message: message.into(),
            commit_sha: String::new(),
            url: String::new(),
            exit_code: None,
            ci_checks: Vec::new(),
        }
    }

    fn refused(message: impl Into<String>) -> Outcome {
        Outcome::new(OUTCOME_REFUSED, message)
    }

    fn failed(message: impl Into<String>) -> Outcome {
        Outcome::new(OUTCOME_FAILED, message)
    }

    fn succeeded(message: impl Into<String>, commit_sha: &str) -> Outcome {
        Outcome {
            commit_sha: commit_sha.to_string(),
            ..Outcome::new(OUTCOME_SUCCEEDED, message)
        }
    }

    fn with_url(mut self, url: Option<String>) -> Outcome {
        self.url = url.unwrap_or_default();
        self
    }
}

impl Manager {
    /// Handles RepoAction: runs the merge or deploy in the background, then
    /// queues its result. A request ID that's already running or finished
    /// never runs again.
    pub fn repo_action(self: &Arc<Self>, req: RepoAction) {
        let me = self.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let outcome = match me.repo_actions.begin(&req) {
                Begin::Running => return,
                Begin::Answered => {
                    me.outbox.notify_one();
                    return;
                }
                Begin::DeployBusy => Outcome::failed(format!(
                    "Another deploy of {} is running on this machine. Try again once it finishes.",
                    req.repo
                )),
                Begin::Start => me.perform_repo_action(&req).await,
            };
            tracing::info!(
                request = req.request_id,
                task = req.task_id,
                kind = ?req.kind(),
                outcome = ?outcome.outcome,
                ms = started.elapsed().as_millis() as u64,
                "repo action finished: {}",
                outcome.message
            );
            me.repo_actions.finish(RepoActionResult {
                request_id: req.request_id.clone(),
                kind: req.kind,
                outcome: outcome.outcome as i32,
                message: redact(&outcome.message),
                commit_sha: outcome.commit_sha,
                url: outcome.url,
                exit_code: outcome.exit_code,
                ci_checks: outcome.ci_checks,
            });
            me.outbox.notify_one();
        });
    }

    pub fn repo_action_ack(&self, request_id: &str) {
        self.repo_actions.ack(request_id);
    }

    /// The config on disk, so `deploys off` takes effect at once. Falls back
    /// to the one in memory when there's no file to read.
    fn current_config(&self) -> Config {
        if !self.paths.config_file().exists() {
            return self.config();
        }
        match Config::load(&self.paths) {
            Ok(cfg) => {
                self.set_config(cfg.clone());
                cfg
            }
            Err(e) => {
                tracing::warn!("could not reload config: {e:#}");
                self.config()
            }
        }
    }

    async fn perform_repo_action(self: &Arc<Self>, req: &RepoAction) -> Outcome {
        let cfg = self.current_config();
        if let Some(why) = refusal(&cfg, req) {
            return Outcome::refused(why);
        }
        let repo = cfg.repo(&req.repo).cloned().expect("checked in refusal");
        match req.kind() {
            repo_action::Kind::Merge => self.merge(&cfg, &repo, req).await,
            repo_action::Kind::Deploy => self.deploy(&repo, req).await,
            repo_action::Kind::Ci => self.ci(&cfg, &repo, req).await,
            repo_action::Kind::Unspecified => unreachable!("checked in refusal"),
        }
    }
}

/// Why this machine won't take `req` at all, whatever it is.
fn refusal(cfg: &Config, req: &RepoAction) -> Option<String> {
    // Reading a PR's CI changes nothing, so only the repo has to be one of this machine's.
    let reads = req.kind() == repo_action::Kind::Ci;
    if !cfg.deploys && !reads {
        return Some(
            "Merges and deploys are off on this machine. The owner turns them on with `sling-runner config set deploys on`."
                .into(),
        );
    }
    if !cfg.max_mode.writes() && !reads {
        return Some("This machine's max-mode is read-only, so it doesn't merge or deploy.".into());
    }
    if req.kind() == repo_action::Kind::Unspecified {
        return Some("Unknown repo action.".into());
    }
    if cfg.repo(&req.repo).is_none() {
        return Some(format!("This machine has no repo named {:?}.", req.repo));
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Method {
    Squash,
    Merge,
    Rebase,
}

impl Method {
    fn parse(s: &str) -> Option<Method> {
        match s {
            "" | "squash" => Some(Method::Squash),
            "merge" => Some(Method::Merge),
            "rebase" => Some(Method::Rebase),
            _ => None,
        }
    }

    fn gh_flag(self) -> &'static str {
        match self {
            Method::Squash => "--squash",
            Method::Merge => "--merge",
            Method::Rebase => "--rebase",
        }
    }
}

fn valid_sha(sha: &str) -> bool {
    (7..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

fn short(sha: &str) -> &str {
    &sha[..7.min(sha.len())]
}

fn trailer(task_id: &str) -> String {
    format!("Sling-Task: {task_id}")
}

/// The merge commit's message: the title on one line, the body, and the
/// task's trailer.
fn merge_message(req: &RepoAction) -> String {
    let title = req.title.replace(['\r', '\n'], " ");
    let title = match title.trim() {
        "" => format!("Merge {}", req.branch),
        t => t.to_string(),
    };
    let body = req.body.trim();
    let trailer = trailer(&req.task_id);
    if body.is_empty() {
        format!("{title}\n\n{trailer}\n")
    } else {
        format!("{title}\n\n{body}\n\n{trailer}\n")
    }
}

/// A GitHub-style PR URL: `https://<host>/<owner>/<name>/pull/<number>`.
struct PrUrl {
    /// `host/owner/name`, lowercased, as `git::remote_key` gives it.
    repo_key: String,
}

fn github_pr(url: &str) -> Option<PrUrl> {
    let rest = url.trim().strip_prefix("https://")?;
    let mut parts = rest.split('/');
    let host = parts.next()?;
    let owner = parts.next()?;
    let name = parts.next()?;
    let pull = parts.next()?;
    let number = parts.next()?;
    let ok = !host.is_empty()
        && !owner.is_empty()
        && !name.is_empty()
        && pull == "pull"
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
        && parts.next().is_none_or(|p| p.is_empty());
    ok.then(|| PrUrl {
        repo_key: format!("{host}/{owner}/{name}").to_lowercase(),
    })
}

/// Whether the PR is in the repo origin points at, going by origin's URL
/// as configured or with `insteadOf` rewrites applied.
async fn pr_is_for_origin(repo: &Path, expanded: &str, pr: &PrUrl) -> bool {
    let matches = |url: &str| git::remote_key(url).as_deref() == Some(pr.repo_key.as_str());
    if matches(expanded) {
        return true;
    }
    git_ok(repo, &["config", "--get", "remote.origin.url"])
        .await
        .is_ok_and(|raw| matches(&raw))
}

/// A temporary directory under the Runner's data directory, for a worktree
/// or for running `gh` outside any repo. Deleted when dropped, if it's still
/// there.
struct ActionDir(PathBuf);

impl ActionDir {
    /// A fresh path. `create` makes the directory; otherwise `git worktree
    /// add` does.
    fn new(paths: &Paths, create: bool) -> Result<ActionDir, String> {
        let root = paths.actions_dir();
        std::fs::create_dir_all(&root)
            .map_err(|e| format!("Couldn't create {}: {e}", root.display()))?;
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|e| format!("No randomness: {e}"))?;
        let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let path = root.join(name);
        if create {
            std::fs::create_dir(&path)
                .map_err(|e| format!("Couldn't create {}: {e}", path.display()))?;
        }
        Ok(ActionDir(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ActionDir {
    fn drop(&mut self) {
        if self.0.exists()
            && let Err(e) = std::fs::remove_dir_all(&self.0)
        {
            tracing::warn!("could not remove {}: {e}", self.0.display());
        }
    }
}

/// Removes checkouts left behind when the Runner stopped mid-action, and
/// what git knows about them.
pub fn clear_leftovers(paths: &Paths, cfg: &Config) {
    let dir = paths.actions_dir();
    let had_any = std::fs::read_dir(&dir).is_ok_and(|mut d| d.next().is_some());
    if !had_any {
        return;
    }
    if let Err(e) = std::fs::remove_dir_all(&dir) {
        tracing::warn!("could not remove {}: {e}", dir.display());
        return;
    }
    for repo in &cfg.repos {
        let _ = std::process::Command::new("git")
            .args(["worktree", "prune"])
            .current_dir(&repo.path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

async fn git(dir: &Path, args: &[&str]) -> Result<Output, String> {
    run("git", args, Some(dir))
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Runs git and returns its trimmed stdout, or a message with its stderr.
async fn git_ok(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git(dir, args).await?;
    if !out.ok() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            out.stderr.trim()
        ));
    }
    Ok(out.stdout.trim().to_string())
}

async fn git_network(dir: &Path, args: &[&str]) -> Result<Output, String> {
    run_timeout("git", args, Some(dir), GIT_NETWORK_TIMEOUT)
        .await
        .map_err(|e| format!("{e:#}"))
}

async fn fetch(repo: &Path) -> Result<(), String> {
    let out = git_network(repo, &["fetch", "--quiet", "origin"]).await?;
    if !out.ok() {
        return Err(format!("Couldn't fetch origin: {}", out.stderr.trim()));
    }
    Ok(())
}

/// The commit `r` names, if it names one.
async fn resolve(repo: &Path, r: &str) -> Option<String> {
    git_ok(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{r}^{{commit}}"),
        ],
    )
    .await
    .ok()
    .filter(|s| !s.is_empty())
}

async fn is_ancestor(repo: &Path, commit: &str, of: &str) -> bool {
    git(repo, &["merge-base", "--is-ancestor", commit, of])
        .await
        .is_ok_and(|o| o.ok())
}

fn has_trailer(message: &str, trailer: &str) -> bool {
    message.lines().any(|l| l.trim() == trailer)
}

/// A commit on `range` whose message carries the task's trailer, newest
/// first.
async fn find_trailer(repo: &Path, range: &str, task_id: &str) -> Option<String> {
    let trailer = trailer(task_id);
    let grep = format!("--grep={trailer}");
    let out = git_ok(
        repo,
        &[
            "log",
            "--fixed-strings",
            &grep,
            "--format=%H%x00%B%x1e",
            range,
        ],
    )
    .await
    .ok()?;
    out.split('\x1e').find_map(|record| {
        let (sha, message) = record.trim_start().split_once('\0')?;
        has_trailer(message, &trailer).then(|| sha.to_string())
    })
}

/// `-c` options that give git an identity when this machine has none.
async fn identity_args(dir: &Path) -> Vec<&'static str> {
    if git(dir, &["var", "GIT_COMMITTER_IDENT"])
        .await
        .is_ok_and(|o| o.ok())
    {
        return Vec::new();
    }
    vec![
        "-c",
        "user.name=Sling Runner",
        "-c",
        "user.email=runner@sling.invalid",
    ]
}

async fn remove_worktree(repo: &Path, dir: &ActionDir) {
    if !dir.path().exists() {
        return;
    }
    let p = dir.path().display().to_string();
    if git(repo, &["worktree", "remove", "--force", &p])
        .await
        .is_ok_and(|o| o.ok())
    {
        return;
    }
    let _ = std::fs::remove_dir_all(dir.path());
    let _ = git(repo, &["worktree", "prune"]).await;
}

async fn add_worktree(repo: &Path, dir: &ActionDir, commit: &str) -> Result<(), String> {
    let p = dir.path().display().to_string();
    git_ok(
        repo,
        &["worktree", "add", "--quiet", "--detach", &p, commit],
    )
    .await
    .map(|_| ())
}

// ---------------------------------------------------------------- CI

/// The checks `gh pr checks --json name,bucket` printed.
fn parse_ci(json: &str) -> Result<Vec<CiCheck>, String> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("gh pr checks printed something else: {e}"))?;
    let list = v
        .as_array()
        .ok_or("gh pr checks printed something other than a list")?;
    Ok(list
        .iter()
        .map(|c| CiCheck {
            name: c["name"].as_str().unwrap_or_default().to_string(),
            bucket: c["bucket"].as_str().unwrap_or_default().to_string(),
        })
        .collect())
}

impl Manager {
    /// Reads a PR's CI with `gh pr checks`, from a directory outside the
    /// repo. Only a PR of the repo's own remote, so `gh` reads nothing else.
    async fn ci(&self, cfg: &Config, repo: &RepoEntry, req: &RepoAction) -> Outcome {
        let url = req.pr_url.trim();
        let Some(pr) = github_pr(url) else {
            return Outcome::refused(format!("{url:?} isn't a pull request URL."));
        };
        let Some(remote) = git::remote_url(&repo.path).await else {
            return Outcome::failed(format!("{} has no origin remote.", repo.name));
        };
        if !pr_is_for_origin(&repo.path, &remote, &pr).await {
            return Outcome::refused(format!(
                "{url} isn't a PR of {}'s remote on this machine.",
                repo.name
            ));
        }
        let gh = cfg.gh_bin();
        if !git::gh_ready(&gh).await {
            return Outcome::failed(
                "gh isn't logged in on this machine, so it can't read the PR's CI.",
            );
        }
        let dir = match ActionDir::new(&self.paths, true) {
            Ok(d) => d,
            Err(e) => return Outcome::failed(e),
        };
        let args = ["pr", "checks", url, "--json", "name,bucket"];
        let out = match run_timeout(&gh, &args, Some(dir.path()), GIT_NETWORK_TIMEOUT).await {
            Ok(o) => o,
            Err(e) => return Outcome::failed(format!("{e:#}")),
        };
        // It exits non-zero while checks run or after one failed, and still prints them.
        if out.stdout.trim_start().starts_with('[') {
            return match parse_ci(&out.stdout) {
                Ok(checks) => Outcome {
                    ci_checks: checks,
                    ..Outcome::new(OUTCOME_SUCCEEDED, "")
                },
                Err(e) => Outcome::failed(e),
            };
        }
        if out.stderr.contains("no checks reported") {
            return Outcome::new(OUTCOME_SUCCEEDED, "");
        }
        let why = [out.stderr.trim(), out.stdout.trim()]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("no output");
        Outcome::failed(format!("gh pr checks failed: {why}"))
    }
}

// ---------------------------------------------------------------- merge

impl Manager {
    async fn merge(&self, cfg: &Config, repo: &RepoEntry, req: &RepoAction) -> Outcome {
        let default = git::default_branch(&repo.path).await;
        if !req.default_branch.is_empty() && req.default_branch != default {
            return Outcome::refused(format!(
                "Sling asked to merge into {:?}, but the default branch of {} on this machine is {default}.",
                req.default_branch, repo.name
            ));
        }
        if !git::valid_task_branch(&req.branch, &default) {
            return Outcome::refused(format!(
                "Refusing to merge {:?}: only Sling task branches (sling/…) merge, and never the default branch.",
                req.branch
            ));
        }
        if !valid_task_id(&req.task_id) {
            return Outcome::refused(format!(
                "Refusing task ID {:?}: it goes in the commit, so it may only use letters, digits, '_' and '-'.",
                req.task_id
            ));
        }
        let Some(method) = Method::parse(&req.merge_method) else {
            return Outcome::refused(format!(
                "Unknown merge method {:?}. Use squash, merge, or rebase.",
                req.merge_method
            ));
        };
        let Some(remote) = git::remote_url(&repo.path).await else {
            return Outcome::failed(format!("{} has no origin remote to merge into.", repo.name));
        };

        let mut note = String::new();
        let pr = github_pr(&req.pr_url);
        if let Some(pr) = &pr {
            if !pr_is_for_origin(&repo.path, &remote, pr).await {
                return Outcome::refused(format!(
                    "{} isn't a PR of {}'s remote on this machine.",
                    req.pr_url, repo.name
                ));
            }
            let gh = cfg.gh_bin();
            if git::gh_ready(&gh).await {
                return self.merge_with_gh(&gh, repo, req, method, &default).await;
            }
            note = "gh isn't logged in on this machine, so it merged with git and GitHub may leave the PR open. ".into();
        }

        let lock = self.repo_actions.repo_lock(&repo.name);
        let _turn = lock.lock().await;
        let dir = match ActionDir::new(&self.paths, false) {
            Ok(d) => d,
            Err(e) => return Outcome::failed(e),
        };
        let outcome = merge_with_git(&repo.path, &dir, req, method, &default).await;
        remove_worktree(&repo.path, &dir).await;
        match outcome {
            Ok(mut o) => {
                o.message = format!("{note}{}", o.message);
                if o.outcome == OUTCOME_SUCCEEDED {
                    // The PR when there is one, else the merged commit.
                    let url = match pr {
                        Some(_) => Some(req.pr_url.trim().to_string()),
                        None => {
                            git::web_url(&remote).map(|u| format!("{u}/commit/{}", o.commit_sha))
                        }
                    };
                    o = o.with_url(url);
                }
                o
            }
            Err(e) => Outcome::failed(e),
        }
    }

    /// Merges the PR with `gh`, from a directory outside the repo, after
    /// checking that its head and base are the task's branch and the default
    /// branch. A PR that's already merged answers with its merge commit.
    async fn merge_with_gh(
        &self,
        gh: &str,
        repo: &RepoEntry,
        req: &RepoAction,
        method: Method,
        default: &str,
    ) -> Outcome {
        let dir = match ActionDir::new(&self.paths, true) {
            Ok(d) => d,
            Err(e) => return Outcome::failed(e),
        };
        let url = req.pr_url.trim();
        let view = match pr_view(gh, dir.path(), url).await {
            Ok(v) => v,
            Err(e) => return Outcome::failed(e),
        };
        if view.head != req.branch || view.base != default {
            return Outcome::refused(format!(
                "The PR merges {} into {}, but this task's change is {} into {default}.",
                view.head, view.base, req.branch
            ));
        }
        match view.state.as_str() {
            "MERGED" => {
                return match view.merge_commit {
                    Some(sha) => Outcome::succeeded(
                        format!("The PR was already merged, as {}.", short(&sha)),
                        &sha,
                    )
                    .with_url(Some(url.to_string())),
                    None => Outcome::failed(
                        "GitHub says the PR is merged but doesn't name its merge commit.",
                    ),
                };
            }
            "CLOSED" => return Outcome::failed("The PR was closed without being merged."),
            _ => {}
        }
        // The commit Sling made, when it was made here: GitHub then refuses
        // the merge if anything else was pushed to the PR since.
        let head = resolve(&repo.path, &format!("refs/heads/{}", req.branch)).await;
        let mut args = vec!["pr", "merge", url, method.gh_flag()];
        if let Some(head) = &head {
            args.extend(["--match-head-commit", head.as_str()]);
        }
        let out = match run_timeout(gh, &args, Some(dir.path()), GIT_NETWORK_TIMEOUT).await {
            Ok(o) => o,
            Err(e) => return Outcome::failed(format!("{e:#}")),
        };
        if !out.ok() {
            let why = [out.stderr.trim(), out.stdout.trim()]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or("no output");
            return Outcome::failed(format!("gh pr merge failed: {why}"));
        }
        let after = match pr_view(gh, dir.path(), url).await {
            Ok(v) => v,
            Err(e) => return Outcome::failed(e),
        };
        match (after.state.as_str(), after.merge_commit) {
            ("MERGED", Some(sha)) => {
                let how = match method {
                    Method::Squash => "Squash-merged",
                    Method::Merge => "Merged",
                    Method::Rebase => "Rebased and merged",
                };
                Outcome::succeeded(
                    format!("{how} the PR into {default} as {}.", short(&sha)),
                    &sha,
                )
                .with_url(Some(url.to_string()))
            }
            _ => Outcome::failed(
                "GitHub didn't merge the PR right away. It may be waiting for checks or a merge queue.",
            ),
        }
    }
}

struct PrView {
    head: String,
    base: String,
    state: String,
    merge_commit: Option<String>,
}

async fn pr_view(gh: &str, dir: &Path, url: &str) -> Result<PrView, String> {
    let out = run_timeout(
        gh,
        &[
            "pr",
            "view",
            url,
            "--json",
            "headRefName,baseRefName,state,mergeCommit",
        ],
        Some(dir),
        GIT_NETWORK_TIMEOUT,
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    if !out.ok() {
        return Err(format!("gh pr view failed: {}", out.stderr.trim()));
    }
    parse_pr_view(&out.stdout)
}

fn parse_pr_view(json: &str) -> Result<PrView, String> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("gh pr view printed something else: {e}"))?;
    let field = |name: &str| v[name].as_str().unwrap_or_default().to_string();
    let merge_commit = v["mergeCommit"]["oid"]
        .as_str()
        .filter(|s| valid_sha(s))
        .map(str::to_string);
    Ok(PrView {
        head: field("headRefName"),
        base: field("baseRefName"),
        state: field("state"),
        merge_commit,
    })
}

/// Merges the task branch into the default branch in a temporary detached
/// worktree at `dir`, and pushes the result. Never forced: when the default
/// branch moved since the fetch, it fetches and merges again on top, once.
/// `Err` is a failure message.
async fn merge_with_git(
    repo: &Path,
    dir: &ActionDir,
    req: &RepoAction,
    method: Method,
    default: &str,
) -> Result<Outcome, String> {
    let remote_default = format!("origin/{default}");
    let message = merge_message(req);
    let trailer = trailer(&req.task_id);
    fetch(repo).await?;
    let mut moved = false;
    for attempt in 0..2 {
        let base = resolve(repo, &remote_default)
            .await
            .ok_or_else(|| format!("{remote_default} doesn't exist."))?;
        // What was pushed is what was reviewed. A branch that was never
        // pushed can still merge from this machine's copy.
        let tip = match resolve(repo, &format!("refs/remotes/origin/{}", req.branch)).await {
            Some(sha) => sha,
            None => resolve(repo, &format!("refs/heads/{}", req.branch))
                .await
                .ok_or_else(|| format!("{} isn't on origin or on this machine.", req.branch))?,
        };

        // Asking twice is safe: an earlier merge left the trailer behind.
        let merge_base = git_ok(repo, &["merge-base", &tip, &base]).await.ok();
        let range = match &merge_base {
            Some(mb) => format!("{mb}..{base}"),
            None => base.clone(),
        };
        if let Some(sha) = find_trailer(repo, &range, &req.task_id).await {
            return Ok(Outcome::succeeded(
                format!(
                    "{} was already merged into {default}, as {}.",
                    req.branch,
                    short(&sha)
                ),
                &sha,
            ));
        }
        if is_ancestor(repo, &tip, &base).await {
            let tip_message = git_ok(repo, &["log", "-1", "--format=%B", &tip])
                .await
                .unwrap_or_default();
            if has_trailer(&tip_message, &trailer) {
                return Ok(Outcome::succeeded(
                    format!("{} is already on {default}.", req.branch),
                    &base,
                ));
            }
            return Ok(Outcome::failed(format!(
                "{} has no changes that aren't on {default} already.",
                req.branch
            )));
        }

        if attempt == 0 {
            add_worktree(repo, dir, &base).await?;
        } else {
            git_ok(dir.path(), &["reset", "--quiet", "--hard", &base]).await?;
        }
        let wt = dir.path();
        let ident = identity_args(wt).await;
        let with_ident = |args: &[&'static str]| -> Vec<String> {
            ident.iter().chain(args).map(|s| s.to_string()).collect()
        };

        let merged = match method {
            Method::Merge => {
                let mut args = with_ident(&["merge", "--quiet", "--no-ff", "--no-verify", "-m"]);
                args.push(message.clone());
                args.push(tip.clone());
                git(wt, &args.iter().map(String::as_str).collect::<Vec<_>>()).await?
            }
            // A squash that conflicts needs an identity too, or git stops
            // before it writes the conflicts.
            Method::Squash | Method::Rebase => {
                let mut args = with_ident(&["merge", "--quiet", "--squash"]);
                args.push(tip.clone());
                git(wt, &args.iter().map(String::as_str).collect::<Vec<_>>()).await?
            }
        };
        if !merged.ok() {
            let conflicts = git_ok(wt, &["diff", "--name-only", "--diff-filter=U"])
                .await
                .unwrap_or_default();
            let files: Vec<&str> = conflicts.lines().filter(|l| !l.is_empty()).collect();
            if files.is_empty() {
                return Err(format!("git merge failed: {}", merged.stderr.trim()));
            }
            return Ok(Outcome::failed(format!(
                "{} conflicts with {default}, so the merge was aborted. Conflicting files: {}",
                req.branch,
                files.join(", ")
            )));
        }
        if method != Method::Merge {
            if git(wt, &["diff", "--cached", "--quiet"])
                .await
                .is_ok_and(|o| o.ok())
            {
                return Ok(Outcome::failed(format!(
                    "{} has no changes that aren't on {default} already.",
                    req.branch
                )));
            }
            let mut args = with_ident(&["commit", "--quiet", "--no-verify", "-m"]);
            args.push(message.clone());
            git_ok(wt, &args.iter().map(String::as_str).collect::<Vec<_>>()).await?;
        }
        let sha = git_ok(wt, &["rev-parse", "HEAD"]).await?;

        // Never forced, and the user's hooks don't run here: they'd run in a
        // fresh checkout without the repo's dependencies.
        let refspec = format!("HEAD:refs/heads/{default}");
        let pushed =
            git_network(wt, &["push", "--quiet", "--no-verify", "origin", &refspec]).await?;
        if pushed.ok() {
            let how = match method {
                Method::Squash => format!("Squash-merged {} into {default}", req.branch),
                Method::Merge => format!("Merged {} into {default}", req.branch),
                Method::Rebase => format!(
                    "Rebasing needs gh, so this machine squash-merged {} into {default} instead",
                    req.branch
                ),
            };
            let again = if moved {
                " The default branch moved during the merge, so it merged again on top."
            } else {
                ""
            };
            return Ok(Outcome::succeeded(
                format!("{how}, as {}.{again}", short(&sha)),
                &sha,
            ));
        }
        // Merge again only when someone else pushed meanwhile.
        fetch(repo).await?;
        let now = resolve(repo, &remote_default).await;
        if now.as_deref().is_none_or(|n| n == base) {
            return Err(format!(
                "Couldn't push to {default}: {}",
                pushed.stderr.trim()
            ));
        }
        moved = true;
    }
    Err(format!(
        "{default} moved on origin twice while merging, so this machine stopped. Try again."
    ))
}

// ---------------------------------------------------------------- deploy

impl Manager {
    async fn deploy(self: &Arc<Self>, repo: &RepoEntry, req: &RepoAction) -> Outcome {
        let Some(command) = repo.deploy_command.clone() else {
            return Outcome::refused(format!(
                "{name} has no deploy command on this machine. Its owner sets one with `sling-runner repo set {name} deploy-command \"…\"`.",
                name = repo.name
            ));
        };
        let commit = req.commit_sha.trim().to_ascii_lowercase();
        if !valid_sha(&commit) {
            return Outcome::refused(format!("{:?} isn't a commit SHA.", req.commit_sha));
        }
        if git::remote_url(&repo.path).await.is_none() {
            return Outcome::refused(format!(
                "{} has no origin remote, so there's no default branch to deploy from.",
                repo.name
            ));
        }
        let default = git::default_branch(&repo.path).await;
        let remote_default = format!("origin/{default}");
        let dir = match ActionDir::new(&self.paths, false) {
            Ok(d) => d,
            Err(e) => return Outcome::failed(e),
        };

        let checked_out = {
            let lock = self.repo_actions.repo_lock(&repo.name);
            let _turn = lock.lock().await;
            self.check_out_for_deploy(repo, &dir, &commit, &remote_default)
                .await
        };
        let sha = match checked_out {
            Ok(sha) => sha,
            Err(o) => {
                remove_worktree(&repo.path, &dir).await;
                return o;
            }
        };

        let timeout = Duration::from_secs(repo.deploy_timeout_secs().into());
        let env = deploy_env(&sha, &repo.name);
        let me = self.clone();
        let request_id = req.request_id.clone();
        let emit = move |chunk: String| {
            me.repo_actions.push_output(&request_id, chunk);
            me.outbox.notify_one();
        };
        let ran = run_deploy(&command, dir.path(), env, timeout, emit).await;
        remove_worktree(&repo.path, &dir).await;

        let took = format_duration(ran.duration);
        let mut outcome = match (&ran.error, ran.timed_out, ran.exit_code) {
            (Some(e), _, _) => Outcome::failed(e.clone()),
            (None, true, _) => Outcome::failed(format!(
                "The deploy command ran past its {}s limit and was stopped.",
                timeout.as_secs()
            )),
            (None, false, Some(0)) => Outcome::succeeded(
                format!("Deployed {} with `{command}` in {took}.", short(&sha)),
                &sha,
            ),
            (None, false, Some(code)) => Outcome::failed(format!(
                "The deploy command exited with code {code} after {took}."
            )),
            (None, false, None) => Outcome::failed(format!(
                "The deploy command was stopped by a signal after {took}."
            )),
        };
        if outcome.outcome != OUTCOME_SUCCEEDED && !ran.tail.is_empty() {
            outcome.message = format!("{} Last output:\n{}", outcome.message, ran.tail);
        }
        outcome.commit_sha = sha;
        outcome.exit_code = ran.exit_code;
        outcome
    }

    /// Fetches, checks that `commit` is on the remote's default branch, and
    /// checks it out at `dir`. Returns the full SHA.
    async fn check_out_for_deploy(
        &self,
        repo: &RepoEntry,
        dir: &ActionDir,
        commit: &str,
        remote_default: &str,
    ) -> Result<String, Outcome> {
        fetch(&repo.path).await.map_err(Outcome::failed)?;
        let not_on_default = || {
            Outcome::refused(format!(
                "Commit {} isn't on {remote_default}, so this machine won't deploy it. Only merged commits deploy.",
                short(commit)
            ))
        };
        let sha = resolve(&repo.path, commit)
            .await
            .ok_or_else(not_on_default)?;
        if resolve(&repo.path, remote_default).await.is_none() {
            return Err(Outcome::failed(format!("{remote_default} doesn't exist.")));
        }
        if !is_ancestor(&repo.path, &sha, remote_default).await {
            return Err(not_on_default());
        }
        add_worktree(&repo.path, dir, &sha)
            .await
            .map_err(Outcome::failed)?;
        Ok(sha)
    }
}

/// The user's environment without Sling's own variables, plus the commit
/// and repo being deployed. Variables that aren't UTF-8 are left out.
fn deploy_env(sha: &str, repo: &str) -> Vec<(String, String)> {
    deploy_env_from(
        std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))),
        sha,
        repo,
    )
}

fn deploy_env_from(
    vars: impl IntoIterator<Item = (String, String)>,
    sha: &str,
    repo: &str,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = vars
        .into_iter()
        .filter(|(k, _)| !k.starts_with("SLING_"))
        .collect();
    env.extend([
        ("SLING_DEPLOY_COMMIT".to_string(), sha.to_string()),
        ("SLING_DEPLOY_REPO".to_string(), repo.to_string()),
    ]);
    env
}

fn format_duration(d: Duration) -> String {
    let secs = d.as_secs();
    if secs < 60 {
        format!("{}.{}s", secs, d.subsec_millis() / 100)
    } else {
        format!("{}m {}s", secs / 60, secs % 60)
    }
}

/// How a deploy command ended.
#[derive(Debug, Default)]
pub struct Ran {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// Why it never ran.
    pub error: Option<String>,
    /// The end of its output, redacted.
    pub tail: String,
    pub duration: Duration,
}

/// Output on its way to Sling: whole lines every 100 ms, redacted, up to
/// `MAX_OUTPUT_BYTES` in total.
#[derive(Default)]
struct Batcher {
    buf: Vec<u8>,
    sent: usize,
    cut: bool,
    tail: VecDeque<u8>,
}

impl Batcher {
    fn push(&mut self, bytes: &[u8]) {
        self.tail.extend(bytes);
        if self.tail.len() > TAIL_BYTES {
            let extra = self.tail.len() - TAIL_BYTES;
            self.tail.drain(..extra);
        }
        if !self.cut {
            self.buf.extend_from_slice(bytes);
        }
    }

    /// The next chunk to send: complete lines, or everything with `all`.
    /// Waits for the end of a line unless it's very long, so a secret
    /// isn't split across chunks where redaction can't see it.
    fn take(&mut self, all: bool) -> Option<String> {
        let end = if all || self.buf.len() >= MAX_PARTIAL_LINE {
            self.buf.len()
        } else {
            self.buf
                .iter()
                .rposition(|&b| b == b'\n')
                .map_or(0, |i| i + 1)
        };
        if end == 0 {
            return None;
        }
        let room = MAX_OUTPUT_BYTES - self.sent;
        let take = end.min(room);
        let mut text = redact(&String::from_utf8_lossy(&self.buf[..take]));
        self.sent += take;
        self.buf.drain(..end);
        if take < end {
            self.cut = true;
            self.buf.clear();
            text.push_str(&format!(
                "\n… output cut here: Sling keeps the first {} KB …\n",
                MAX_OUTPUT_BYTES / 1024
            ));
        }
        Some(text)
    }

    fn tail(&self) -> String {
        let bytes: Vec<u8> = self.tail.iter().copied().collect();
        let text = String::from_utf8_lossy(&bytes);
        // Start at a line boundary when there's one to start at.
        let text = match text.find('\n') {
            Some(i) if bytes.len() >= TAIL_BYTES && i + 1 < text.len() => &text[i + 1..],
            _ => &text[..],
        };
        redact(text.trim())
    }
}

/// Asks the deploy command's process group to stop, or with `kill`, kills
/// it.
#[cfg(unix)]
fn stop_group(pid: Option<u32>, kill: bool) {
    if let Some(pid) = pid {
        let signal = if kill { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: signals the process group the deploy command leads; it was
        // started in its own group, so this reaches nothing else.
        unsafe {
            libc::kill(-(pid as i32), signal);
        }
    }
}

#[cfg(not(unix))]
fn stop_group(_pid: Option<u32>, _kill: bool) {}

async fn pump<R: AsyncRead + Unpin>(mut from: R, to: mpsc::Sender<Vec<u8>>) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match from.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if to.send(buf[..n].to_vec()).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// Runs a deploy command through the user's login shell in `cwd`, with
/// exactly `env`. Output goes to `emit` in batches as it comes. At the
/// timeout the command's process group is asked to stop, then killed.
pub async fn run_deploy(
    command: &str,
    cwd: &Path,
    env: Vec<(String, String)>,
    timeout: Duration,
    emit: impl Fn(String) + Send + 'static,
) -> Ran {
    let started = Instant::now();
    let (program, args) = if cfg!(windows) {
        (
            "cmd".to_string(),
            vec!["/C".to_string(), command.to_string()],
        )
    } else {
        // stderr joins stdout inside the shell, so the two stay in order.
        (
            crate::exec::shell(),
            vec!["-lc".to_string(), format!("exec 2>&1\n{command}")],
        )
    };
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .envs([("NO_COLOR", "1"), ("GIT_TERMINAL_PROMPT", "0")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Ran {
                error: Some(format!("Couldn't start {program}: {e}")),
                duration: started.elapsed(),
                ..Ran::default()
            };
        }
    };
    let pid = child.id();

    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(64);
    let mut readers: Vec<_> = [
        child
            .stdout
            .take()
            .map(|s| tokio::spawn(pump(s, tx.clone()))),
        child
            .stderr
            .take()
            .map(|s| tokio::spawn(pump(s, tx.clone()))),
    ]
    .into_iter()
    .flatten()
    .collect();
    drop(tx);
    let forwarder = tokio::spawn(async move {
        let mut batch = Batcher::default();
        let mut tick = tokio::time::interval(OUTPUT_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                chunk = rx.recv() => match chunk {
                    Some(bytes) => batch.push(&bytes),
                    None => break,
                },
                _ = tick.tick() => {
                    if let Some(text) = batch.take(false) {
                        emit(text);
                    }
                }
            }
        }
        if let Some(text) = batch.take(true) {
            emit(text);
        }
        batch.tail()
    });

    let mut ran = Ran::default();
    let status = tokio::select! {
        s = child.wait() => Some(s),
        _ = tokio::time::sleep(timeout) => None,
    };
    let status = match status {
        Some(s) => s,
        None => {
            ran.timed_out = true;
            stop_group(pid, false);
            match tokio::time::timeout(KILL_GRACE, child.wait()).await {
                Ok(s) => s,
                Err(_) => {
                    stop_group(pid, true);
                    // Where there's no process group, at least the command.
                    let _ = child.start_kill();
                    child.wait().await
                }
            }
        }
    };
    match status {
        Ok(s) if !ran.timed_out => ran.exit_code = s.code(),
        Ok(_) => {}
        Err(e) => ran.error = Some(format!("Lost track of the deploy command: {e}")),
    }
    if ran.timed_out {
        // Nothing it started may outlive the limit.
        stop_group(pid, true);
    }
    // Processes it left running may hold the pipes open. Stop reading after
    // a moment rather than waiting on them.
    let drain = async {
        for r in readers.iter_mut() {
            let _ = r.await;
        }
    };
    if tokio::time::timeout(DRAIN, drain).await.is_err() {
        for r in &readers {
            r.abort();
        }
    }
    ran.tail = forwarder.await.unwrap_or_default();
    ran.duration = started.elapsed();
    ran
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn pr_urls_are_github_shaped() {
        let pr = github_pr("https://github.com/Acme/Site/pull/12").unwrap();
        assert_eq!(pr.repo_key, "github.com/acme/site");
        assert!(github_pr("https://github.com/acme/site/pull/12/").is_some());
        assert!(github_pr("https://ghe.example.com/acme/site/pull/3").is_some());
        assert!(
            github_pr("https://github.com/acme/site/compare/main...sling/x?expand=1").is_none()
        );
        assert!(github_pr("https://github.com/acme/site/pull/12/files").is_none());
        assert!(github_pr("https://github.com/acme/site/pull/x").is_none());
        assert!(github_pr("http://github.com/acme/site/pull/12").is_none());
        assert!(github_pr("").is_none());
    }

    #[test]
    fn merge_messages_end_with_the_trailer() {
        let req = RepoAction {
            task_id: "tsk_1".into(),
            branch: "sling/tsk_1-fix".into(),
            title: "Fix the footer\nyear".into(),
            body: "Closes the bug.\n".into(),
            ..Default::default()
        };
        assert_eq!(
            merge_message(&req),
            "Fix the footer year\n\nCloses the bug.\n\nSling-Task: tsk_1\n"
        );
        let bare = RepoAction {
            title: "  ".into(),
            body: String::new(),
            ..req
        };
        assert_eq!(
            merge_message(&bare),
            "Merge sling/tsk_1-fix\n\nSling-Task: tsk_1\n"
        );
        assert!(has_trailer("x\n\nSling-Task: tsk_1\n", "Sling-Task: tsk_1"));
        assert!(!has_trailer(
            "x\n\nSling-Task: tsk_12\n",
            "Sling-Task: tsk_1"
        ));
    }

    #[test]
    fn task_ids_and_shas_are_checked() {
        assert!(valid_task_id("tsk_01jcabcdefk3v9qa"));
        assert!(!valid_task_id(""));
        assert!(!valid_task_id("tsk_1\nSling-Task: other"));
        assert!(!valid_task_id("../../Documents"));
        assert!(!valid_task_id("/etc"));
        assert!(valid_sha("abc1234"));
        assert!(valid_sha(&"a".repeat(40)));
        assert!(!valid_sha("abc123"));
        assert!(!valid_sha("--all"));
        assert!(!valid_sha("HEAD"));
    }

    #[test]
    fn pr_views_parse() {
        let v = parse_pr_view(
            r#"{"headRefName":"sling/x","baseRefName":"main","state":"MERGED","mergeCommit":{"oid":"0123456789abcdef0123456789abcdef01234567"}}"#,
        )
        .unwrap();
        assert_eq!(
            (v.head.as_str(), v.base.as_str(), v.state.as_str()),
            ("sling/x", "main", "MERGED")
        );
        assert_eq!(
            v.merge_commit.as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        let open = parse_pr_view(
            r#"{"headRefName":"sling/x","baseRefName":"main","state":"OPEN","mergeCommit":null}"#,
        )
        .unwrap();
        assert!(open.merge_commit.is_none());
        assert!(parse_pr_view("not json").is_err());
    }

    #[test]
    fn output_goes_out_in_whole_lines_and_stops_at_the_cap() {
        let mut b = Batcher::default();
        b.push(b"one\ntw");
        assert_eq!(b.take(false).as_deref(), Some("one\n"));
        assert_eq!(b.take(false), None, "waits for the rest of the line");
        b.push(b"o\n");
        assert_eq!(b.take(false).as_deref(), Some("two\n"));
        b.push(b"no newline");
        assert_eq!(b.take(true).as_deref(), Some("no newline"));

        let mut b = Batcher::default();
        let line = vec![b'x'; 1023];
        let mut total = String::new();
        for _ in 0..300 {
            b.push(&line);
            b.push(b"\n");
            if let Some(t) = b.take(false) {
                total.push_str(&t);
            }
        }
        if let Some(t) = b.take(true) {
            total.push_str(&t);
        }
        assert!(total.contains("output cut here"));
        assert!(total.len() < MAX_OUTPUT_BYTES + 200, "{}", total.len());
        assert!(b.tail().ends_with('x'), "the tail keeps the real end");
    }

    #[test]
    fn output_is_redacted() {
        let mut b = Batcher::default();
        b.push(b"token ghp_abcdefghijklmnopqrstuvwxyz0123\n");
        let t = b.take(false).unwrap();
        assert!(!t.contains("ghp_abcdef"), "{t}");
    }
}
