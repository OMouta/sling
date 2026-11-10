//! Removes old task worktrees. A worktree is removed once its task's spool is
//! gone (the server is done with it) and it hasn't been touched for 7 days.
//! Then task branches with nothing left to deliver go too.

use std::path::Path;
use std::time::{Duration, SystemTime};

use anyhow::Result;

use crate::config::{Config, Paths};
use crate::sys::run;

pub const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub struct Collected {
    pub worktrees: usize,
    pub branches: usize,
}

/// `busy` names repos with a task under way, whose branches are left alone.
pub async fn collect(
    cfg: &Config,
    paths: &Paths,
    keep_for: Duration,
    busy: impl Fn(&str) -> bool,
) -> Result<Collected> {
    let worktrees = remove_worktrees(cfg, paths, keep_for).await?;
    let mut branches = 0;
    for repo in &cfg.repos {
        if busy(&repo.name) {
            continue;
        }
        match crate::git::prune_task_branches(&repo.path).await {
            Ok(n) => branches += n,
            Err(e) => tracing::warn!("could not clean up branches in {}: {e:#}", repo.name),
        }
    }
    Ok(Collected {
        worktrees,
        branches,
    })
}

async fn remove_worktrees(cfg: &Config, paths: &Paths, keep_for: Duration) -> Result<usize> {
    let root = cfg.worktree_root(paths);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(0);
    };
    let spool = paths.spool_dir();
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(task_id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !path.is_dir() || spool.join(task_id).exists() {
            continue;
        }
        let age = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .unwrap_or_default();
        if age < keep_for {
            continue;
        }
        match remove_worktree(&path).await {
            Ok(()) => removed += 1,
            Err(e) => tracing::warn!("could not remove {}: {e:#}", path.display()),
        }
    }
    Ok(removed)
}

async fn remove_worktree(path: &Path) -> Result<()> {
    // The main repo is the parent of the worktree's common git dir.
    let common = run(
        "git",
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        Some(path),
    )
    .await?;
    if common.ok() {
        let git_dir = Path::new(common.stdout.trim());
        if let Some(repo) = git_dir.parent() {
            crate::git::worktree_remove(repo, path).await?;
            let _ = run("git", &["worktree", "prune"], Some(repo)).await;
            return Ok(());
        }
    }
    // Not a worktree any more. Just delete the directory.
    tokio::fs::remove_dir_all(path).await?;
    Ok(())
}
