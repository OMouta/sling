//! Sling Runner. See plan/stage1.md, M2 to M4.

mod config;
mod connection;
mod git;
mod identity;
mod inventory;
mod pair;
mod repos;
mod spool;
mod sys;
mod tasks;

use std::path::PathBuf;

use anyhow::{Result, bail};
use clap::{Parser, Subcommand};

use crate::config::{Config, Mode, Paths};

#[derive(Parser)]
#[command(
    name = "sling-runner",
    version,
    about = "Runs Sling tasks on this machine"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Pair this machine with a Sling installation, using a code from the web UI.
    Pair {
        url: String,
        code: String,
        /// Name shown in Sling. Defaults to the hostname.
        #[arg(long)]
        name: Option<String>,
    },
    /// Manage the repos Sling may work in.
    Repo {
        #[command(subcommand)]
        command: RepoCommand,
    },
    /// Show or change local settings.
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    /// Connect and run tasks in the foreground.
    Run,
    /// Check that everything this Runner needs is in place.
    Doctor,
}

#[derive(Subcommand)]
enum RepoCommand {
    /// Allow Sling to work in a git repo.
    Add {
        path: PathBuf,
        #[arg(long)]
        name: Option<String>,
        /// Let Codex use the network in this repo (off by default).
        #[arg(long)]
        network: bool,
    },
    List,
    Remove {
        name: String,
    },
}

#[derive(Subcommand)]
enum ConfigCommand {
    Show,
    /// Keys: max-mode, max-concurrent-tasks, name, codex-bin, worktree-root.
    Set {
        key: String,
        value: String,
    },
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("SLING_RUNNER_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .with_target(false)
        .init();
    if let Err(e) = real_main().await {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

async fn real_main() -> Result<()> {
    let cli = Cli::parse();
    let paths = Paths::resolve()?;
    match cli.command {
        Command::Pair { url, code, name } => {
            let id = tokio::task::spawn_blocking({
                let paths = paths.clone();
                move || pair::pair(&paths, &url, &code, name)
            })
            .await??;
            println!("Paired as {id}.");
            println!("Start it with `sling-runner run`.");
        }
        Command::Repo { command } => match command {
            RepoCommand::Add {
                path,
                name,
                network,
            } => {
                let r = repos::add(&paths, &path, name, network).await?;
                println!("Added {} ({})", r.name, r.path.display());
                if r.network {
                    println!("Network access is on for this repo.");
                }
            }
            RepoCommand::List => {
                let cfg = Config::load(&paths)?;
                if cfg.repos.is_empty() {
                    println!("No repos yet. Add one with `sling-runner repo add <path>`.");
                }
                for r in cfg.repos {
                    let net = if r.network { "  network" } else { "" };
                    println!("{:<20} {}{net}", r.name, r.path.display());
                }
            }
            RepoCommand::Remove { name } => {
                repos::remove(&paths, &name)?;
                println!("Removed {name}");
            }
        },
        Command::Config { command } => match command {
            ConfigCommand::Show => {
                let cfg = Config::load(&paths)?;
                println!("config file:  {}", paths.config_file().display());
                println!("{}", toml::to_string_pretty(&cfg)?);
            }
            ConfigCommand::Set { key, value } => {
                let mut cfg = Config::load(&paths)?;
                match key.as_str() {
                    "max-mode" => cfg.max_mode = Mode::parse(&value)?,
                    "max-concurrent-tasks" => {
                        let n: u32 = value.parse()?;
                        if !(1..=16).contains(&n) {
                            bail!("max-concurrent-tasks must be between 1 and 16");
                        }
                        cfg.max_concurrent_tasks = n;
                    }
                    "name" => cfg.name = value,
                    "codex-bin" => cfg.codex_bin = Some(value),
                    "worktree-root" => cfg.worktree_root = Some(PathBuf::from(value)),
                    _ => bail!("unknown key {key:?}"),
                }
                cfg.save(&paths)?;
                println!("Saved. A running Runner picks this up within a minute.");
            }
        },
        Command::Run => {
            let cfg = Config::load(&paths)?;
            if cfg.runner_id.is_none() {
                bail!("not paired yet. Run `sling-runner pair <url> <code>` first.");
            }
            let identity = identity::Identity::load(&paths)?;
            let mgr = tasks::Manager::new(paths, cfg)?;
            tokio::select! {
                r = connection::run_forever(mgr, identity) => r?,
                _ = tokio::signal::ctrl_c() => tracing::info!("stopping"),
            }
        }
        Command::Doctor => doctor(&paths).await?,
    }
    Ok(())
}

async fn doctor(paths: &Paths) -> Result<()> {
    let cfg = Config::load(paths)?;
    let mark = |ok: bool| if ok { "ok  " } else { "FAIL" };
    println!("config     {}", paths.config_file().display());
    println!(
        "{} paired    {}",
        mark(cfg.runner_id.is_some()),
        cfg.server_url.as_deref().unwrap_or("not paired")
    );
    println!(
        "{} key       {}",
        mark(paths.key_file().exists()),
        paths.key_file().display()
    );
    let inv = inventory::build(&cfg).await;
    for c in &inv.capabilities {
        println!("{} {:<9} {} {}", mark(c.ready), c.name, c.version, c.detail);
    }
    for r in &inv.repos {
        println!(
            "ok   repo      {} (default branch {})",
            r.name, r.default_branch
        );
    }
    println!("     max mode  {}", cfg.max_mode.as_str());
    Ok(())
}
