//! What this machine offers: capabilities and repos, built fresh from the
//! local config and installed tools, plus the repos the latest scan found.

use sling_runner_protocol::{Capability, Inventory, Repo};

use crate::config::Config;
use crate::exec::{self, Sandbox};
use crate::git;
use crate::harness;
use crate::scan::{self, Found};
use crate::sys::run;

pub const GIT: &str = "git";
pub const GITHUB_PR: &str = "git.pr.github";
/// Sent so Sling knows it can run chat turns here.
pub const CHAT: &str = "chat";

/// `found` is the latest repo scan. It's only offered while `remote-repos`
/// is on. `sandbox` is what the assistant's commands can run in.
pub async fn build(cfg: &Config, found: &[Found], sandbox: &Sandbox) -> Inventory {
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

    let gh_bin = cfg.gh_bin();
    let gh = run(&gh_bin, &["--version"], None)
        .await
        .ok()
        .filter(|o| o.ok());
    let gh_ready = gh.is_some() && git::gh_ready(&gh_bin).await;
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

    // This Runner can run assistant turns on its coding agents' CLIs.
    capabilities.push(Capability {
        name: CHAT.into(),
        version: env!("CARGO_PKG_VERSION").into(),
        ready: true,
        detail: String::new(),
        models: Vec::new(),
    });
    capabilities.extend(exec::capabilities(cfg, sandbox));

    let mut repos = Vec::new();
    for r in &cfg.repos {
        repos.push(Repo {
            name: r.name.clone(),
            default_branch: git::default_branch(&r.path).await,
            remote_url: git::remote_url(&r.path).await.unwrap_or_default(),
            network: r.network,
            // Redacted, in case the command carries a token inline.
            deploy_command: r
                .deploy_command
                .as_deref()
                .map(crate::redact::redact)
                .unwrap_or_default(),
            deploy_timeout_seconds: if r.deploy_command.is_some() {
                r.deploy_timeout_secs()
            } else {
                0
            },
        });
    }

    Inventory {
        capabilities,
        repos,
        max_mode: cfg.max_mode.to_proto() as i32,
        max_concurrent_tasks: cfg.max_concurrent_tasks,
        labels: cfg.all_labels(),
        found_repos: if cfg.remote_repos {
            scan::suggest(found, cfg)
        } else {
            Vec::new()
        },
        remote_repos: cfg.remote_repos,
        // Read-only machines refuse merges and deploys too.
        deploys: cfg.deploys && cfg.max_mode.writes(),
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
