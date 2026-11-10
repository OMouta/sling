//! Shell commands the assistant runs on this machine, as its user. Each one
//! answers with a single ExecResult. Most run in a read-only sandbox: the
//! command can read files, but can't write them, use the network, open apps,
//! send Apple Events, or signal other processes. That's `sandbox-exec` on
//! macOS and bubblewrap on Linux. A command runs outside the sandbox only
//! when this machine's max-mode is Full access and the conversation isn't
//! Read-only; the control plane asks the user first outside Full access.
//! Processes a command leaves behind are stopped when it ends.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use sling_runner_protocol::envelope::Body;
use sling_runner_protocol::{Capability, ExecRequest, ExecResult, PermissionMode};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc};

use crate::config::{Config, Mode};
use crate::tasks::Manager;

#[cfg(all(test, unix))]
#[path = "exec_tests.rs"]
mod tests;

/// Sent when this machine runs the assistant's commands.
pub const SHELL: &str = "shell";
/// Sent when it can run them in its read-only sandbox.
pub const SHELL_SANDBOX: &str = "shell.sandbox";
/// Commands running at once, across all chats.
pub const MAX_COMMANDS: usize = 8;
pub const MAX_TIMEOUT_SECS: u32 = 300;
const DEFAULT_TIMEOUT_SECS: u32 = 60;
/// Output kept from the start and from the end. What's between is cut.
const HEAD_BYTES: usize = 48 * 1024;
const TAIL_BYTES: usize = 16 * 1024;
const MAX_COMMAND_BYTES: usize = 16 * 1024;
/// How long output may keep coming after the command exits, from processes
/// it left behind, before they're stopped.
const DRAIN: Duration = Duration::from_millis(500);

/// macOS: everything a process can normally do, minus writing files, the
/// network, and the services that would let it change things through
/// another process (preferences, the pasteboard, Launch Services, Apple
/// Events, the keychain, launchd jobs). Writes to /dev/null and terminals
/// still work.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const SEATBELT_PROFILE: &str = r#"(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write-data
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/dtracehelper")
  (regex #"^/dev/tty")
  (regex #"^/dev/fd/"))
(deny appleevent-send)
(deny job-creation)
(deny signal (target others))
(deny mach-lookup
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.coreservices.launchservicesd")
  (global-name-prefix "com.apple.lsd.")
  (global-name "com.apple.FileCoordination")
  (global-name "com.apple.pasteboard.1")
  (global-name "com.apple.SecurityServer")
  (global-name-prefix "com.apple.securityd"))
"#;

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// The sandbox this machine has for commands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sandbox {
    Seatbelt,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Bubblewrap(PathBuf),
    /// None here, and why.
    Missing(String),
}

impl Sandbox {
    pub fn available(&self) -> bool {
        !matches!(self, Sandbox::Missing(_))
    }
}

/// Finds the sandbox and checks that it starts.
pub async fn detect_sandbox() -> Sandbox {
    if cfg!(target_os = "macos") {
        if !Path::new(SANDBOX_EXEC).exists() {
            return Sandbox::Missing(format!("{SANDBOX_EXEC} is missing."));
        }
        return match probe(
            SANDBOX_EXEC,
            &["-p", SEATBELT_PROFILE, "/usr/bin/true"],
            None,
        )
        .await
        {
            Ok(()) => Sandbox::Seatbelt,
            Err(e) => Sandbox::Missing(format!("sandbox-exec doesn't start: {e}")),
        };
    }
    #[cfg(target_os = "linux")]
    return detect_bwrap().await;
    #[cfg(not(target_os = "linux"))]
    return Sandbox::Missing("No command sandbox on this OS.".into());
}

#[cfg(target_os = "linux")]
async fn detect_bwrap() -> Sandbox {
    let Some(bwrap) = which("bwrap") else {
        return Sandbox::Missing(
            "Install bubblewrap (bwrap) to run commands in a read-only sandbox.".into(),
        );
    };
    let filter = match filter_fd() {
        Ok(fd) => fd,
        Err(e) => return Sandbox::Missing(format!("Can't set up the sandbox filter: {e}")),
    };
    let fd = std::os::fd::AsRawFd::as_raw_fd(&filter);
    let mut args: Vec<String> = bwrap_args(Some(fd));
    args.push("/bin/true".into());
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match probe(&bwrap.to_string_lossy(), &args, Some(fd)).await {
        Ok(()) => Sandbox::Bubblewrap(bwrap),
        Err(e) => Sandbox::Missing(format!(
            "bubblewrap doesn't start here ({e}). It needs unprivileged user namespaces."
        )),
    }
}

/// Runs `program` once. `pass` is a descriptor the child inherits.
async fn probe(program: &str, args: &[&str], pass: Option<i32>) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "linux")]
    if let Some(fd) = pass {
        pass_fd(&mut cmd, fd);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = pass;
    let out = tokio::time::timeout(Duration::from_secs(5), cmd.output())
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(err.lines().next().unwrap_or("failed").trim().to_string())
    }
}

#[cfg(target_os = "linux")]
fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
    })
}

/// bubblewrap: the whole filesystem read-only, fresh /tmp and /run (which
/// hides sockets to other services), and no network, IPC, or other
/// processes. `seccomp` is a descriptor holding `unix_socket_filter`, which
/// refuses the sockets a read-only mount and a new network namespace leave
/// reachable, such as an SSH control socket or Docker's under home.
fn bwrap_args(seccomp: Option<i32>) -> Vec<String> {
    let mut args: Vec<String> = [
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/run",
        "--unshare-net",
        "--unshare-ipc",
        "--unshare-pid",
        "--die-with-parent",
        "--new-session",
    ]
    .map(String::from)
    .to_vec();
    if let Some(fd) = seccomp {
        args.extend(["--seccomp".into(), fd.to_string()]);
    }
    args.push("--".into());
    args
}

/// A seccomp filter for the sandbox: no Unix sockets (`socketpair` still
/// works), no io_uring, which could open them without a syscall, and no
/// syscalls from another ABI. Everything else is allowed.
#[cfg(target_os = "linux")]
pub(crate) fn unix_socket_filter() -> Option<Vec<u8>> {
    const LD_ABS: u16 = 0x20;
    const JEQ: u16 = 0x15;
    const JGE: u16 = 0x35;
    const RET: u16 = 0x06;
    const ALLOW: u32 = 0x7fff_0000;
    const DENY: u32 = 0x0005_0000 | libc::EPERM as u32;
    // x32 syscalls on x86_64 set this bit in the number.
    const X32_BIT: u32 = 0x4000_0000;
    const IO_URING_SETUP: u32 = 425;
    let arch: u32 = if cfg!(target_arch = "x86_64") {
        0xc000_003e
    } else if cfg!(target_arch = "aarch64") {
        0xc000_00b7
    } else {
        return None;
    };
    // (code, jump if true, jump if false, k); jumps skip that many
    // instructions. Offsets 0, 4 and 16 of seccomp_data are the arch, the
    // syscall number, and the low half of the first argument.
    let program: [(u16, u8, u8, u32); 11] = [
        (LD_ABS, 0, 0, 4),
        (JEQ, 1, 0, arch),
        (RET, 0, 0, DENY),
        (LD_ABS, 0, 0, 0),
        (JGE, 5, 0, X32_BIT),
        (JEQ, 4, 0, IO_URING_SETUP),
        (JEQ, 0, 2, libc::SYS_socket as u32),
        (LD_ABS, 0, 0, 16),
        (JEQ, 1, 0, libc::AF_UNIX as u32),
        (RET, 0, 0, ALLOW),
        (RET, 0, 0, DENY),
    ];
    let mut out = Vec::with_capacity(program.len() * 8);
    for (code, jt, jf, k) in program {
        out.extend(code.to_ne_bytes());
        out.extend([jt, jf]);
        out.extend(k.to_ne_bytes());
    }
    Some(out)
}

/// The read end of a pipe that holds `unix_socket_filter`, for bubblewrap's
/// `--seccomp`. It's close-on-exec until `pass_fd` hands it to one child.
#[cfg(target_os = "linux")]
fn filter_fd() -> std::io::Result<std::os::fd::OwnedFd> {
    use std::io::Write;
    use std::os::fd::FromRawFd;
    let filter = unix_socket_filter()
        .ok_or_else(|| std::io::Error::other("no command sandbox filter for this CPU"))?;
    let mut fds = [0; 2];
    // SAFETY: pipe2 fills `fds` with two new descriptors that we then own.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: both descriptors were just created and nothing else owns them.
    let (read, write) = unsafe {
        (
            std::os::fd::OwnedFd::from_raw_fd(fds[0]),
            std::fs::File::from_raw_fd(fds[1]),
        )
    };
    // The filter is far smaller than a pipe's buffer, so this can't block.
    (&write).write_all(&filter)?;
    drop(write);
    Ok(read)
}

#[cfg(target_os = "linux")]
fn pass_fd(cmd: &mut Command, fd: i32) {
    // SAFETY: fcntl is async-signal-safe, and only clears close-on-exec on a
    // descriptor this process owns until the child execs.
    unsafe {
        cmd.pre_exec(move || {
            if libc::fcntl(fd, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// The `shell` and `shell.sandbox` capabilities.
pub fn capabilities(cfg: &Config, sandbox: &Sandbox) -> [Capability; 2] {
    [
        Capability {
            name: SHELL.into(),
            version: env!("CARGO_PKG_VERSION").into(),
            ready: cfg.commands,
            detail: if cfg.commands {
                String::new()
            } else {
                "Commands are off. Turn them on with `sling-runner config set commands on`.".into()
            },
            models: Vec::new(),
        },
        Capability {
            name: SHELL_SANDBOX.into(),
            version: String::new(),
            ready: sandbox.available(),
            detail: match sandbox {
                Sandbox::Seatbelt => "sandbox-exec".into(),
                Sandbox::Bubblewrap(_) => "bubblewrap".into(),
                Sandbox::Missing(why) => why.clone(),
            },
            models: Vec::new(),
        },
    ]
}

/// The user's shell when it's one that takes POSIX-style commands, else
/// /bin/sh.
pub(crate) fn shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| {
            let p = Path::new(s);
            p.is_absolute()
                && p.is_file()
                && matches!(
                    p.file_name().and_then(|n| n.to_str()),
                    Some("zsh" | "bash" | "sh" | "dash" | "ksh")
                )
        })
        .unwrap_or_else(|| "/bin/sh".into())
}

/// `cwd` as an absolute directory: empty means home, and `~` or `~/x` are
/// under home.
pub fn resolve_cwd(cwd: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    let cwd = cwd.trim();
    let path = if cwd.is_empty() || cwd == "~" {
        home.map(Path::to_path_buf)
            .ok_or("This machine has no home directory; pass an absolute cwd.")?
    } else if let Some(rest) = cwd.strip_prefix("~/") {
        home.ok_or("This machine has no home directory; pass an absolute cwd.")?
            .join(rest)
    } else {
        PathBuf::from(cwd)
    };
    if !path.is_absolute() {
        return Err(format!(
            "cwd must be absolute or start with ~/, got {cwd:?}."
        ));
    }
    if !path.is_dir() {
        return Err(format!("{} isn't a directory here.", path.display()));
    }
    Ok(path)
}

/// Why the Runner won't run `r`, if it won't. `sandbox` is what this
/// machine has.
pub fn refusal(r: &ExecRequest, cfg: &Config, sandbox: &Sandbox) -> Option<String> {
    if !cfg.commands {
        return Some(
            "Commands are off on this machine. The owner turns them on with `sling-runner config set commands on`."
                .into(),
        );
    }
    if r.command.trim().is_empty() {
        return Some("The command is empty.".into());
    }
    if r.command.len() > MAX_COMMAND_BYTES {
        return Some(format!(
            "The command is longer than {MAX_COMMAND_BYTES} bytes."
        ));
    }
    if r.command.contains('\0') {
        return Some("The command contains a NUL byte.".into());
    }
    let mode =
        Mode::from_proto(PermissionMode::try_from(r.mode).unwrap_or(PermissionMode::Unspecified));
    if r.sandboxed {
        if let Sandbox::Missing(why) = sandbox {
            return Some(format!("This machine can't sandbox commands: {why}"));
        }
        return None;
    }
    if mode == Mode::ReadOnly {
        return Some("Read-only conversations run commands only in the sandbox.".into());
    }
    if cfg.max_mode != Mode::FullAccess {
        return Some(format!(
            "This machine runs commands only in its read-only sandbox, because its max-mode is {}.",
            cfg.max_mode.as_str()
        ));
    }
    None
}

/// Output kept as it comes: the first `HEAD_BYTES`, and the last
/// `TAIL_BYTES` after that.
#[derive(Default)]
pub struct Capture {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    cut: usize,
}

impl Capture {
    pub fn push(&mut self, mut bytes: &[u8]) {
        if self.head.len() < HEAD_BYTES {
            let n = bytes.len().min(HEAD_BYTES - self.head.len());
            self.head.extend_from_slice(&bytes[..n]);
            bytes = &bytes[n..];
        }
        self.tail.extend(bytes);
        while self.tail.len() > TAIL_BYTES {
            let extra = self.tail.len() - TAIL_BYTES;
            self.tail.drain(..extra);
            self.cut += extra;
        }
    }

    pub fn truncated(&self) -> bool {
        self.cut > 0
    }

    pub fn text(&self) -> String {
        let head = String::from_utf8_lossy(&self.head);
        if self.tail.is_empty() {
            return head.into_owned();
        }
        let tail: Vec<u8> = self.tail.iter().copied().collect();
        let tail = String::from_utf8_lossy(&tail);
        if self.cut == 0 {
            return format!("{head}{tail}");
        }
        format!("{head}\n… {} bytes cut …\n{tail}", self.cut)
    }
}

async fn pump<R: AsyncRead + Unpin>(mut from: R, into: Arc<Mutex<Capture>>) {
    let mut buf = [0u8; 8192];
    loop {
        match from.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => into.lock().await.push(&buf[..n]),
        }
    }
}

#[cfg(unix)]
fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        // SAFETY: signals the process group the command leads; it was
        // started in its own group, so this reaches nothing else.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: Option<u32>) {}

/// The program and arguments that run `command`, sandboxed or not.
/// `seccomp` is the descriptor bubblewrap reads its filter from.
fn argv(
    command: &str,
    sandboxed: bool,
    sandbox: &Sandbox,
    seccomp: Option<i32>,
) -> (String, Vec<String>) {
    if cfg!(windows) {
        return ("cmd".into(), vec!["/C".into(), command.into()]);
    }
    let sh = if sandboxed {
        // The user's shell may live somewhere the sandbox can't exec from
        // on Linux; /bin/sh is always there.
        match sandbox {
            Sandbox::Seatbelt => shell(),
            _ => "/bin/sh".into(),
        }
    } else {
        shell()
    };
    let inner = vec![sh, "-c".into(), command.into()];
    if !sandboxed {
        let mut it = inner.into_iter();
        let program = it.next().unwrap_or_default();
        return (program, it.collect());
    }
    match sandbox {
        Sandbox::Seatbelt => {
            let mut args = vec!["-p".into(), SEATBELT_PROFILE.into()];
            args.extend(inner);
            (SANDBOX_EXEC.into(), args)
        }
        Sandbox::Bubblewrap(bwrap) => {
            let mut args = bwrap_args(seccomp);
            args.extend(inner);
            (bwrap.to_string_lossy().into_owned(), args)
        }
        Sandbox::Missing(_) => unreachable!("refused before running"),
    }
}

/// Runs one command and reports how it went. `env` is the environment it
/// gets. Stops early if `out` closes, as when the connection drops.
pub async fn run(
    r: &ExecRequest,
    cwd: &Path,
    sandbox: &Sandbox,
    env: Vec<(String, String)>,
    out: &mpsc::Sender<Body>,
) -> ExecResult {
    let started = Instant::now();
    let timeout = Duration::from_secs(
        match r.timeout_seconds {
            0 => DEFAULT_TIMEOUT_SECS,
            n => n.min(MAX_TIMEOUT_SECS),
        }
        .into(),
    );
    let mut result = ExecResult {
        request_id: r.request_id.clone(),
        sandboxed: r.sandboxed,
        cwd: cwd.display().to_string(),
        ..Default::default()
    };
    #[cfg(target_os = "linux")]
    let filter = match (r.sandboxed, sandbox) {
        (true, Sandbox::Bubblewrap(_)) => match filter_fd() {
            Ok(fd) => Some(fd),
            Err(e) => {
                result.error = format!("Couldn't set up the sandbox filter: {e}");
                return result;
            }
        },
        _ => None,
    };
    #[cfg(target_os = "linux")]
    let seccomp = filter.as_ref().map(std::os::fd::AsRawFd::as_raw_fd);
    #[cfg(not(target_os = "linux"))]
    let seccomp = None;
    let (program, args) = argv(&r.command, r.sandboxed, sandbox, seccomp);
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .envs([
            ("NO_COLOR", "1"),
            ("CLICOLOR", "0"),
            ("TERM", "dumb"),
            ("PAGER", "cat"),
            ("GIT_PAGER", "cat"),
            ("GIT_TERMINAL_PROMPT", "0"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(target_os = "linux")]
    if let Some(fd) = seccomp {
        pass_fd(&mut cmd, fd);
    }
    let spawned = cmd.spawn();
    #[cfg(target_os = "linux")]
    drop(filter);
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            result.error = format!("Couldn't start {program}: {e}");
            return result;
        }
    };
    let pid = child.id();
    let job = crate::job::Job::adopt(pid);
    let capture = Arc::new(Mutex::new(Capture::default()));
    let readers = [
        child
            .stdout
            .take()
            .map(|s| tokio::spawn(pump(s, capture.clone()))),
        child
            .stderr
            .take()
            .map(|s| tokio::spawn(pump(s, capture.clone()))),
    ];

    let status = tokio::select! {
        s = child.wait() => Some(s),
        _ = tokio::time::sleep(timeout) => {
            result.timed_out = true;
            None
        }
        _ = out.closed() => None,
    };
    if let Some(Ok(status)) = &status {
        result.exit_code = status.code();
    } else if let Some(Err(e)) = &status {
        result.error = format!("Lost track of the command: {e}");
    }
    // Leftover processes may still hold the pipes; give them a moment.
    let drain = async {
        for reader in readers.into_iter().flatten() {
            let _ = reader.await;
        }
    };
    let _ = tokio::time::timeout(
        if status.is_some() {
            DRAIN
        } else {
            Duration::ZERO
        },
        drain,
    )
    .await;
    kill_group(pid);
    job.kill();
    let _ = child.kill().await;

    let capture = capture.lock().await;
    result.output = crate::redact::redact(&capture.text());
    result.truncated = capture.truncated();
    result.duration_ms = started.elapsed().as_millis() as u64;
    result
}

impl Manager {
    /// Handles ExecRequest: runs the command in the background and sends one
    /// ExecResult to `out`.
    pub fn exec(self: &Arc<Self>, r: ExecRequest, out: mpsc::Sender<Body>) {
        let me = self.clone();
        tokio::spawn(async move {
            let result = me.exec_one(&r, &out).await;
            tracing::info!(
                request = r.request_id,
                sandboxed = result.sandboxed,
                exit = ?result.exit_code,
                ms = result.duration_ms,
                error = result.error,
                "command finished"
            );
            let _ = out.send(Body::ExecResult(result)).await;
        });
    }

    async fn exec_one(&self, r: &ExecRequest, out: &mpsc::Sender<Body>) -> ExecResult {
        let refused = |error: String| ExecResult {
            request_id: r.request_id.clone(),
            sandboxed: r.sandboxed,
            error,
            ..Default::default()
        };
        let cfg = self.config();
        let sandbox = self.command_sandbox().await;
        if let Some(why) = refusal(r, &cfg, &sandbox) {
            return refused(why);
        }
        let cwd = match resolve_cwd(&r.cwd, crate::sys::home_dir().as_deref()) {
            Ok(p) => p,
            Err(why) => return refused(why),
        };
        if self.commands_running.fetch_add(1, Ordering::SeqCst) >= MAX_COMMANDS {
            self.commands_running.fetch_sub(1, Ordering::SeqCst);
            return refused(format!(
                "This machine is already running {MAX_COMMANDS} commands."
            ));
        }
        let result = run(r, &cwd, &sandbox, self.agent_env("shell"), out).await;
        self.commands_running.fetch_sub(1, Ordering::SeqCst);
        result
    }

    /// The command sandbox, checked once and then remembered.
    pub async fn command_sandbox(&self) -> Sandbox {
        let mut known = self.sandbox.lock().await;
        if let Some(s) = known.as_ref() {
            return s.clone();
        }
        let found = detect_sandbox().await;
        *known = Some(found.clone());
        found
    }
}
