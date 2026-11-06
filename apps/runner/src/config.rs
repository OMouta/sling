//! Runner configuration (`runner.toml`) and where files live on disk.
//!
//! `max_mode` and labels are set only here, on the machine. The control
//! plane learns about them but has no way to change them. Repos are set here
//! too, and while `remote_repos` is on, Sling may also add repos the Runner
//! found on this machine itself, or remove repos. `commands` decides whether
//! the assistant may run shell commands here at all.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    ReadOnly,
    Supervised,
    Auto,
    FullAccess,
}

impl Mode {
    pub fn parse(s: &str) -> Result<Mode> {
        Ok(match s {
            "read-only" => Mode::ReadOnly,
            "supervised" => Mode::Supervised,
            "auto" => Mode::Auto,
            "full-access" => Mode::FullAccess,
            _ => bail!("unknown mode {s:?}, expected read-only, supervised, auto, or full-access"),
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::ReadOnly => "read-only",
            Mode::Supervised => "supervised",
            Mode::Auto => "auto",
            Mode::FullAccess => "full-access",
        }
    }

    pub fn to_proto(self) -> sling_runner_protocol::PermissionMode {
        use sling_runner_protocol::PermissionMode as P;
        match self {
            Mode::ReadOnly => P::ReadOnly,
            Mode::Supervised => P::Supervised,
            Mode::Auto => P::Auto,
            Mode::FullAccess => P::FullAccess,
        }
    }

    /// Unknown values map to the most restrictive mode.
    pub fn from_proto(p: sling_runner_protocol::PermissionMode) -> Mode {
        use sling_runner_protocol::PermissionMode as P;
        match p {
            P::FullAccess => Mode::FullAccess,
            P::Auto => Mode::Auto,
            P::Supervised => Mode::Supervised,
            _ => Mode::ReadOnly,
        }
    }

    pub fn writes(self) -> bool {
        self != Mode::ReadOnly
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RepoEntry {
    pub name: String,
    pub path: PathBuf,
    /// Allow network inside the harness sandbox for this repo.
    #[serde(default)]
    pub network: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    pub server_url: Option<String>,
    pub runner_id: Option<String>,
    pub name: String,
    #[serde(default = "default_max_mode")]
    pub max_mode: Mode,
    #[serde(default = "default_concurrency")]
    pub max_concurrent_tasks: u32,
    pub worktree_root: Option<PathBuf>,
    /// Path to the codex binary. Defaults to `codex` on PATH.
    pub codex_bin: Option<String>,
    /// Path to the Claude Code binary. Defaults to `claude` on PATH.
    pub claude_bin: Option<String>,
    /// Labels tasks can require, for example `ios` or `gpu`. The Runner adds
    /// `os:` and `arch:` labels itself.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    /// Set by `sling-runner sandbox`: this Runner lives in a disposable
    /// environment that is destroyed after its task. Agents run without their
    /// own OS sandbox there, because the environment is the isolation boundary
    /// and their sandboxes can't start inside most containers.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub disposable: bool,
    /// Let Sling add repos the Runner found on this machine, and remove
    /// repos. Sling can never add a path the Runner didn't find itself.
    #[serde(default = "default_remote_repos")]
    pub remote_repos: bool,
    /// Let the assistant run shell commands here. They run in a read-only
    /// sandbox unless `max_mode` is Full access.
    #[serde(default = "default_commands")]
    pub commands: bool,
    /// Where to look for git repos to offer Sling. Defaults to the home
    /// directory.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scan_roots: Vec<PathBuf>,
    #[serde(default)]
    pub repos: Vec<RepoEntry>,
}

fn default_remote_repos() -> bool {
    true
}

fn default_commands() -> bool {
    true
}

fn default_max_mode() -> Mode {
    Mode::FullAccess
}

fn default_concurrency() -> u32 {
    2
}

impl Default for Config {
    fn default() -> Self {
        Config {
            server_url: None,
            runner_id: None,
            name: crate::sys::hostname(),
            max_mode: default_max_mode(),
            max_concurrent_tasks: default_concurrency(),
            worktree_root: None,
            codex_bin: None,
            claude_bin: None,
            labels: Vec::new(),
            disposable: false,
            remote_repos: default_remote_repos(),
            commands: default_commands(),
            scan_roots: Vec::new(),
            repos: Vec::new(),
        }
    }
}

impl Config {
    pub fn load(paths: &Paths) -> Result<Config> {
        let file = paths.config_file();
        if !file.exists() {
            return Ok(Config::default());
        }
        let text = std::fs::read_to_string(&file)
            .with_context(|| format!("reading {}", file.display()))?;
        toml::from_str(&text).with_context(|| format!("parsing {}", file.display()))
    }

    pub fn save(&self, paths: &Paths) -> Result<()> {
        std::fs::create_dir_all(&paths.config_dir)?;
        let text = toml::to_string_pretty(self)?;
        let file = paths.config_file();
        let tmp = file.with_extension("toml.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, &file)?;
        Ok(())
    }

    pub fn repo(&self, name: &str) -> Option<&RepoEntry> {
        self.repos.iter().find(|r| r.name == name)
    }

    pub fn worktree_root(&self, paths: &Paths) -> PathBuf {
        self.worktree_root
            .clone()
            .unwrap_or_else(|| paths.data_dir.join("worktrees"))
    }

    pub fn codex_bin(&self) -> String {
        self.codex_bin.clone().unwrap_or_else(|| "codex".into())
    }

    pub fn claude_bin(&self) -> String {
        self.claude_bin.clone().unwrap_or_else(|| "claude".into())
    }

    /// Directories the repo scan starts from: `scan_roots`, or the home
    /// directory.
    pub fn scan_roots(&self) -> Vec<PathBuf> {
        if !self.scan_roots.is_empty() {
            return self.scan_roots.clone();
        }
        crate::sys::home_dir().into_iter().collect()
    }

    /// Labels sent in the inventory: the configured ones plus `os:<os>` and
    /// `arch:<arch>`.
    pub fn all_labels(&self) -> Vec<String> {
        let mut out = self.labels.clone();
        out.push(format!("os:{}", crate::sys::os()));
        out.push(format!("arch:{}", std::env::consts::ARCH));
        out
    }
}

/// Most labels a Runner may set.
pub const MAX_LABELS: usize = 32;
const MAX_LABEL_LEN: usize = 64;
/// Prefixes the Runner sets itself.
const RESERVED_PREFIXES: &[&str] = &["os:", "arch:"];

/// Parses `ios,gpu` into labels. Labels use lowercase letters, digits, `-`,
/// `_`, `:`, and `.`. An empty string clears them.
pub fn parse_labels(value: &str) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for label in value.split(',').map(str::trim).filter(|l| !l.is_empty()) {
        if label.len() > MAX_LABEL_LEN
            || !label.chars().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | ':' | '.')
            })
        {
            bail!(
                "invalid label {label:?}: use lowercase letters, digits, '-', '_', ':' and '.', up to {MAX_LABEL_LEN} characters"
            );
        }
        if let Some(p) = RESERVED_PREFIXES.iter().find(|p| label.starts_with(**p)) {
            bail!("labels starting with {p:?} are set automatically");
        }
        if !out.iter().any(|l| l == label) {
            out.push(label.to_string());
        }
    }
    if out.len() > MAX_LABELS {
        bail!("at most {MAX_LABELS} labels");
    }
    Ok(out)
}

/// Parses `on` or `off` (also `true` and `false`).
pub fn parse_on_off(value: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "on" | "true" => Ok(true),
        "off" | "false" => Ok(false),
        _ => bail!("expected on or off, got {value:?}"),
    }
}

/// Parses `~/code,/srv/git` into absolute directories. `~` stands for the
/// home directory. An empty string goes back to the default, the home
/// directory.
pub fn parse_scan_roots(value: &str) -> Result<Vec<PathBuf>> {
    let mut out: Vec<PathBuf> = Vec::new();
    for raw in value.split(',').map(str::trim).filter(|r| !r.is_empty()) {
        let path = match raw.strip_prefix('~') {
            Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
                let home = crate::sys::home_dir().context("no home directory to expand ~")?;
                home.join(rest.trim_start_matches(['/', '\\']))
            }
            _ => PathBuf::from(raw),
        };
        if !path.is_absolute() {
            bail!("scan roots must be absolute paths, got {raw:?}");
        }
        if !out.contains(&path) {
            out.push(path);
        }
    }
    Ok(out)
}

#[derive(Clone, Debug)]
pub struct Paths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
}

impl Paths {
    /// `SLING_RUNNER_HOME` puts everything under one directory, which is handy
    /// for running more than one Runner on a machine and for tests.
    pub fn resolve() -> Result<Paths> {
        if let Some(home) = std::env::var_os("SLING_RUNNER_HOME") {
            let home = PathBuf::from(home);
            return Ok(Paths {
                config_dir: home.clone(),
                data_dir: home.join("data"),
            });
        }
        if cfg!(windows) {
            let appdata = env_dir("APPDATA")?;
            let local = env_dir("LOCALAPPDATA").unwrap_or_else(|_| appdata.clone());
            return Ok(Paths {
                config_dir: appdata.join("Sling"),
                data_dir: local.join("Sling"),
            });
        }
        let home = env_dir("HOME")?;
        let config = env_dir("XDG_CONFIG_HOME").unwrap_or_else(|_| home.join(".config"));
        let data = env_dir("XDG_DATA_HOME").unwrap_or_else(|_| home.join(".local/share"));
        Ok(Paths {
            config_dir: config.join("sling"),
            data_dir: data.join("sling"),
        })
    }

    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("runner.toml")
    }

    pub fn key_file(&self) -> PathBuf {
        self.config_dir.join("runner.key")
    }

    pub fn spool_dir(&self) -> PathBuf {
        self.data_dir.join("spool")
    }

    /// Holds one empty directory per running chat turn.
    pub fn chat_dir(&self) -> PathBuf {
        self.data_dir.join("chat")
    }

    pub fn log_file(&self) -> PathBuf {
        self.data_dir.join("runner.log")
    }
}

fn env_dir(var: &str) -> Result<PathBuf> {
    match std::env::var_os(var) {
        Some(v) if !v.is_empty() => Ok(PathBuf::from(v)),
        _ => bail!("{var} is not set"),
    }
}

/// Writes a file readable only by the current user.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_order_from_least_to_most_access() {
        assert!(Mode::ReadOnly < Mode::Supervised);
        assert!(Mode::Supervised < Mode::Auto);
        assert!(Mode::Auto < Mode::FullAccess);
        assert_eq!(Mode::parse("auto").unwrap(), Mode::Auto);
        assert!(Mode::parse("root").is_err());
    }

    #[test]
    fn config_round_trips_through_toml() {
        let c = Config {
            max_mode: Mode::Supervised,
            repos: vec![RepoEntry {
                name: "site".into(),
                path: "/code/site".into(),
                network: true,
            }],
            ..Config::default()
        };
        let text = toml::to_string_pretty(&c).unwrap();
        assert!(text.contains("max_mode = \"supervised\""));
        let back: Config = toml::from_str(&text).unwrap();
        assert_eq!(back.max_mode, Mode::Supervised);
        assert!(back.repos[0].network);
        assert!(back.labels.is_empty());
        assert!(!text.contains("labels"), "left out unless set");
        assert!(!back.disposable);
        assert!(!text.contains("disposable"), "left out unless set");
        assert!(text.contains("remote_repos = true"), "always shown");
        assert!(!text.contains("scan_roots"), "left out unless set");
    }

    #[test]
    fn remote_repos_are_on_unless_turned_off() {
        let old: Config = toml::from_str("name = \"laptop\"\n").unwrap();
        assert!(
            old.remote_repos,
            "configs from before the setting keep working"
        );
        let off: Config = toml::from_str("name = \"laptop\"\nremote_repos = false\n").unwrap();
        assert!(!off.remote_repos);
        assert!(parse_on_off("on").unwrap());
        assert!(!parse_on_off("OFF").unwrap());
        assert!(parse_on_off("maybe").is_err());
    }

    #[test]
    fn scan_roots_are_absolute() {
        let home = crate::sys::home_dir().unwrap();
        assert_eq!(
            parse_scan_roots("~/code, /srv/git,~/code").unwrap(),
            vec![home.join("code"), PathBuf::from("/srv/git")]
        );
        assert_eq!(parse_scan_roots("~").unwrap(), vec![home.clone()]);
        assert!(parse_scan_roots("").unwrap().is_empty());
        assert!(parse_scan_roots("code").is_err());
        assert!(parse_scan_roots("~bob/code").is_err());
        let c = Config::default();
        assert_eq!(c.scan_roots(), vec![home]);
    }

    #[test]
    fn labels_are_validated() {
        assert_eq!(parse_labels("ios, gpu,ios").unwrap(), vec!["ios", "gpu"]);
        assert_eq!(
            parse_labels("team:mobile,xcode-16.2,big_disk").unwrap(),
            vec!["team:mobile", "xcode-16.2", "big_disk"]
        );
        assert!(parse_labels("").unwrap().is_empty());
        assert!(parse_labels("iOS").is_err());
        assert!(parse_labels("has space").is_err());
        assert!(parse_labels("os:linux").is_err());
        assert!(parse_labels("arch:x86_64").is_err());
        let many: Vec<String> = (0..33).map(|i| format!("l{i}")).collect();
        assert!(parse_labels(&many.join(",")).is_err());
        assert!(parse_labels(&"x".repeat(65)).is_err());
    }

    #[test]
    fn automatic_labels_are_added() {
        let c = Config {
            labels: vec!["ios".into()],
            ..Config::default()
        };
        let all = c.all_labels();
        assert_eq!(all[0], "ios");
        assert!(all.iter().any(|l| l.starts_with("os:")));
        assert!(all.iter().any(|l| l.starts_with("arch:")));
    }
}
