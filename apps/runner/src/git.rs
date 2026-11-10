//! Git operations the Runner performs itself. Agents never commit or push;
//! everything that leaves the machine goes through here.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};

use crate::sys::{Output, run, run_timeout};

/// For fetches, checkouts, commits and pushes, which can take minutes in a
/// big repo or on a slow network.
const SLOW: Duration = Duration::from_secs(300);

async fn git(dir: &Path, args: &[&str]) -> Result<Output> {
    run("git", args, Some(dir)).await
}

async fn git_slow(dir: &Path, args: &[&str]) -> Result<Output> {
    run_timeout("git", args, Some(dir), SLOW).await
}

async fn git_ok(dir: &Path, args: &[&str]) -> Result<String> {
    checked(args, git(dir, args).await?)
}

async fn git_slow_ok(dir: &Path, args: &[&str]) -> Result<String> {
    checked(args, git_slow(dir, args).await?)
}

fn checked(args: &[&str], out: Output) -> Result<String> {
    if !out.ok() {
        bail!("git {} failed: {}", args.join(" "), out.stderr.trim());
    }
    Ok(out.stdout.trim().to_string())
}

/// The repo root containing `path`.
pub async fn toplevel(path: &Path) -> Result<PathBuf> {
    let out = git_ok(path, &["rev-parse", "--show-toplevel"])
        .await
        .with_context(|| format!("{} is not inside a git repository", path.display()))?;
    Ok(PathBuf::from(out))
}

pub async fn remote_url(repo: &Path) -> Option<String> {
    git_ok(repo, &["remote", "get-url", "origin"]).await.ok()
}

/// The branch Sling merges into and branches from. Never just the branch
/// that happens to be checked out: when nothing names the default, it's
/// `main`, so a merge refuses rather than landing on a feature branch.
pub async fn default_branch(repo: &Path) -> String {
    if let Ok(r) = git_ok(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .await
        && let Some(b) = r.strip_prefix("origin/")
    {
        return b.to_string();
    }
    for prefix in ["refs/remotes/origin/", "refs/heads/"] {
        for candidate in ["main", "master"] {
            if ref_exists(repo, &format!("{prefix}{candidate}")).await {
                return candidate.to_string();
            }
        }
    }
    if let Ok(b) = git_ok(repo, &["config", "--get", "init.defaultBranch"]).await
        && !b.is_empty()
        && ref_exists(repo, &format!("refs/heads/{b}")).await
    {
        return b;
    }
    for (pattern, prefix) in [("refs/remotes/origin/", "origin/"), ("refs/heads/", "")] {
        let Ok(list) = git_ok(
            repo,
            &["for-each-ref", "--format=%(refname:short)", pattern],
        )
        .await
        else {
            continue;
        };
        let names: Vec<&str> = list
            .lines()
            .filter_map(|l| l.strip_prefix(prefix))
            .filter(|l| !l.is_empty() && *l != "HEAD")
            .collect();
        if let [only] = names[..] {
            return only.to_string();
        }
    }
    "main".into()
}

async fn ref_exists(repo: &Path, name: &str) -> bool {
    git(repo, &["rev-parse", "--verify", "--quiet", name])
        .await
        .is_ok_and(|o| o.ok())
}

pub async fn fetch(repo: &Path) -> Result<()> {
    if remote_url(repo).await.is_none() {
        return Ok(());
    }
    git_slow_ok(repo, &["fetch", "--quiet", "origin"])
        .await
        .map(|_| ())
}

/// Picks the commit a task branches from: the remote default branch when there
/// is one, otherwise the local one.
pub async fn base_ref(repo: &Path, default_branch: &str) -> Result<(String, String)> {
    let remote = format!("origin/{default_branch}");
    for r in [remote.as_str(), default_branch, "HEAD"] {
        if let Ok(sha) = git_ok(repo, &["rev-parse", "--verify", &format!("{r}^{{commit}}")]).await
        {
            return Ok((r.to_string(), sha));
        }
    }
    bail!("could not find a commit to branch from")
}

/// A branch name Sling may create: `sling/...`, a valid ref, and not the
/// default branch. The control plane picks the name, so the Runner checks it.
pub fn valid_task_branch(branch: &str, default_branch: &str) -> bool {
    branch.starts_with("sling/")
        && branch != default_branch
        && branch.len() <= 120
        && branch
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
        && !branch.contains("..")
        && !branch.ends_with('/')
        && !branch.ends_with(".lock")
}

/// Adds a worktree on a new `branch` from `base`. If that fails part way,
/// removes what it made, so a retry starts clean.
pub async fn worktree_add(repo: &Path, path: &Path, branch: &str, base: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let had_path = path.exists();
    let had_branch = branch_exists(repo, branch).await;
    let p = path.display().to_string();
    let added = git_slow_ok(
        repo,
        &["worktree", "add", "--quiet", "-b", branch, &p, base],
    )
    .await;
    if added.is_err() {
        let _ = git(repo, &["worktree", "remove", "--force", &p]).await;
        if !had_path {
            let _ = tokio::fs::remove_dir_all(path).await;
        }
        let _ = git(repo, &["worktree", "prune"]).await;
        if !had_branch && branch_exists(repo, branch).await {
            let _ = git(repo, &["branch", "-D", branch]).await;
        }
    }
    added.map(|_| ())
}

async fn branch_exists(repo: &Path, branch: &str) -> bool {
    ref_exists(repo, &format!("refs/heads/{branch}")).await
}

pub async fn worktree_remove(repo: &Path, path: &Path) -> Result<()> {
    let p = path.display().to_string();
    git_ok(repo, &["worktree", "remove", "--force", &p])
        .await
        .map(|_| ())
}

pub struct Committed {
    pub sha: String,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

pub struct CommitResult {
    pub committed: Option<Committed>,
    /// Untracked files left out because the harness didn't report creating them.
    pub left_out: Vec<String>,
}

/// Commits the task's changes. Stages every change to tracked files, plus new
/// files the harness reported creating. Other untracked files, such as build
/// output from running tests, stay out of the commit. Commits the agent made
/// itself count too: the result is the branch's tip whenever it moved from
/// `base_sha`.
pub async fn commit_changes(
    worktree: &Path,
    message: &str,
    base_sha: &str,
    reported: &[PathBuf],
) -> Result<CommitResult> {
    git_slow_ok(worktree, &["add", "-u"]).await?;
    let root = std::fs::canonicalize(worktree)?;
    for path in reported {
        let abs = if path.is_absolute() {
            path.clone()
        } else {
            root.join(path)
        };
        let Ok(abs) = std::fs::canonicalize(&abs) else {
            continue;
        };
        let Ok(rel) = abs.strip_prefix(&root) else {
            continue;
        };
        if rel
            .components()
            .next()
            .is_some_and(|c| c.as_os_str() == ".git")
        {
            continue;
        }
        let rel = rel.display().to_string();
        let _ = git(worktree, &["add", "--", &rel]).await;
    }
    let left_out: Vec<String> = git_ok(worktree, &["ls-files", "--others", "--exclude-standard"])
        .await?
        .lines()
        .map(str::to_string)
        .filter(|l| !l.is_empty())
        .collect();

    let staged = git(worktree, &["diff", "--cached", "--quiet"]).await?;
    if !staged.ok() {
        commit(worktree, message).await?;
    }
    // The agent may have committed some or all of its work itself.
    let sha = git_ok(worktree, &["rev-parse", "HEAD"]).await?;
    if sha == base_sha {
        return Ok(CommitResult {
            committed: None,
            left_out,
        });
    }
    let stat = git_ok(worktree, &["diff", "--shortstat", base_sha, &sha]).await?;
    let (files_changed, insertions, deletions) = parse_shortstat(&stat);
    Ok(CommitResult {
        committed: Some(Committed {
            sha,
            files_changed,
            insertions,
            deletions,
        }),
        left_out,
    })
}

async fn commit(worktree: &Path, message: &str) -> Result<()> {
    let mut out = git_slow(
        worktree,
        &["commit", "--quiet", "--no-verify", "-m", message],
    )
    .await?;
    if !out.ok() && out.stderr.contains("user.email") {
        // No git identity on this machine. Commit as the Runner instead.
        out = git_slow(
            worktree,
            &[
                "-c",
                "user.name=Sling Runner",
                "-c",
                "user.email=runner@sling.invalid",
                "commit",
                "--quiet",
                "--no-verify",
                "-m",
                message,
            ],
        )
        .await?;
    }
    if !out.ok() {
        bail!("git commit failed: {}", out.stderr.trim());
    }
    Ok(())
}

/// Parses `3 files changed, 10 insertions(+), 2 deletions(-)`.
pub fn parse_shortstat(s: &str) -> (u32, u32, u32) {
    let mut out = (0, 0, 0);
    for part in s.split(',') {
        let part = part.trim();
        let n: u32 = part
            .split_whitespace()
            .next()
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        if part.contains("file") {
            out.0 = n;
        } else if part.contains("insertion") {
            out.1 = n;
        } else if part.contains("deletion") {
            out.2 = n;
        }
    }
    out
}

/// Pushes the task branch. Never force-pushes. Skips the repo's pre-push
/// hooks, which would run against the user's own checkout rather than the
/// task's work.
pub async fn push(repo: &Path, branch: &str) -> Result<()> {
    if remote_url(repo).await.is_none() {
        bail!("this repo has no `origin` remote to push to");
    }
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    git_slow_ok(
        repo,
        &["push", "--quiet", "--no-verify", "origin", &refspec],
    )
    .await
    .map(|_| ())
}

/// `https://github.com/owner/repo` from common remote URL forms.
pub fn web_url(remote: &str) -> Option<String> {
    let r = remote.trim().trim_end_matches(".git");
    if let Some(rest) = r.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        return Some(format!("https://{host}/{path}"));
    }
    if let Some(rest) = r.strip_prefix("ssh://git@") {
        let (host, path) = rest.split_once('/')?;
        return Some(format!("https://{}/{path}", host.split(':').next()?));
    }
    if r.starts_with("https://") || r.starts_with("http://") {
        // Drop any credentials embedded in the URL.
        let (scheme, rest) = r.split_once("://")?;
        let rest = rest.rsplit_once('@').map(|(_, h)| h).unwrap_or(rest);
        return Some(format!("{scheme}://{rest}"));
    }
    None
}

/// `host/owner/name` from a git remote, lowercased and without `.git`, so the
/// same repo matches across machines. `None` for remotes it can't read, such
/// as local paths. Gives the same result as the control plane's `remoteKey`.
pub fn remote_key(remote: &str) -> Option<String> {
    let mut r = remote.trim();
    if r.is_empty() {
        return None;
    }
    r = strip_suffix_ignore_case(r, ".git");
    let r = r.trim_end_matches('/');
    let (host, path) = match scp_like(r) {
        Some(parts) => parts,
        None => url_parts(r)?,
    };
    let path = strip_suffix_ignore_case(path.trim_start_matches('/'), ".git");
    if host.is_empty() || !path.contains('/') {
        return None;
    }
    Some(format!("{host}/{path}").to_lowercase())
}

fn strip_suffix_ignore_case<'a>(s: &'a str, suffix: &str) -> &'a str {
    if s.len() >= suffix.len()
        && s.is_char_boundary(s.len() - suffix.len())
        && s[s.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
    {
        &s[..s.len() - suffix.len()]
    } else {
        s
    }
}

/// `user@host:path`, where the user is word characters, `.` and `-`.
fn scp_like(r: &str) -> Option<(&str, &str)> {
    let (user, rest) = r.split_once('@')?;
    if user.is_empty()
        || !user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return None;
    }
    let (host, path) = rest.split_once(':')?;
    if host.is_empty() || host.contains('/') || path.is_empty() {
        return None;
    }
    Some((host, path))
}

/// Host and path of an `http`, `https`, `ssh`, or `git` URL, without the
/// user, port, query, or fragment.
fn url_parts(r: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = r.split_once("://")?;
    if !["http", "https", "ssh", "git"]
        .iter()
        .any(|s| scheme.eq_ignore_ascii_case(s))
    {
        return None;
    }
    let end = rest.find(['?', '#']).unwrap_or(rest.len());
    let rest = &rest[..end];
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if host_port.starts_with('[') {
        &host_port[..=host_port.find(']')?]
    } else {
        host_port.split(':').next().unwrap_or_default()
    };
    Some((host, path))
}

pub fn compare_url(remote: &str, base: &str, branch: &str) -> Option<String> {
    web_url(remote).map(|u| format!("{u}/compare/{base}...{branch}?expand=1"))
}

/// Whether `gh` (the configured binary) is installed and logged in.
pub async fn gh_ready(gh: &str) -> bool {
    run(gh, &["auth", "status"], None)
        .await
        .map(|o| o.ok())
        .unwrap_or(false)
}

/// Opens a PR with `gh`, or returns the existing one for this branch.
pub async fn open_pr(
    gh: &str,
    repo: &Path,
    branch: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<String> {
    let existing = run_timeout(
        gh,
        &[
            "pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url",
        ],
        Some(repo),
        SLOW,
    )
    .await?;
    let url = existing.stdout.trim();
    if existing.ok() && url.starts_with("http") {
        return Ok(url.to_string());
    }
    let out = run_timeout(
        gh,
        &[
            "pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body,
        ],
        Some(repo),
        SLOW,
    )
    .await?;
    if !out.ok() {
        bail!("gh pr create failed: {}", out.stderr.trim());
    }
    out.stdout
        .lines()
        .rev()
        .find(|l| l.starts_with("http"))
        .map(str::to_string)
        .context("gh did not print a PR URL")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_branches_are_checked() {
        assert!(valid_task_branch("sling/ab12cd-fix-footer", "main"));
        assert!(!valid_task_branch("main", "main"));
        assert!(!valid_task_branch("sling/../main", "main"));
        assert!(!valid_task_branch("feature/x", "main"));
        assert!(!valid_task_branch("sling/x y", "main"));
        assert!(!valid_task_branch("sling/x.lock", "main"));
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(["-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn repo_with_commit() -> (tempfile::TempDir, PathBuf, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo = std::fs::canonicalize(dir.path()).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("README.md"), "# site\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-qm", "init"]);
        let base = sh(&repo, &["rev-parse", "HEAD"]);
        (dir, repo, base)
    }

    #[tokio::test]
    async fn work_the_agent_committed_itself_is_reported() {
        let (_dir, repo, base) = repo_with_commit();
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        sh(&repo, &["add", "a.txt"]);
        sh(&repo, &["commit", "-qm", "by the agent"]);
        let agent_sha = sh(&repo, &["rev-parse", "HEAD"]);

        let result = commit_changes(&repo, "task", &base, &[]).await.unwrap();
        let c = result.committed.expect("the agent's commit counts");
        assert_eq!(c.sha, agent_sha);
        assert_eq!((c.files_changed, c.insertions), (1, 1));

        // Changes left after the agent's own commit go on top of it.
        std::fs::write(repo.join("README.md"), "# site\nmore\n").unwrap();
        let result = commit_changes(&repo, "task", &base, &[]).await.unwrap();
        let c = result.committed.unwrap();
        assert_ne!(c.sha, agent_sha);
        assert_eq!(c.files_changed, 2);
        assert_eq!(sh(&repo, &["log", "-1", "--format=%s"]), "task");
    }

    #[tokio::test]
    async fn a_failed_worktree_add_leaves_no_branch_or_folder() {
        let (dir, repo, base) = repo_with_commit();
        // Fails after git has made the branch and checked it out.
        hook(&repo, "post-checkout");
        let path = dir.path().join("worktrees/t1");
        assert!(worktree_add(&repo, &path, "sling/t1", &base).await.is_err());
        assert!(!path.exists());
        assert!(!branch_exists(&repo, "sling/t1").await);
        assert_eq!(
            sh(&repo, &["worktree", "list", "--porcelain"])
                .lines()
                .filter(|l| l.starts_with("worktree "))
                .count(),
            1
        );
    }

    /// Installs a hook that always fails.
    fn hook(repo: &Path, name: &str) {
        let hook = repo.join(".git/hooks").join(name);
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[tokio::test]
    async fn task_pushes_skip_pre_push_hooks() {
        let (dir, repo, base) = repo_with_commit();
        let remote = dir.path().join("remote.git");
        sh(&repo, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        sh(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        hook(&repo, "pre-push");
        sh(&repo, &["branch", "sling/t2", &base]);
        push(&repo, "sling/t2").await.unwrap();
        assert_eq!(sh(&remote, &["rev-parse", "refs/heads/sling/t2"]), base);
    }

    #[tokio::test]
    async fn the_default_branch_is_never_just_the_checked_out_one() {
        let (dir, repo, _) = repo_with_commit();
        sh(&repo, &["branch", "-m", "trunk"]);
        sh(&repo, &["config", "init.defaultBranch", "nope"]);
        assert_eq!(default_branch(&repo).await, "trunk", "the only branch");

        sh(&repo, &["checkout", "-qb", "feature"]);
        assert_eq!(default_branch(&repo).await, "main", "no way to tell");
        sh(&repo, &["config", "init.defaultBranch", "trunk"]);
        assert_eq!(default_branch(&repo).await, "trunk");
        sh(&repo, &["config", "--unset", "init.defaultBranch"]);

        // The remote's only branch, when origin/HEAD isn't set.
        let remote = dir.path().join("remote.git");
        sh(&repo, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        sh(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        sh(&repo, &["push", "-q", "origin", "trunk"]);
        sh(&repo, &["fetch", "-q", "origin"]);
        assert_eq!(default_branch(&repo).await, "trunk");

        sh(&repo, &["branch", "master"]);
        assert_eq!(default_branch(&repo).await, "master");
        sh(&repo, &["remote", "set-head", "origin", "trunk"]);
        assert_eq!(default_branch(&repo).await, "trunk");
    }

    #[tokio::test]
    async fn nothing_to_commit_when_the_branch_did_not_move() {
        let (_dir, repo, base) = repo_with_commit();
        let result = commit_changes(&repo, "task", &base, &[]).await.unwrap();
        assert!(result.committed.is_none());
    }

    #[test]
    fn shortstat_parses() {
        assert_eq!(
            parse_shortstat(" 2 files changed, 14 insertions(+), 1 deletion(-)"),
            (2, 14, 1)
        );
        assert_eq!(
            parse_shortstat(" 1 file changed, 3 insertions(+)"),
            (1, 3, 0)
        );
    }

    #[test]
    fn web_urls_from_remotes() {
        assert_eq!(
            web_url("git@github.com:a/site.git").as_deref(),
            Some("https://github.com/a/site")
        );
        assert_eq!(
            web_url("https://user:tok@github.com/a/site.git").as_deref(),
            Some("https://github.com/a/site")
        );
        assert_eq!(
            compare_url("git@github.com:a/site.git", "main", "sling/x").as_deref(),
            Some("https://github.com/a/site/compare/main...sling/x?expand=1")
        );
    }

    #[test]
    fn remote_keys_match_the_control_plane() {
        // Outputs of `remoteKey` in packages/core for the same inputs.
        let cases: &[(&str, Option<&str>)] = &[
            ("git@github.com:Acme/site.git", Some("github.com/acme/site")),
            ("https://github.com/acme/site", Some("github.com/acme/site")),
            (
                "https://user:tok@github.com/acme/site.git/",
                Some("github.com/acme/site"),
            ),
            (
                "ssh://git@github.com/acme/site.git",
                Some("github.com/acme/site"),
            ),
            ("", None),
            ("   ", None),
            ("/srv/git/site.git", None),
            ("file:///srv/git/site.git", None),
            ("https://github.com/", None),
            ("https://github.com", None),
            (
                "https://GitHub.com/Acme/Site.GIT",
                Some("github.com/acme/site"),
            ),
            ("http://localhost:3000/a/b.git", Some("localhost/a/b")),
            (
                "https://gitlab.com/group/sub/repo.git",
                Some("gitlab.com/group/sub/repo"),
            ),
            ("git://example.org/a/b", Some("example.org/a/b")),
            (
                "ssh://git@host.example:2222/team/repo.git",
                Some("host.example/team/repo"),
            ),
            (
                "user.name@host.example:team/repo",
                Some("host.example/team/repo"),
            ),
            (
                "git@github.com:acme/site.git/",
                Some("github.com/acme/site"),
            ),
            (
                "https://github.com/acme/site/",
                Some("github.com/acme/site"),
            ),
            (
                "https://github.com//acme/site",
                Some("github.com/acme/site"),
            ),
            ("https://github.com/acme", None),
            ("ftp://github.com/a/b", None),
            ("github.com:acme/site", None),
            ("https://[::1]:8080/a/b", Some("[::1]/a/b")),
            ("https://github.com/a/b?x=1#frag", Some("github.com/a/b")),
            (
                "https://bitbucket.org/team/repo.git ",
                Some("bitbucket.org/team/repo"),
            ),
            ("  git@github.com:a/b.git  ", Some("github.com/a/b")),
            ("https://github.com/a/b.git.git", Some("github.com/a/b")),
            ("C:\\repos\\site", None),
            ("https://github.com/a%20b/c", Some("github.com/a%20b/c")),
            ("ssh://github.com/a/b", Some("github.com/a/b")),
            ("https://:tok@github.com/a/b", Some("github.com/a/b")),
        ];
        for (remote, want) in cases {
            assert_eq!(remote_key(remote).as_deref(), *want, "{remote:?}");
        }
    }
}
