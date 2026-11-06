//! Sling Runner: pairs with a control plane and runs delegated tasks on this machine.

mod agent_env;
mod chat;
mod config;
mod connection;
mod exec;
mod gc;
mod git;
mod harness;
mod identity;
mod inventory;
mod mcp;
mod pair;
mod redact;
mod repos;
mod sandbox;
mod scan;
mod service;
mod spool;
mod sys;
mod tasks;
#[cfg(test)]
mod test_http;

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
    /// Manage the repos Sling may work in. You can also choose them under
    /// Machines in Sling, from the repos this machine found.
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
    /// Entrypoint of a sandbox image: clone the repos, pair with a one-time
    /// code, and run one task. Reads its settings from SLING_* environment
    /// variables. Execution providers start it; you don't run it yourself.
    Sandbox,
    /// Git credential helper used inside a sandbox.
    #[command(hide = true)]
    GitCredential { action: String },
    /// MCP server that gives a chat turn's agent Sling's tools, over stdio.
    /// The agent's CLI starts it with SLING_TOOLS_URL and SLING_TOOLS_TOKEN
    /// set; you don't run it yourself.
    #[command(hide = true)]
    Mcp,
}

#[derive(Subcommand)]
enum RepoCommand {
    /// Allow Sling to work in a git repo.
    Add {
        path: PathBuf,
        #[arg(long)]
        name: Option<String>,
        /// Let coding agents use the network in this repo (off by default).
        #[arg(long)]
        network: bool,
    },
    List,
    Remove {
        name: String,
    },
    /// Keys: deploy-command (what a deploy of this repo runs here, through your
    /// login shell), deploy-timeout (seconds, 900 by default).
    Set {
        name: String,
        key: String,
        value: String,
    },
    /// Keys: deploy-command, deploy-timeout.
    Unset {
        name: String,
        key: String,
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
    /// Keys: max-mode, max-concurrent-tasks, name, labels, codex-bin, claude-bin, gh-bin,
    /// worktree-root, remote-repos (on or off), commands (on or off), deploys (on or off),
    /// scan-roots (comma-separated directories; "" means your home), server-url (Sling's new
    /// address, keeping the pairing).
    Set {
        key: String,
        value: String,
    },
}

fn main() {
    let cli = Cli::parse();
    // git reads the helper's stdout, so nothing else may print there.
    if let Command::GitCredential { action } = &cli.command {
        std::process::exit(sandbox::git_credential(action));
    }
    // The MCP client reads stdout, so this runs before logging is set up.
    if let Command::Mcp = &cli.command {
        std::process::exit(mcp::main());
    }
    init_logging();
    let prepared = match cli.command {
        Command::Sandbox => match sandbox::prepare() {
            Ok(p) => Some(p),
            Err(code) => std::process::exit(code),
        },
        _ => None,
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("starting the async runtime");
    if let Some(prepared) = prepared {
        std::process::exit(runtime.block_on(sandbox::run(prepared)));
    }
    if let Err(e) = runtime.block_on(real_main(cli)) {
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

/// Logs go to stdout, or to `runner.log` (rotated at 10 MB) when running as a
/// service. Colors only when stdout is a terminal.
fn init_logging() {
    use std::io::IsTerminal;
    let filter = tracing_subscriber::EnvFilter::try_from_env("SLING_RUNNER_LOG")
        .unwrap_or_else(|_| "info".into());
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_ansi(std::io::stdout().is_terminal());
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

async fn real_main(cli: Cli) -> Result<()> {
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
                    println!(
                        "No repos yet. Choose some under Machines in Sling, or add one with `sling-runner repo add <path>`."
                    );
                }
                for r in cfg.repos {
                    let net = if r.network { "  network" } else { "" };
                    println!("{:<20} {}{net}", r.name, r.path.display());
                    if let Some(cmd) = &r.deploy_command {
                        println!(
                            "{:<20} deploy: {cmd} (stops after {}s)",
                            "",
                            r.deploy_timeout_secs()
                        );
                    }
                }
            }
            RepoCommand::Remove { name } => {
                repos::remove(&paths, &name)?;
                println!("Removed {name}");
            }
            RepoCommand::Set { name, key, value } => {
                println!("{}", repos::set(&paths, &name, &key, &value)?);
                println!("A running Runner picks this up within a minute.");
            }
            RepoCommand::Unset { name, key } => {
                println!("{}", repos::unset(&paths, &name, &key)?);
                println!("A running Runner picks this up within a minute.");
            }
        },
        Command::Config { command } => match command {
            ConfigCommand::Show => {
                let cfg = Config::load(&paths)?;
                println!("config file:  {}", paths.config_file().display());
                println!("labels sent:  {}", cfg.all_labels().join(", "));
                println!("remote repos: {}", remote_repos_summary(&cfg));
                println!("deploys:      {}", deploys_summary(&cfg));
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
                    "labels" => cfg.labels = config::parse_labels(&value)?,
                    "codex-bin" => cfg.codex_bin = Some(value),
                    "claude-bin" => cfg.claude_bin = Some(value),
                    "gh-bin" => cfg.gh_bin = Some(value),
                    "worktree-root" => cfg.worktree_root = Some(PathBuf::from(value)),
                    "remote-repos" => cfg.remote_repos = config::parse_on_off(&value)?,
                    "commands" => cfg.commands = config::parse_on_off(&value)?,
                    "deploys" => cfg.deploys = config::parse_on_off(&value)?,
                    "scan-roots" => cfg.scan_roots = config::parse_scan_roots(&value)?,
                    // Only from this machine: the control plane can't move a Runner elsewhere.
                    "server-url" => {
                        if cfg.runner_id.is_none() {
                            bail!("not paired yet. Run `sling-runner pair <url> <code>` instead.");
                        }
                        cfg.server_url = Some(config::parse_server_url(&value)?);
                        cfg.save(&paths)?;
                        println!(
                            "Saved. Restart the Runner to connect there. It keeps its pairing, so the server must be the same Sling, now at a new address."
                        );
                        return Ok(());
                    }
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
        Command::Sandbox | Command::GitCredential { .. } | Command::Mcp => {
            unreachable!("handled in main")
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
    println!("     {:<18} {}", "config", paths.config_file().display());
    println!(
        "{} {:<18} {}",
        mark(cfg.runner_id.is_some()),
        "paired",
        cfg.server_url.as_deref().unwrap_or("not paired")
    );
    println!(
        "{} {:<18} {}",
        mark(paths.key_file().exists()),
        "key",
        paths.key_file().display()
    );
    let found = if cfg.remote_repos {
        scan::scan(&cfg, paths).await
    } else {
        Vec::new()
    };
    let inv = inventory::build(&cfg, &found, &exec::detect_sandbox().await).await;
    for c in &inv.capabilities {
        println!(
            "{} {:<18} {} {}",
            mark(c.ready),
            c.name,
            c.version,
            c.detail
        );
    }
    for r in &inv.repos {
        let identity = git::remote_key(&r.remote_url)
            .map(|k| format!("matches {k} on other machines"))
            .unwrap_or_else(|| "no remote, so it matches by name on this machine only".into());
        println!(
            "ok   {:<18} {} (default branch {}; {identity})",
            "repo", r.name, r.default_branch
        );
    }
    println!("     {:<18} {}", "max mode", cfg.max_mode.as_str());
    println!("     {:<18} {}", "labels", inv.labels.join(", "));
    let found = if cfg.remote_repos {
        format!(" ({} not added yet)", inv.found_repos.len())
    } else {
        String::new()
    };
    println!(
        "     {:<18} {}{found}",
        "remote repos",
        remote_repos_summary(&cfg)
    );
    println!("     {:<18} {}", "deploys", deploys_summary(&cfg));
    Ok(())
}

fn deploys_summary(cfg: &Config) -> String {
    if !cfg.deploys {
        return "off: this machine refuses every merge and deploy".into();
    }
    if !cfg.max_mode.writes() {
        return "off: max-mode is read-only".into();
    }
    let with: Vec<&str> = cfg
        .repos
        .iter()
        .filter(|r| r.deploy_command.is_some())
        .map(|r| r.name.as_str())
        .collect();
    if with.is_empty() {
        "on: Sling may merge here. No repo has a deploy command.".into()
    } else {
        format!("on: Sling may merge here, and deploy {}", with.join(", "))
    }
}

fn remote_repos_summary(cfg: &Config) -> String {
    if !cfg.remote_repos {
        return "off: only `sling-runner repo add` adds repos".into();
    }
    let roots: Vec<String> = cfg
        .scan_roots()
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    format!("on: Sling may add repos found under {}", roots.join(", "))
}
