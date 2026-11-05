//! Git operations the Runner performs itself. Codex never commits or pushes;
//! everything that leaves the machine goes through here.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::sys::{Output, run};

async fn git(dir: &Path, args: &[&str]) -> Result<Output> {
    run("git", args, Some(dir)).await
}

async fn git_ok(dir: &Path, args: &[&str]) -> Result<String> {
    let out = git(dir, args).await?;
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
    for candidate in ["main", "master"] {
        if git(repo, &["rev-parse", "--verify", "--quiet", candidate])
            .await
            .map(|o| o.ok())
            .unwrap_or(false)
        {
            return candidate.to_string();
        }
    }
    git_ok(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .unwrap_or_else(|_| "main".into())
}

pub async fn fetch(repo: &Path) -> Result<()> {
    if remote_url(repo).await.is_none() {
        return Ok(());
    }
    git_ok(repo, &["fetch", "--quiet", "origin"])
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

pub async fn worktree_add(repo: &Path, path: &Path, branch: &str, base: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let p = path.display().to_string();
    git_ok(
        repo,
        &["worktree", "add", "--quiet", "-b", branch, &p, base],
    )
    .await
    .map(|_| ())
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
/// output from running tests, stay out of the commit.
pub async fn commit_changes(
    worktree: &Path,
    message: &str,
    base_sha: &str,
    reported: &[PathBuf],
) -> Result<CommitResult> {
    git_ok(worktree, &["add", "-u"]).await?;
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
    if staged.ok() {
        return Ok(CommitResult {
            committed: None,
            left_out,
        });
    }
    let mut out = git(
        worktree,
        &["commit", "--quiet", "--no-verify", "-m", message],
    )
    .await?;
    if !out.ok() && out.stderr.contains("user.email") {
        // No git identity on this machine. Commit as the Runner instead.
        out = git(
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
    let sha = git_ok(worktree, &["rev-parse", "HEAD"]).await?;
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

/// Pushes the task branch. Never force-pushes.
pub async fn push(repo: &Path, branch: &str) -> Result<()> {
    if remote_url(repo).await.is_none() {
        bail!("this repo has no `origin` remote to push to");
    }
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    git_ok(repo, &["push", "--quiet", "origin", &refspec])
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

pub fn compare_url(remote: &str, base: &str, branch: &str) -> Option<String> {
    web_url(remote).map(|u| format!("{u}/compare/{base}...{branch}?expand=1"))
}

pub async fn gh_ready() -> bool {
    run("gh", &["auth", "status"], None)
        .await
        .map(|o| o.ok())
        .unwrap_or(false)
}

/// Opens a PR with `gh`, or returns the existing one for this branch.
pub async fn open_pr(
    repo: &Path,
    branch: &str,
    base: &str,
    title: &str,
    body: &str,
) -> Result<String> {
    let existing = run(
        "gh",
        &[
            "pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url",
        ],
        Some(repo),
    )
    .await?;
    let url = existing.stdout.trim();
    if existing.ok() && url.starts_with("http") {
        return Ok(url.to_string());
    }
    let out = run(
        "gh",
        &[
            "pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body,
        ],
        Some(repo),
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
}
