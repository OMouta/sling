//! Small OS helpers.

use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::process::Command;

pub fn hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "runner".into())
}

/// The user's home directory: `HOME`, or `USERPROFILE` on Windows.
pub fn home_dir() -> Option<std::path::PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
}

/// The top of every fixed drive, like `C:\` and `D:\`. None off Windows.
pub fn fixed_drives() -> Vec<std::path::PathBuf> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
        const DRIVE_FIXED: u32 = 3;
        // SAFETY: GetLogicalDrives takes nothing, and GetDriveTypeW gets a
        // NUL-terminated path that outlives the call.
        let mask = unsafe { GetLogicalDrives() };
        (0..26u8)
            .filter(|i| mask & (1 << i) != 0)
            .map(|i| format!("{}:\\", (b'A' + i) as char))
            .filter(|root| {
                let wide: Vec<u16> = root.encode_utf16().chain([0]).collect();
                unsafe { GetDriveTypeW(wide.as_ptr()) == DRIVE_FIXED }
            })
            .map(std::path::PathBuf::from)
            .collect()
    }
    #[cfg(not(windows))]
    Vec::new()
}

pub fn os() -> &'static str {
    std::env::consts::OS
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct Output {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.status == 0
    }
}

/// Extra environment for the Runner's own `git` and `gh` commands, such as
/// a credential helper in a sandbox. Agents never get it: they're started
/// with their own environment.
static TOOL_ENV: OnceLock<Vec<(String, String, String)>> = OnceLock::new();

/// Sets the extra environment, as `(program, name, value)`. Only the first
/// call takes effect.
pub fn set_tool_env(env: Vec<(String, String, String)>) {
    let _ = TOOL_ENV.set(env);
}

/// Matches on the program's file name, so a configured path such as
/// `/opt/homebrew/bin/gh` gets the environment set for `gh`.
fn tool_env(program: &str) -> impl Iterator<Item = (&'static str, &'static str)> {
    let name = std::path::Path::new(program)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(program)
        .to_string();
    TOOL_ENV
        .get()
        .into_iter()
        .flatten()
        .filter(move |(p, _, _)| *p == name)
        .map(|(_, k, v)| (k.as_str(), v.as_str()))
}

/// Runs a short command with a timeout, stdin closed, and output captured.
pub async fn run(program: &str, args: &[&str], cwd: Option<&std::path::Path>) -> Result<Output> {
    run_timeout(program, args, cwd, Duration::from_secs(60)).await
}

pub async fn run_timeout(
    program: &str,
    args: &[&str],
    cwd: Option<&std::path::Path>,
    timeout: Duration,
) -> Result<Output> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .envs(tool_env(program))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let child = cmd.spawn().with_context(|| format!("starting {program}"))?;
    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r?,
        Err(_) => bail!("{program} timed out after {}s", timeout.as_secs()),
    };
    Ok(Output {
        status: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Kills a process group left behind by an earlier Runner, but only if its
/// leader still looks like `expected` (guards against PID reuse).
pub fn kill_orphan_group(pid: u32, expected: &str) {
    #[cfg(unix)]
    {
        let Ok(out) = std::process::Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
        else {
            return;
        };
        let command = String::from_utf8_lossy(&out.stdout);
        if !command.contains(expected) {
            return;
        }
        tracing::warn!(pid, "stopping a harness left over from before the restart");
        // SAFETY: plain syscall on a process group we started earlier.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, expected);
    }
}
