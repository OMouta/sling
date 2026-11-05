//! Runner configuration (`runner.toml`) and where files live on disk.
//!
//! Repos and `max_mode` are set only here, on the machine. The control plane
//! learns about them but has no way to change them (D14, D17).

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

    /// Codex sandbox for this mode (D14).
    pub fn sandbox(self) -> &'static str {
        match self {
            Mode::ReadOnly => "read-only",
            Mode::Supervised | Mode::Auto => "workspace-write",
            Mode::FullAccess => "danger-full-access",
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
    /// Allow network inside the harness sandbox for this repo (D22).
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
    #[serde(default)]
    pub repos: Vec<RepoEntry>,
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
    }
}
