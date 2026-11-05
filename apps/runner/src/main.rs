//! Sling Runner: pairs with a control plane and runs delegated tasks on this machine.

mod config;
mod connection;
mod gc;
mod git;
mod identity;
mod inventory;
mod pair;
mod redact;
mod repos;
mod service;
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
    /// Run the Runner in the background as your user (launchd, systemd, or a logon task).
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
    /// Remove worktrees of finished tasks older than 7 days.
    Gc,
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
enum ServiceCommand {
    Install,
    Uninstall,
    Status,
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
    init_logging();
    if let Err(e) = real_main().await {
        tracing::error!("{e:#}");
        eprintln!("error: {e:#}");
        if e.downcast_ref::<connection::Refused>().is_some() {
            // launchd only skips the restart on a clean exit; systemd skips 78.
            let code =
                if cfg!(target_os = "macos") && std::env::var_os(service::SERVICE_ENV).is_some() {
                    0
                } else {
                    service::EXIT_REVOKED
                };
            std::process::exit(code);
        }
        std::process::exit(1);
    }
}

/// Logs go to stderr, or to `runner.log` (rotated at 10 MB) when running as a
/// service.
fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("SLING_RUNNER_LOG")
        .unwrap_or_else(|_| "info".into());
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false);
    if std::env::var_os(service::SERVICE_ENV).is_some()
        && let Ok(paths) = Paths::resolve()
    {
        let file = paths.log_file();
        let _ = std::fs::create_dir_all(&paths.data_dir);
        if std::fs::metadata(&file)
            .map(|m| m.len() > 10 * 1024 * 1024)
            .unwrap_or(false)
        {
            let _ = std::fs::rename(&file, file.with_extension("log.1"));
        }
        if let Ok(f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
        {
            builder
                .with_ansi(false)
                .with_writer(std::sync::Mutex::new(f))
                .init();
            return;
        }
    }
    builder.init();
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
            let mgr = tasks::Manager::new(paths.clone(), cfg)?;
            let gc_mgr = mgr.clone();
            tokio::spawn(async move {
                loop {
                    match gc::collect(&gc_mgr.config(), &gc_mgr.paths, gc::KEEP_FOR).await {
                        Ok(n) if n > 0 => tracing::info!("removed {n} old worktrees"),
                        Ok(_) => {}
                        Err(e) => tracing::warn!("worktree cleanup failed: {e:#}"),
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
                }
            });
            tokio::select! {
                r = connection::run_forever(mgr, identity) => r?,
                _ = tokio::signal::ctrl_c() => tracing::info!("stopping"),
            }
        }
        Command::Doctor => doctor(&paths).await?,
        Command::Service { command } => {
            let msg = match command {
                ServiceCommand::Install => {
                    if Config::load(&paths)?.runner_id.is_none() {
                        bail!("pair this machine first: sling-runner pair <url> <code>");
                    }
                    service::install(&paths).await?
                }
                ServiceCommand::Uninstall => service::uninstall().await?,
                ServiceCommand::Status => service::status().await?,
            };
            println!("{msg}");
        }
        Command::Gc => {
            let cfg = Config::load(&paths)?;
            let n = gc::collect(&cfg, &paths, gc::KEEP_FOR).await?;
            println!("Removed {n} worktrees.");
        }
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
