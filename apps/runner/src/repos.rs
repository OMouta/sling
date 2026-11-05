//! The repos Sling may work in: `sling-runner repo add|list|remove`, and the
//! same changes when they come from Sling. Sling can only add a repo the
//! Runner found itself, and only while `remote-repos` is on.

use std::path::Path;

use anyhow::{Context, Result, bail};
use sling_runner_protocol::{RepoChange, repo_change};

use crate::config::{Config, Paths, RepoEntry};
use crate::git;
use crate::scan::{self, Found};

/// What Sling says when the owner turned remote repo changes off.
pub const REMOTE_OFF: &str = "This machine doesn't let Sling change its repos. \
     Turn it on with `sling-runner config set remote-repos on`, or use `sling-runner repo add` there.";

pub fn valid_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')
}

pub async fn add(
    paths: &Paths,
    path: &Path,
    name: Option<String>,
    network: bool,
) -> Result<RepoEntry> {
    let abs = std::fs::canonicalize(path)?;
    let root = git::toplevel(&abs).await?;
    let root = std::fs::canonicalize(root)?;
    if root != abs {
        bail!(
            "{} is inside {}; add the repo root instead",
            abs.display(),
            root.display()
        );
    }
    let name = match name {
        Some(n) => n,
        None => root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "repo".into()),
    };
    if name.is_empty() || !name.chars().all(valid_name_char) {
        bail!("repo names may use letters, digits, '-', '_' and '.'");
    }
    let mut cfg = Config::load(paths)?;
    if cfg.repos.iter().any(|r| r.name == name) {
        bail!("a repo named {name:?} already exists; pick another name");
    }
    if cfg.repos.iter().any(|r| r.path == root) {
        bail!("{} is already added", root.display());
    }
    let entry = RepoEntry {
        name,
        path: root,
        network,
    };
    cfg.repos.push(entry.clone());
    cfg.save(paths)?;
    Ok(entry)
}

pub fn remove(paths: &Paths, name: &str) -> Result<()> {
    let mut cfg = Config::load(paths)?;
    let before = cfg.repos.len();
    cfg.repos.retain(|r| r.name != name);
    if cfg.repos.len() == before {
        bail!("no repo named {name:?}");
    }
    cfg.save(paths)
}

/// The most repos one change may add.
pub const MAX_BATCH: usize = 200;

/// Adds a repo the scan found, under `name` or its suggested name. Refuses a
/// path the scan didn't report, and one that has stopped being a repo.
async fn add_found(paths: &Paths, found: &[Found], path: &str, name: &str) -> Result<RepoEntry> {
    let Some(hit) = found
        .iter()
        .find(|f| !path.is_empty() && f.path.to_str() == Some(path))
    else {
        bail!(
            "{path:?} isn't a repo this machine found. Sling can only add repos the Runner found itself."
        );
    };
    let path = &hit.path;
    let still_there = scan::is_repo(path) && std::fs::canonicalize(path).is_ok_and(|p| &p == path);
    if !still_there {
        bail!("{} is no longer a git repo.", path.display());
    }
    let name = if name.is_empty() {
        let cfg = Config::load(paths)?;
        scan::suggest(found, &cfg)
            .into_iter()
            .find(|f| &f.path == path)
            .map(|f| f.name)
            .context("this repo is already added")?
    } else {
        name.to_string()
    };
    add(paths, path, Some(name), false).await
}

/// Applies a RepoChange from Sling and returns the message for the result.
/// `found` is the latest scan, and `busy` says whether a task is running in
/// a repo. Reads the config from disk, so turning `remote-repos` off takes
/// effect at once.
pub async fn change(
    paths: &Paths,
    req: &RepoChange,
    found: &[Found],
    busy: impl Fn(&str) -> bool,
) -> Result<String> {
    let cfg = Config::load(paths)?;
    if !cfg.remote_repos {
        bail!(REMOTE_OFF);
    }
    match req.op() {
        repo_change::Op::Add if !req.paths.is_empty() => {
            if req.paths.len() > MAX_BATCH {
                bail!("Sling can add at most {MAX_BATCH} repos at once.");
            }
            let mut added = Vec::new();
            let mut skipped = Vec::new();
            for path in &req.paths {
                // Each add reads the config again, so suggested names stay unique.
                match add_found(paths, found, path, "").await {
                    Ok(entry) => added.push(entry.name),
                    Err(e) => skipped.push(format!("{path}: {e:#}")),
                }
            }
            if added.is_empty() {
                bail!("Added none of them. {}", skipped.join(" "));
            }
            let mut message = if added.len() == 1 {
                format!("Added {}. Network access is off for it.", added[0])
            } else {
                format!(
                    "Added {} repos: {}. Network access is off for them.",
                    added.len(),
                    added.join(", ")
                )
            };
            if !skipped.is_empty() {
                message.push_str(&format!(
                    " Skipped {}: {}",
                    skipped.len(),
                    skipped.join(" ")
                ));
            }
            Ok(message)
        }
        repo_change::Op::Add => {
            let entry = add_found(paths, found, &req.path, &req.name).await?;
            Ok(format!(
                "Added {} ({}). Network access is off for it.",
                entry.name,
                entry.path.display()
            ))
        }
        repo_change::Op::Remove => {
            if cfg.repo(&req.name).is_none() {
                bail!("This machine has no repo named {:?}.", req.name);
            }
            if busy(&req.name) {
                bail!(
                    "A task is running in {}. Remove it once the task finishes.",
                    req.name
                );
            }
            remove(paths, &req.name)?;
            Ok(format!(
                "Removed {}. Its files stay on this machine.",
                req.name
            ))
        }
        repo_change::Op::Unspecified => bail!("Unknown repo change."),
    }
}
