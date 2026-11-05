//! What this machine offers: capabilities and repos, built fresh from the
//! local config and installed tools.

use sling_runner_protocol::{Capability, Inventory, Repo};

use crate::config::Config;
use crate::git;
use crate::harness;
use crate::sys::run;

pub const GIT: &str = "git";
pub const GITHUB_PR: &str = "git.pr.github";

pub async fn build(cfg: &Config) -> Inventory {
    let mut capabilities = Vec::new();

    let git_version = run("git", &["--version"], None)
        .await
        .ok()
        .filter(|o| o.ok());
    capabilities.push(Capability {
        name: GIT.into(),
        version: git_version
            .as_ref()
            .map(|o| {
                o.stdout
                    .trim()
                    .trim_start_matches("git version ")
                    .to_string()
            })
            .unwrap_or_default(),
        ready: git_version.is_some(),
        detail: if git_version.is_some() {
            String::new()
        } else {
            "git not found".into()
        },
        models: Vec::new(),
    });

    for agent in harness::all() {
        let d = agent.detect(&agent.bin(cfg)).await;
        capabilities.push(Capability {
            name: agent.capability().into(),
            version: d.version,
            ready: d.ready,
            detail: d.detail,
            models: d.models,
        });
    }

    let gh = run("gh", &["--version"], None)
        .await
        .ok()
        .filter(|o| o.ok());
    let gh_ready = gh.is_some() && git::gh_ready().await;
    capabilities.push(Capability {
        name: GITHUB_PR.into(),
        version: gh
            .as_ref()
            .and_then(|o| o.stdout.split_whitespace().nth(2).map(str::to_string))
            .unwrap_or_default(),
        ready: gh_ready,
        detail: match (gh.is_some(), gh_ready) {
            (false, _) => "gh not installed. PRs fall back to a compare link.".into(),
            (true, false) => "gh is not logged in. Run `gh auth login`.".into(),
            _ => String::new(),
        },
        models: Vec::new(),
    });

    let mut repos = Vec::new();
    for r in &cfg.repos {
        repos.push(Repo {
            name: r.name.clone(),
            default_branch: git::default_branch(&r.path).await,
            remote_url: git::remote_url(&r.path).await.unwrap_or_default(),
            network: r.network,
        });
    }

    Inventory {
        capabilities,
        repos,
        max_mode: cfg.max_mode.to_proto() as i32,
        max_concurrent_tasks: cfg.max_concurrent_tasks,
        labels: cfg.all_labels(),
        found_repos: Vec::new(),
        remote_repos: false,
    }
}

pub fn ready(inv: &Inventory, name: &str) -> bool {
    inv.capabilities.iter().any(|c| c.name == name && c.ready)
}

/// Names of the coding agents that are installed and logged in.
pub fn ready_harnesses(inv: &Inventory) -> Vec<String> {
    harness::all()
        .into_iter()
        .filter(|h| ready(inv, h.capability()))
        .map(|h| h.name().to_string())
        .collect()
}
