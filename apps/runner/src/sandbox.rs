//! `sling-runner sandbox`: the entrypoint of a sandbox image. An execution
//! provider starts it for one task, with its settings in environment
//! variables. It clones the repos, logs the agents in, pairs itself with a
//! one-time code, and then runs like any other Runner until the control plane
//! revokes it or it has had nothing to do for too long.
//!
//! The git token is used only by the Runner's own `git` and `gh` commands,
//! through a credential helper that reads it from the environment. It never
//! goes into `.git/config`, a remote URL, the log, or the spool, and agents
//! are started without it.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::config::{Config, Mode, Paths, RepoEntry};
use crate::harness::{self, Harness};
use crate::{connection, git, identity, pair, sys, tasks};

pub const URL: &str = "SLING_URL";
pub const PAIR_CODE: &str = "SLING_PAIR_CODE";
pub const SANDBOX_ID: &str = "SLING_SANDBOX_ID";
pub const REPOS: &str = "SLING_REPOS";
pub const HARNESSES: &str = "SLING_HARNESSES";
pub const MAX_MODE: &str = "SLING_MAX_MODE";
pub const IDLE_EXIT_SECONDS: &str = "SLING_IDLE_EXIT_SECONDS";
pub const OPENAI_API_KEY: &str = "OPENAI_API_KEY";
pub const ANTHROPIC_API_KEY: &str = "ANTHROPIC_API_KEY";
pub const GIT_TOKEN: &str = "SLING_GIT_TOKEN";
/// Test hooks: agent binaries to use instead of `codex` and `claude` on PATH.
pub const CODEX_BIN: &str = "SLING_CODEX_BIN";
pub const CLAUDE_BIN: &str = "SLING_CLAUDE_BIN";
pub const RUNNER_HOME: &str = "SLING_RUNNER_HOME";

/// Idle, revoked, or stopped by a signal.
pub const EXIT_OK: i32 = 0;
pub const EXIT_OTHER: i32 = 1;
/// A variable is missing or invalid.
pub const EXIT_BAD_ENV: i32 = 2;
/// A repo couldn't be cloned.
pub const EXIT_CLONE: i32 = 3;
/// Pairing with the control plane failed.
pub const EXIT_PAIR: i32 = 4;

const DEFAULT_IDLE_EXIT: Duration = Duration::from_secs(900);
const CLONE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How long running agents get to stop when the sandbox shuts down.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SandboxRepo {
    pub name: String,
    pub clone_url: String,
    #[serde(default)]
    pub default_branch: String,
    #[serde(default)]
    pub network: bool,
}

/// Everything the sandbox reads from its environment.
#[derive(Debug)]
pub struct Settings {
    pub url: String,
    pub pair_code: String,
    pub sandbox_id: String,
    pub repos: Vec<SandboxRepo>,
    pub harnesses: Vec<&'static dyn Harness>,
    pub max_mode: Mode,
    /// `None` never exits for being idle.
    pub idle_exit: Option<Duration>,
    pub openai_api_key: Option<String>,
    pub anthropic_api_key: Option<String>,
    pub git_token: Option<String>,
    pub codex_bin: Option<String>,
    pub claude_bin: Option<String>,
    pub home: Option<PathBuf>,
}

impl Settings {
    /// Reads the settings. `get` returns a variable's value; empty values
    /// count as unset.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Settings> {
        let var = |name: &str| get(name).filter(|v| !v.trim().is_empty());
        let required = |name: &str| var(name).with_context(|| format!("{name} is not set"));

        let url = required(URL)?.trim().trim_end_matches('/').to_string();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            bail!("{URL} must start with http:// or https://");
        }
        let pair_code = required(PAIR_CODE)?.trim().to_string();
        let sandbox_id = required(SANDBOX_ID)?.trim().to_string();
        if !sandbox_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            bail!("{SANDBOX_ID} may use letters, digits, '-' and '_'");
        }
        let repos = parse_repos(&required(REPOS)?)?;

        let harnesses = match var(HARNESSES) {
            None => harness::all().to_vec(),
            Some(list) => {
                let mut out: Vec<&'static dyn Harness> = Vec::new();
                for name in list.split(',').map(str::trim).filter(|n| !n.is_empty()) {
                    match harness::find(name) {
                        Some(h) if !out.iter().any(|o| o.name() == h.name()) => out.push(h),
                        Some(_) => {}
                        None => tracing::warn!("{HARNESSES}: skipping unknown agent {name:?}"),
                    }
                }
                out
            }
        };
        let max_mode = match var(MAX_MODE) {
            Some(m) => Mode::parse(m.trim()).with_context(|| format!("{MAX_MODE} is invalid"))?,
            None => Mode::FullAccess,
        };
        let idle_exit = match var(IDLE_EXIT_SECONDS) {
            None => Some(DEFAULT_IDLE_EXIT),
            Some(v) => {
                let secs: u64 = v
                    .trim()
                    .parse()
                    .with_context(|| format!("{IDLE_EXIT_SECONDS} must be a number of seconds"))?;
                (secs > 0).then(|| Duration::from_secs(secs))
            }
        };
        Ok(Settings {
            url,
            pair_code,
            sandbox_id,
            repos,
            harnesses,
            max_mode,
            idle_exit,
            openai_api_key: var(OPENAI_API_KEY),
            anthropic_api_key: var(ANTHROPIC_API_KEY),
            git_token: var(GIT_TOKEN),
            codex_bin: var(CODEX_BIN),
            claude_bin: var(CLAUDE_BIN),
            home: var(RUNNER_HOME).map(PathBuf::from),
        })
    }

    fn wants(&self, name: &str) -> bool {
        self.harnesses.iter().any(|h| h.name() == name)
    }
}

/// Parses and checks `SLING_REPOS`.
pub fn parse_repos(json: &str) -> Result<Vec<SandboxRepo>> {
    let repos: Vec<SandboxRepo> =
        serde_json::from_str(json).with_context(|| format!("{REPOS} is not valid JSON"))?;
    if repos.is_empty() {
        bail!("{REPOS} lists no repos");
    }
    for (i, r) in repos.iter().enumerate() {
        if r.name.is_empty()
            || r.name.starts_with('.')
            || !r
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        {
            bail!(
                "{REPOS}: repo name {:?} may use letters, digits, '-', '_' and '.', and can't start with '.'",
                r.name
            );
        }
        if repos[..i].iter().any(|o| o.name == r.name) {
            bail!("{REPOS}: repo {:?} is listed twice", r.name);
        }
        check_clone_url(&r.clone_url).with_context(|| format!("{REPOS}: repo {:?}", r.name))?;
        if r.default_branch.starts_with('-')
            || !r
                .default_branch
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
        {
            bail!(
                "{REPOS}: repo {:?} has an invalid default branch {:?}",
                r.name,
                r.default_branch
            );
        }
    }
    Ok(repos)
}

/// HTTPS, HTTP, SSH, git, `file://`, and absolute paths. Clone URLs never
/// carry credentials: the token comes from `SLING_GIT_TOKEN`.
fn check_clone_url(url: &str) -> Result<()> {
    if url.starts_with('-') {
        bail!("invalid clone URL {url:?}");
    }
    if let Some((scheme, rest)) = url.split_once("://") {
        match scheme {
            "https" | "http" => {
                let authority = rest.split('/').next().unwrap_or_default();
                if authority.contains('@') {
                    bail!("clone URLs must not carry credentials; use {GIT_TOKEN}");
                }
                if authority.is_empty() {
                    bail!("invalid clone URL {url:?}");
                }
            }
            "ssh" | "git" | "file" => {}
            _ => bail!("unsupported clone URL scheme {scheme:?}"),
        }
        return Ok(());
    }
    if Path::new(url).is_absolute() || git::remote_key(url).is_some() {
        return Ok(());
    }
    bail!("unsupported clone URL {url:?}")
}

/// `host` or `host:port` of an HTTPS clone URL, lowercased.
fn https_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split('/').next()?;
    (!authority.is_empty() && !authority.contains('@')).then(|| authority.to_lowercase())
}

/// Hosts the credential helper answers for: those of the HTTPS clone URLs.
pub fn credential_hosts(repos: &[SandboxRepo]) -> Vec<String> {
    let mut hosts: Vec<String> = repos
        .iter()
        .filter_map(|r| https_host(&r.clone_url))
        .collect();
    hosts.sort();
    hosts.dedup();
    hosts
}

/// What the credential helper prints for one request from git. It answers
/// `get` for HTTPS requests to one of `hosts`, and nothing else.
pub fn credential_reply(
    action: &str,
    input: &str,
    token: Option<&str>,
    hosts: &[String],
) -> String {
    let Some(token) = token.filter(|t| !t.is_empty()) else {
        return String::new();
    };
    if action != "get" {
        return String::new();
    }
    let field = |name: &str| {
        input.lines().find_map(|l| {
            l.split_once('=')
                .filter(|(k, _)| *k == name)
                .map(|(_, v)| v.trim().to_lowercase())
        })
    };
    let https = field("protocol").as_deref() == Some("https");
    let known_host = field("host").is_some_and(|h| hosts.contains(&h));
    if !(https && known_host) {
        return String::new();
    }
    format!("username=x-access-token\npassword={token}\n")
}

/// `sling-runner git-credential <action>`: the credential helper git calls in
/// a sandbox. Reads the request on stdin and prints the reply on stdout.
pub fn git_credential(action: &str) -> i32 {
    use std::io::{Read, Write};
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return 1;
    }
    let hosts = std::env::var(REPOS)
        .ok()
        .and_then(|j| serde_json::from_str::<Vec<SandboxRepo>>(&j).ok())
        .map(|r| credential_hosts(&r))
        .unwrap_or_default();
    let token = std::env::var(GIT_TOKEN).ok();
    let reply = credential_reply(action, &input, token.as_deref(), &hosts);
    let mut out = std::io::stdout().lock();
    if out
        .write_all(reply.as_bytes())
        .and_then(|_| out.flush())
        .is_err()
    {
        return 1;
    }
    0
}

/// Quotes a value for the POSIX shell that git runs credential helpers with.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Environment for the Runner's own `git` and `gh` commands.
fn tool_env(settings: &Settings, exe: &Path) -> Vec<(String, String, String)> {
    let mut env = vec![("git".into(), "GIT_TERMINAL_PROMPT".into(), "0".into())];
    if let Some(token) = &settings.git_token {
        // An empty helper first clears any helper configured elsewhere. The
        // `!` form makes git run it with the shell, so a quoted path works.
        let helper = format!(
            "!{} git-credential",
            shell_quote(&exe.display().to_string())
        );
        for (k, v) in [
            ("GIT_CONFIG_COUNT", "2"),
            ("GIT_CONFIG_KEY_0", "credential.helper"),
            ("GIT_CONFIG_VALUE_0", ""),
            ("GIT_CONFIG_KEY_1", "credential.helper"),
            ("GIT_CONFIG_VALUE_1", helper.as_str()),
        ] {
            env.push(("git".into(), k.into(), v.into()));
        }
        env.push(("gh".into(), "GH_TOKEN".into(), token.clone()));
        env.push(("gh".into(), "GH_PROMPT_DISABLED".into(), "1".into()));
    }
    env
}

/// What `prepare` sets up before the async runtime starts.
pub struct Prepared {
    settings: Settings,
    paths: Paths,
    /// Directories the sandbox created, removed on exit.
    cleanup: Vec<PathBuf>,
}

/// Reads the settings and picks the Runner's home. Runs before the async
/// runtime starts, while the process is single-threaded, because it may set
/// `CODEX_HOME` for every Codex command this process starts.
pub fn prepare() -> Result<Prepared, i32> {
    let settings = match Settings::from_env(|name| std::env::var(name).ok()) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("sandbox can't start: {e:#}");
            return Err(EXIT_BAD_ENV);
        }
    };
    let (home, temp_home) = match &settings.home {
        Some(h) => (h.clone(), None),
        None => {
            let mut suffix = [0u8; 4];
            let _ = getrandom::fill(&mut suffix);
            let hex: String = suffix.iter().map(|b| format!("{b:02x}")).collect();
            let dir =
                std::env::temp_dir().join(format!("sling-sandbox-{}-{hex}", settings.sandbox_id));
            (dir.clone(), Some(dir))
        }
    };
    if let Err(e) = std::fs::create_dir_all(&home) {
        tracing::error!("sandbox can't start: creating {}: {e}", home.display());
        return Err(EXIT_OTHER);
    }
    let mut cleanup: Vec<PathBuf> = temp_home.into_iter().collect();
    if settings.wants("codex") && settings.openai_api_key.is_some() {
        // Codex is logged in with the key in a home of its own, so an
        // existing Codex login on this machine is left alone. Codex won't set
        // up its helper commands under the temp directory, so it goes in HOME.
        let own = std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .map(|h| PathBuf::from(h).join(format!(".sling-sandbox-{}", settings.sandbox_id)));
        let mut codex_home = home.join("codex");
        if let Some(dir) = own
            && seed_codex_home(&dir.join("codex")).is_ok()
        {
            codex_home = dir.join("codex");
            cleanup.push(dir);
        } else if let Err(e) = seed_codex_home(&codex_home) {
            tracing::error!("sandbox can't start: {e:#}");
            return Err(EXIT_OTHER);
        }
        // SAFETY: called from `main` before any other thread exists.
        unsafe { std::env::set_var("CODEX_HOME", &codex_home) };
    }
    let paths = Paths {
        config_dir: home.clone(),
        data_dir: home.join("data"),
    };
    Ok(Prepared {
        settings,
        paths,
        cleanup,
    })
}

/// Creates a Codex home, keeping the image's Codex `config.toml` if it has one.
fn seed_codex_home(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let existing = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")));
    if let Some(src) = existing.map(|d| d.join("config.toml"))
        && src.is_file()
    {
        std::fs::copy(&src, dir.join("config.toml"))
            .with_context(|| format!("copying {}", src.display()))?;
    }
    Ok(())
}

/// Boots the sandbox and runs until it's revoked, idle, or stopped. Returns
/// the exit code.
pub async fn run(prepared: Prepared) -> i32 {
    let Prepared {
        settings,
        paths,
        cleanup,
    } = prepared;
    let code = match boot(&settings, &paths).await {
        Ok((cfg, env_removed)) => serve(&settings, paths, cfg, env_removed).await,
        Err((code, e)) => {
            tracing::error!("sandbox can't start: {e:#}");
            code
        }
    };
    for dir in cleanup {
        let _ = std::fs::remove_dir_all(dir);
    }
    code
}

type BootError = (i32, anyhow::Error);

async fn boot(
    settings: &Settings,
    paths: &Paths,
) -> Result<(Config, Vec<(&'static str, &'static str)>), BootError> {
    let started = Instant::now();
    tracing::info!(
        "sandbox {} starting, home {}",
        settings.sandbox_id,
        paths.config_dir.display()
    );
    let exe = std::env::current_exe().map_err(|e| (EXIT_OTHER, e.into()))?;
    sys::set_tool_env(tool_env(settings, &exe));
    if settings.git_token.is_some() {
        let hosts = credential_hosts(&settings.repos);
        if hosts.is_empty() {
            tracing::info!("no HTTPS repos, so git doesn't use {GIT_TOKEN}");
        } else {
            tracing::info!("git uses {GIT_TOKEN} for HTTPS to {}", hosts.join(", "));
        }
    }

    let workspace = workspace_root(&paths.config_dir);
    tracing::info!(
        "cloning {} repo(s) into {}",
        settings.repos.len(),
        workspace.display()
    );
    let clone_started = Instant::now();
    let clones = settings
        .repos
        .iter()
        .map(|r| clone_repo(r, workspace.join(&r.name)));
    let mut repos = Vec::new();
    for result in futures_util::future::join_all(clones).await {
        repos.push(result.map_err(|e| (EXIT_CLONE, e))?);
    }
    tracing::info!("cloned in {:.1}s", clone_started.elapsed().as_secs_f64());

    let cfg = Config {
        name: format!("sandbox-{}", settings.sandbox_id),
        max_mode: settings.max_mode,
        max_concurrent_tasks: 1,
        codex_bin: settings.codex_bin.clone(),
        claude_bin: settings.claude_bin.clone(),
        disposable: true,
        // A sandbox works only in the repos it was given.
        remote_repos: false,
        // Sling merges a sandbox's PR itself, after the sandbox is gone, and
        // a sandbox has no deploy commands.
        deploys: false,
        repos,
        ..Config::default()
    };
    cfg.save(paths).map_err(|e| (EXIT_OTHER, e))?;

    let env_removed = set_up_agents(settings, &cfg).await;

    let pair_started = Instant::now();
    let runner_id = tokio::task::spawn_blocking({
        let paths = paths.clone();
        let url = settings.url.clone();
        let code = settings.pair_code.clone();
        let name = cfg.name.clone();
        move || pair::pair(&paths, &url, &code, Some(name))
    })
    .await
    .map_err(|e| (EXIT_OTHER, e.into()))?
    .map_err(|e| (EXIT_PAIR, e))?;
    tracing::info!(
        "paired as {runner_id} in {:.1}s; booted in {:.1}s",
        pair_started.elapsed().as_secs_f64(),
        started.elapsed().as_secs_f64()
    );
    let cfg = Config::load(paths).map_err(|e| (EXIT_OTHER, e))?;
    Ok((cfg, env_removed))
}

/// `/workspace` when it's writable, otherwise a directory in the Runner's home.
fn workspace_root(home: &Path) -> PathBuf {
    let preferred = Path::new("/workspace");
    let probe = preferred.join(format!(".sling-write-test-{}", std::process::id()));
    if preferred.is_dir() && std::fs::write(&probe, b"").is_ok() {
        let _ = std::fs::remove_file(&probe);
        return preferred.to_path_buf();
    }
    home.join("workspace")
}

async fn clone_repo(r: &SandboxRepo, dest: PathBuf) -> Result<RepoEntry> {
    if dest.exists() {
        bail!("{} already exists", dest.display());
    }
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let dest_str = dest.display().to_string();
    let mut args = vec!["clone", "--quiet", "--single-branch"];
    if !r.default_branch.is_empty() {
        args.extend(["--branch", r.default_branch.as_str()]);
    }
    if r.clone_url.starts_with("https://") || r.clone_url.starts_with("http://") {
        // Every commit and tree of the default branch, and file contents only
        // when they're needed.
        args.push("--filter=blob:none");
    }
    args.extend(["--", r.clone_url.as_str(), dest_str.as_str()]);
    let started = Instant::now();
    let out = sys::run_timeout("git", &args, None, CLONE_TIMEOUT).await?;
    if !out.ok() {
        bail!(
            "cloning {} from {} failed: {}",
            r.name,
            r.clone_url,
            crate::redact::redact(out.stderr.trim())
        );
    }
    if !r.default_branch.is_empty() {
        let _ = sys::run(
            "git",
            &["remote", "set-head", "origin", &r.default_branch],
            Some(&dest),
        )
        .await;
    }
    tracing::info!(
        "cloned {} ({}) in {:.1}s{}",
        r.name,
        git::remote_key(&r.clone_url).unwrap_or_else(|| r.clone_url.clone()),
        started.elapsed().as_secs_f64(),
        if r.network { ", network allowed" } else { "" }
    );
    Ok(RepoEntry {
        name: r.name.clone(),
        path: std::fs::canonicalize(&dest)?,
        network: r.network,
        ..RepoEntry::default()
    })
}

/// Logs in each requested agent with its API key and reports what's ready.
/// Returns variables to keep out of each agent's environment: each agent
/// sees only its own key, and Codex not even that once it's logged in.
async fn set_up_agents(settings: &Settings, cfg: &Config) -> Vec<(&'static str, &'static str)> {
    let mut removed = vec![
        ("codex", ANTHROPIC_API_KEY),
        ("claude-code", OPENAI_API_KEY),
    ];
    for agent in &settings.harnesses {
        let bin = agent.bin(cfg);
        match agent.name() {
            "codex" => match &settings.openai_api_key {
                Some(key) => match codex_login(&bin, key).await {
                    Ok(()) => {
                        tracing::info!("Codex: logged in with {OPENAI_API_KEY}");
                        removed.push(("codex", OPENAI_API_KEY));
                    }
                    Err(e) => {
                        tracing::warn!("Codex: could not log in with {OPENAI_API_KEY}: {e:#}")
                    }
                },
                None => {
                    tracing::info!("Codex: no {OPENAI_API_KEY}, so it needs a login from the image")
                }
            },
            "claude-code" => {
                if settings.anthropic_api_key.is_some() {
                    tracing::info!("Claude Code: uses {ANTHROPIC_API_KEY}");
                } else {
                    tracing::info!(
                        "Claude Code: no {ANTHROPIC_API_KEY}, so it needs a login from the image"
                    );
                }
            }
            _ => {}
        }
        let d = agent.detect(&bin).await;
        let state = if d.ready { "ready" } else { "not ready" };
        tracing::info!("{}: {state} {} {}", agent.label(), d.version, d.detail);
    }
    removed
}

/// `codex login --with-api-key`, with the key on stdin.
async fn codex_login(bin: &str, key: &str) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new(bin)
        .args(["login", "--with-api-key"])
        .env_clear()
        .envs(crate::agent_env::for_agent(&[OPENAI_API_KEY.to_string()]))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("starting {bin}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        // A CLI that exits without reading stdin is fine here.
        let _ = stdin.write_all(key.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let out = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output())
        .await
        .context("timed out")??;
    if !out.status.success() {
        let mut text = String::from_utf8_lossy(&out.stderr).into_owned();
        text.push_str(&String::from_utf8_lossy(&out.stdout));
        bail!("{}", crate::redact::redact(text.trim()));
    }
    Ok(())
}

async fn serve(
    settings: &Settings,
    paths: Paths,
    cfg: Config,
    env_removed: Vec<(&'static str, &'static str)>,
) -> i32 {
    let identity = match identity::Identity::load(&paths) {
        Ok(i) => i,
        Err(e) => {
            tracing::error!("{e:#}");
            return EXIT_OTHER;
        }
    };
    let mgr = match tasks::Manager::new(paths, cfg) {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("{e:#}");
            return EXIT_OTHER;
        }
    };
    for (agent, var) in env_removed {
        mgr.remove_from_agent_env(agent, var);
    }

    let code = tokio::select! {
        r = connection::run_forever(mgr.clone(), identity) => match r {
            Err(e) if e.downcast_ref::<connection::Refused>().is_some() => {
                tracing::info!("revoked by the control plane; exiting");
                EXIT_OK
            }
            Err(e) => {
                tracing::error!("{e:#}");
                EXIT_OTHER
            }
            Ok(()) => EXIT_OK,
        },
        _ = idle(&mgr, settings.idle_exit) => {
            tracing::info!(
                "no task for {}s; exiting",
                settings.idle_exit.unwrap_or_default().as_secs()
            );
            EXIT_OK
        }
        signal = stop_signal() => {
            tracing::info!("{signal}; exiting");
            EXIT_OK
        }
    };
    shutdown(&mgr).await;
    code
}

/// Resolves once nothing has run for `limit`. Never resolves without a limit.
async fn idle(mgr: &Arc<tasks::Manager>, limit: Option<Duration>) {
    let Some(limit) = limit else {
        return std::future::pending().await;
    };
    let tick = Duration::from_secs(1).min(limit);
    let mut last_busy = Instant::now();
    loop {
        tokio::time::sleep(tick).await;
        if mgr.busy() {
            last_busy = Instant::now();
        } else if last_busy.elapsed() >= limit {
            return;
        }
    }
}

/// Resolves on SIGTERM or Ctrl-C, naming which.
pub(crate) async fn stop_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = term.recv() => return "stopped by SIGTERM",
                _ = tokio::signal::ctrl_c() => return "interrupted",
            }
        }
    }
    let _ = tokio::signal::ctrl_c().await;
    "interrupted"
}

/// Stops running agents before the process exits.
async fn shutdown(mgr: &Arc<tasks::Manager>) {
    if mgr.running_count() == 0 {
        return;
    }
    tracing::info!("cancelling {} running task(s)", mgr.running_count());
    mgr.cancel_all();
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while mgr.running_count() > 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn settings(vars: &[(&str, &str)]) -> Result<Settings> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Settings::from_env(|name| map.get(name).cloned())
    }

    const REPOS_JSON: &str = r#"[{"name":"site","cloneUrl":"https://github.com/acme/site.git","defaultBranch":"main","network":true}]"#;

    fn base() -> Vec<(&'static str, &'static str)> {
        vec![
            (URL, "https://sling.example.com/"),
            (PAIR_CODE, "ABCD-1234"),
            (SANDBOX_ID, "sbx_01abc"),
            (REPOS, REPOS_JSON),
        ]
    }

    #[test]
    fn reads_the_boot_contract() {
        let mut vars = base();
        vars.extend([
            (HARNESSES, "codex, claude-code"),
            (MAX_MODE, "auto"),
            (IDLE_EXIT_SECONDS, "60"),
            (GIT_TOKEN, "ghp_secret"),
            (OPENAI_API_KEY, ""),
        ]);
        let s = settings(&vars).unwrap();
        assert_eq!(s.url, "https://sling.example.com");
        assert_eq!(s.sandbox_id, "sbx_01abc");
        assert_eq!(
            s.repos,
            vec![SandboxRepo {
                name: "site".into(),
                clone_url: "https://github.com/acme/site.git".into(),
                default_branch: "main".into(),
                network: true,
            }]
        );
        assert_eq!(
            s.harnesses.iter().map(|h| h.name()).collect::<Vec<_>>(),
            ["codex", "claude-code"]
        );
        assert_eq!(s.max_mode, Mode::Auto);
        assert_eq!(s.idle_exit, Some(Duration::from_secs(60)));
        assert_eq!(s.git_token.as_deref(), Some("ghp_secret"));
        assert!(s.openai_api_key.is_none(), "empty counts as unset");
    }

    #[test]
    fn defaults() {
        let s = settings(&base()).unwrap();
        assert_eq!(s.max_mode, Mode::FullAccess);
        assert_eq!(s.idle_exit, Some(DEFAULT_IDLE_EXIT));
        assert_eq!(s.harnesses.len(), 2);
        let mut vars = base();
        vars.push((IDLE_EXIT_SECONDS, "0"));
        assert_eq!(settings(&vars).unwrap().idle_exit, None);
    }

    #[test]
    fn refuses_a_bad_environment() {
        for missing in [URL, PAIR_CODE, SANDBOX_ID, REPOS] {
            let vars: Vec<_> = base().into_iter().filter(|(k, _)| *k != missing).collect();
            let err = settings(&vars).unwrap_err().to_string();
            assert!(err.contains(missing), "{err}");
        }
        let mut vars = base();
        vars.push((MAX_MODE, "root"));
        assert!(settings(&vars).is_err());
        let mut vars = base();
        vars[0] = (URL, "sling.example.com");
        assert!(settings(&vars).is_err());
        let mut vars = base();
        vars[2] = (SANDBOX_ID, "../x");
        assert!(settings(&vars).is_err());
    }

    #[test]
    fn checks_repos() {
        let ok = |json: &str| parse_repos(json).is_ok();
        assert!(ok(r#"[{"name":"a","cloneUrl":"file:///srv/a.git"}]"#));
        let local = if cfg!(windows) {
            r"C:\srv\a.git"
        } else {
            "/srv/a.git"
        };
        assert!(ok(
            &serde_json::json!([{ "name": "a", "cloneUrl": local }]).to_string()
        ));
        assert!(ok(
            r#"[{"name":"a","cloneUrl":"git@github.com:acme/a.git"}]"#
        ));
        assert!(ok(
            r#"[{"name":"a","cloneUrl":"http://127.0.0.1:9/a.git"}]"#
        ));
        assert!(!ok("[]"));
        assert!(!ok("not json"));
        assert!(!ok(r#"[{"name":"..","cloneUrl":"/srv/a.git"}]"#));
        assert!(!ok(r#"[{"name":"a/b","cloneUrl":"/srv/a.git"}]"#));
        assert!(!ok(
            r#"[{"name":"a","cloneUrl":"/srv/a.git"},{"name":"a","cloneUrl":"/srv/b.git"}]"#
        ));
        assert!(!ok(
            r#"[{"name":"a","cloneUrl":"https://x:tok@github.com/acme/a.git"}]"#
        ));
        assert!(!ok(
            r#"[{"name":"a","cloneUrl":"https://tok@github.com/acme/a.git"}]"#
        ));
        assert!(!ok(r#"[{"name":"a","cloneUrl":"--upload-pack=evil"}]"#));
        assert!(!ok(r#"[{"name":"a","cloneUrl":"relative/path"}]"#));
        assert!(!ok(r#"[{"name":"a","cloneUrl":"ext::sh -c evil"}]"#));
        assert!(!ok(
            r#"[{"name":"a","cloneUrl":"/srv/a.git","defaultBranch":"-x"}]"#
        ));
    }

    #[test]
    fn the_credential_helper_answers_https_for_known_hosts_only() {
        let repos = parse_repos(
            r#"[{"name":"a","cloneUrl":"https://GitHub.com/acme/a.git"},{"name":"b","cloneUrl":"file:///srv/b.git"}]"#,
        )
        .unwrap();
        let hosts = credential_hosts(&repos);
        assert_eq!(hosts, ["github.com"]);
        let token = Some("ghp_secret");
        let reply = credential_reply("get", "protocol=https\nhost=github.com\n\n", token, &hosts);
        assert_eq!(reply, "username=x-access-token\npassword=ghp_secret\n");
        for input in [
            "protocol=http\nhost=github.com\n",
            "protocol=https\nhost=evil.example\n",
            "protocol=https\n",
            "host=github.com\n",
        ] {
            assert_eq!(credential_reply("get", input, token, &hosts), "", "{input}");
        }
        assert_eq!(
            credential_reply("store", "protocol=https\nhost=github.com\n", token, &hosts),
            ""
        );
        assert_eq!(
            credential_reply("get", "protocol=https\nhost=github.com\n", None, &hosts),
            ""
        );
    }

    #[test]
    fn the_token_only_reaches_git_through_the_helper() {
        let mut vars = base();
        vars.push((GIT_TOKEN, "ghp_secret_value"));
        let s = settings(&vars).unwrap();
        let env = tool_env(&s, Path::new("/opt/it's here/sling-runner"));
        let git: Vec<_> = env.iter().filter(|(p, _, _)| p == "git").collect();
        assert!(git.iter().all(|(_, _, v)| !v.contains("ghp_secret_value")));
        assert!(git.iter().any(|(_, k, v)| k == "GIT_CONFIG_VALUE_1"
            && v == r"!'/opt/it'\''s here/sling-runner' git-credential"));
        let gh: Vec<_> = env.iter().filter(|(p, _, _)| p == "gh").collect();
        assert!(
            gh.iter()
                .any(|(_, k, v)| k == "GH_TOKEN" && v == "ghp_secret_value")
        );

        let s = settings(&base()).unwrap();
        let env = tool_env(&s, Path::new("/sling-runner"));
        assert!(
            env.iter().all(|(_, k, _)| !k.starts_with("GIT_CONFIG")),
            "no token, so other credential helpers stay"
        );
    }
}
