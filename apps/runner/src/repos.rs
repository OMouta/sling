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
        repo_change::Op::Add => {
            let Some(hit) = found
                .iter()
                .find(|f| !req.path.is_empty() && f.path.to_str() == Some(req.path.as_str()))
            else {
                bail!(
                    "{:?} isn't a repo this machine found. Sling can only add repos the Runner found itself.",
                    req.path
                );
            };
            let path = &hit.path;
            let still_there =
                scan::is_repo(path) && std::fs::canonicalize(path).is_ok_and(|p| &p == path);
            if !still_there {
                bail!("{} is no longer a git repo.", path.display());
            }
            let name = if req.name.is_empty() {
                scan::suggest(found, &cfg)
                    .into_iter()
                    .find(|f| f.path == req.path)
                    .map(|f| f.name)
                    .context("this repo is already added")?
            } else {
                req.name.clone()
            };
            let entry = add(paths, path, Some(name), false).await?;
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
