//! Small OS helpers.

use std::process::Stdio;
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

pub fn os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        other => other,
    }
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
