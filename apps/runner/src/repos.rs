//! `sling-runner repo add|list|remove`. The only way repos reach Sling.

use std::path::Path;

use anyhow::{Result, bail};

use crate::config::{Config, Paths, RepoEntry};
use crate::git;

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
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        bail!("repo names may use letters, digits, '-', '_' and '.'");
    }
    let mut cfg = Config::load(paths)?;
    if cfg.repos.iter().any(|r| r.name == name) {
        bail!("a repo named {name:?} already exists; pick another with --name");
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
