//! Boots `sling-runner sandbox` as a child process against a stub control
//! plane: a minimal HTTP and WebSocket server on one port that accepts the
//! pairing request, answers the handshake, assigns a task, and asks for a
//! push. The repo is cloned from a local bare repo, and `fake-codex` stands in
//! for Codex.
//!
//! With `SLING_SANDBOX_IMAGE` set, for example to `sling-sandbox:dev`, the
//! same tests run the sandbox inside that image with `docker run`, and a shell
//! script stands in for Codex. The container reaches the stub at
//! `host.docker.internal`, and the test directory is mounted at the same path.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use sling_runner_protocol::{
    ActionRequest, Challenge, Envelope, EventAck, HeartbeatAck, Hello, Inventory, Message as _,
    PermissionMode, RepoChange, RepoChangeResult, RepoScan, TaskAssign, TaskEvent, Welcome,
    action_request, action_result, auth_payload, envelope::Body, error, repo_change,
    task_event::Kind, task_finished,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const RUNNER: &str = env!("CARGO_BIN_EXE_sling-runner");
const GIT_TOKEN: &str = "ghs_sandboxtesttoken0123456789abcdef";
const OPENAI_KEY: &str = "sk-sandbox-test-openai-key-0123456789";
const PAIR_CODE: &str = "PAIR-5678";
const NONCE: [u8; 32] = [7; 32];

fn docker_image() -> Option<String> {
    std::env::var("SLING_SANDBOX_IMAGE")
        .ok()
        .filter(|v| !v.is_empty())
}

/// Codex in the image's shape, for a Linux container: logs in with a key,
/// reports what it can see of the environment, and edits a file.
const SHELL_CODEX: &str = r#"#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.166.0" ;;
  login)
    if [ "$2" = "--with-api-key" ]; then cat > /dev/null; echo "API key saved."; exit 0; fi
    echo "Logged in using a shell stand-in" ;;
  exec)
    cat > /dev/null
    dir="."
    while [ $# -gt 0 ]; do case "$1" in -C) dir="$2"; shift ;; esac; shift; done
    seen=$(env | cut -d= -f1 | grep -E '^(SLING_|GH_TOKEN$|GITHUB_TOKEN$|OPENAI_API_KEY$|ANTHROPIC_API_KEY$)' | sort | paste -sd, -)
    echo '{"type":"thread.started","thread_id":"t1"}'
    echo "{\"type\":\"item.completed\",\"item\":{\"id\":\"e\",\"type\":\"agent_message\",\"text\":\"Sensitive environment: [$seen]\"}}"
    echo "- change" >> "$dir/SLING_FAKE.md"
    echo "{\"type\":\"item.completed\",\"item\":{\"id\":\"f\",\"type\":\"file_change\",\"changes\":[{\"path\":\"$dir/SLING_FAKE.md\",\"kind\":\"add\"}],\"status\":\"completed\"}}"
    echo '{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"Updated SLING_FAKE.md."}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
    ;;
esac
"#;

/// `fake-codex` comes from another package, so build it if this test run
/// hasn't yet.
fn fake_codex() -> PathBuf {
    let dir = Path::new(RUNNER).parent().unwrap();
    let bin = dir.join("fake-codex");
    if !bin.exists() {
        let mut cmd = std::process::Command::new(env!("CARGO"));
        cmd.args([
            "build",
            "-q",
            "-p",
            "sling-harness-codex",
            "--bin",
            "fake-codex",
        ]);
        if dir.ends_with("release") {
            cmd.arg("--release");
        }
        assert!(cmd.status().unwrap().success(), "building fake-codex");
    }
    bin
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=t"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A test directory, canonicalized so it mounts at the same path in Docker.
fn test_dir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    (dir, root)
}

/// A bare repo with one commit on `main`.
fn bare_repo(root: &Path) -> PathBuf {
    let remote = root.join("site.git");
    let work = root.join("seed");
    std::fs::create_dir_all(&work).unwrap();
    git(
        root,
        &[
            "init",
            "-q",
            "--bare",
            "-b",
            "main",
            remote.to_str().unwrap(),
        ],
    );
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("README.md"), "# site\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-qm", "init"]);
    git(&work, &["push", "-q", remote.to_str().unwrap(), "main"]);
    remote
}

#[derive(Debug)]
enum Seen {
    Paired(serde_json::Value),
    Hello(Hello),
    Event(TaskEvent),
    Inventory(Inventory),
    RepoChangeResult(RepoChangeResult),
    Closed,
}

/// The stub control plane. Messages sent on `to_runner` go to the connected
/// Runner; everything it hears arrives on `seen`.
struct Stub {
    url: String,
    seen: mpsc::UnboundedReceiver<Seen>,
    to_runner: mpsc::UnboundedSender<Body>,
}

impl Stub {
    async fn start() -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = if docker_image().is_some() {
            "host.docker.internal"
        } else {
            "127.0.0.1"
        };
        let url = format!("http://{host}:{}", listener.local_addr().unwrap().port());
        let (seen_tx, seen) = mpsc::unbounded_channel();
        let (to_runner, mut cmds) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                match request_line(&stream).await.as_deref() {
                    Some(l) if l.starts_with("POST /api/runner/pair ") => {
                        pair(stream, &seen_tx).await
                    }
                    Some(l) if l.starts_with("GET /runner/v1/ws ") => {
                        websocket(stream, &seen_tx, &mut cmds).await;
                        let _ = seen_tx.send(Seen::Closed);
                    }
                    _ => {}
                }
            }
        });
        Stub {
            url,
            seen,
            to_runner,
        }
    }

    async fn next(&mut self) -> Seen {
        tokio::time::timeout(Duration::from_secs(60), self.seen.recv())
            .await
            .expect("timed out waiting for the Runner")
            .expect("stub stopped")
    }

    async fn next_event(&mut self) -> TaskEvent {
        loop {
            if let Seen::Event(e) = self.next().await {
                return e;
            }
        }
    }

    fn send(&self, body: Body) {
        self.to_runner.send(body).unwrap();
    }
}

/// Peeks at the request line without consuming it, so the WebSocket
/// handshake can still read the whole request.
async fn request_line(stream: &TcpStream) -> Option<String> {
    let mut buf = [0u8; 256];
    for _ in 0..200 {
        let n = stream.peek(&mut buf).await.ok()?;
        if let Some(end) = buf[..n].windows(2).position(|w| w == b"\r\n") {
            return Some(String::from_utf8_lossy(&buf[..end]).into_owned());
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    None
}

async fn pair(stream: TcpStream, seen: &mpsc::UnboundedSender<Seen>) {
    let mut reader = BufReader::new(stream);
    let mut length = 0usize;
    let mut chunked = false;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let lower = line.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            length = v.trim().parse().unwrap();
        }
        if lower.starts_with("transfer-encoding:") && lower.contains("chunked") {
            chunked = true;
        }
        if line == "\r\n" {
            break;
        }
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            let mut size = String::new();
            reader.read_line(&mut size).await.unwrap();
            let n = usize::from_str_radix(size.trim(), 16).unwrap();
            let mut chunk = vec![0; n + 2];
            reader.read_exact(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
    } else {
        body.resize(length, 0);
        reader.read_exact(&mut body).await.unwrap();
    }
    let _ = seen.send(Seen::Paired(serde_json::from_slice(&body).unwrap()));
    let reply = r#"{"runnerId":"rnr_sandbox_test"}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
        reply.len()
    );
    let mut stream = reader.into_inner();
    stream.write_all(response.as_bytes()).await.unwrap();
    let _ = stream.shutdown().await;
}

async fn websocket(
    stream: TcpStream,
    seen: &mpsc::UnboundedSender<Seen>,
    cmds: &mut mpsc::UnboundedReceiver<Body>,
) {
    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (mut sink, mut stream) = ws.split();
    let send = |body: Body| Message::Binary(Envelope { body: Some(body) }.encode_to_vec().into());
    sink.send(send(Body::Challenge(Challenge {
        nonce: NONCE.to_vec(),
    })))
    .await
    .unwrap();
    loop {
        tokio::select! {
            msg = stream.next() => {
                let Some(Ok(Message::Binary(bytes))) = msg else { return };
                let Ok(env) = Envelope::decode(bytes.as_ref()) else { return };
                match env.body {
                    Some(Body::Hello(h)) => {
                        let _ = seen.send(Seen::Hello(h));
                        let welcome = Welcome { server_time_ms: 0, heartbeat_interval_seconds: 5, forget_task_ids: vec![] };
                        if sink.send(send(Body::Welcome(welcome))).await.is_err() { return }
                    }
                    Some(Body::Heartbeat(_)) => {
                        if sink.send(send(Body::HeartbeatAck(HeartbeatAck {}))).await.is_err() { return }
                    }
                    Some(Body::TaskEvent(ev)) => {
                        let ack = EventAck { task_id: ev.task_id.clone(), seq: ev.seq };
                        let _ = seen.send(Seen::Event(ev));
                        if sink.send(send(Body::EventAck(ack))).await.is_err() { return }
                    }
                    Some(Body::Inventory(inv)) => { let _ = seen.send(Seen::Inventory(inv)); }
                    Some(Body::RepoChangeResult(r)) => { let _ = seen.send(Seen::RepoChangeResult(r)); }
                    _ => {}
                }
            }
            cmd = cmds.recv() => {
                let Some(body) = cmd else { return };
                if sink.send(send(body)).await.is_err() { return }
            }
        }
    }
}

/// The sandbox process, with its stdout collected.
struct Sandbox {
    child: tokio::process::Child,
    logs: Arc<Mutex<Vec<String>>>,
    container: Option<String>,
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        if let Some(name) = &self.container {
            let _ = std::process::Command::new("docker")
                .args(["rm", "-f", name])
                .output();
        }
    }
}

impl Sandbox {
    fn start(root: &Path, vars: &[(&str, String)]) -> Sandbox {
        match docker_image() {
            Some(image) => Sandbox::start_in_docker(root, vars, &image),
            None => Sandbox::start_local(root, vars),
        }
    }

    fn start_local(root: &Path, vars: &[(&str, String)]) -> Sandbox {
        let user_home = root.join("user-home");
        std::fs::create_dir_all(&user_home).unwrap();
        let mut cmd = tokio::process::Command::new(RUNNER);
        cmd.arg("sandbox")
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap())
            // A clean home, so this machine's git settings (such as commit
            // signing) don't apply.
            .env("HOME", &user_home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("FAKE_CODEX_DELAY_MS", "1")
            .envs(vars.iter().map(|(k, v)| (*k, v.as_str())));
        Sandbox::spawn(cmd, None)
    }

    fn start_in_docker(root: &Path, vars: &[(&str, String)], image: &str) -> Sandbox {
        let codex = root.join("shell-codex.sh");
        std::fs::write(&codex, SHELL_CODEX).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut suffix = [0u8; 4];
        getrandom::fill(&mut suffix).unwrap();
        let name = format!(
            "sling-sandbox-test-{}",
            suffix
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let mount = format!("{0}:{0}", root.display());
        // The clones go to /workspace. Mounting it keeps them after the
        // container is gone, so the test can check them.
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let workspace = format!("{}:/workspace", workspace.display());
        let mut cmd = tokio::process::Command::new("docker");
        cmd.args(["run", "--rm", "--init", "--name", &name]);
        cmd.args(["-v", &mount, "-v", &workspace]);
        for (k, v) in vars {
            let v = match *k {
                "SLING_CODEX_BIN" => codex.display().to_string(),
                _ => v.clone(),
            };
            cmd.arg("-e").arg(format!("{k}={v}"));
        }
        cmd.arg(image);
        Sandbox::spawn(cmd, Some(name))
    }

    fn spawn(mut cmd: tokio::process::Command, container: Option<String>) -> Sandbox {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().unwrap();
        let logs = Arc::new(Mutex::new(Vec::new()));
        for out in [
            Box::new(child.stdout.take().unwrap()) as Box<dyn tokio::io::AsyncRead + Send + Unpin>,
            Box::new(child.stderr.take().unwrap()),
        ] {
            let logs = logs.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("sandbox | {line}");
                    logs.lock().unwrap().push(line);
                }
            });
        }
        Sandbox {
            child,
            logs,
            container,
        }
    }

    async fn exit_code(&mut self, within: Duration) -> Option<i32> {
        tokio::time::timeout(within, self.child.wait())
            .await
            .expect("the sandbox didn't exit in time")
            .unwrap()
            .code()
    }

    fn log_text(&self) -> String {
        self.logs.lock().unwrap().join("\n")
    }
}

fn repos_json(clone_url: &str) -> String {
    serde_json::json!([{
        "name": "site",
        "cloneUrl": clone_url,
        "defaultBranch": "main",
        "network": false,
    }])
    .to_string()
}

fn base_vars(stub_url: &str, remote: &Path, home: &Path) -> Vec<(&'static str, String)> {
    vec![
        ("SLING_URL", stub_url.to_string()),
        ("SLING_PAIR_CODE", PAIR_CODE.into()),
        ("SLING_SANDBOX_ID", "sbx_test01".into()),
        (
            "SLING_REPOS",
            repos_json(&format!("file://{}", remote.display())),
        ),
        ("SLING_HARNESSES", "codex".into()),
        ("SLING_MAX_MODE", "full-access".into()),
        ("SLING_IDLE_EXIT_SECONDS", "120".into()),
        ("SLING_CODEX_BIN", fake_codex().display().to_string()),
        ("SLING_RUNNER_HOME", home.display().to_string()),
    ]
}

/// Every file under `dir` that contains `needle`.
fn files_containing(dir: &Path, needle: &[u8]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            out.extend(files_containing(&path, needle));
        } else if meta.is_file()
            && let Ok(bytes) = std::fs::read(&path)
            && bytes.windows(needle.len()).any(|w| w == needle)
        {
            out.push(path);
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn boots_runs_a_task_pushes_and_exits_when_revoked() {
    let (_dir, root) = test_dir();
    let root = root.as_path();
    let remote = bare_repo(root);
    let home = root.join("sandbox-home");
    let mut stub = Stub::start().await;
    let mut vars = base_vars(&stub.url, &remote, &home);
    vars.push(("SLING_GIT_TOKEN", GIT_TOKEN.into()));
    vars.push(("OPENAI_API_KEY", OPENAI_KEY.into()));

    let started = Instant::now();
    let mut sandbox = Sandbox::start(root, &vars);

    // It pairs with the code, under the sandbox's name.
    let Seen::Paired(req) = stub.next().await else {
        panic!("expected a pairing request")
    };
    assert_eq!(req["code"], PAIR_CODE);
    assert_eq!(req["name"], "sandbox-sbx_test01");
    let key = base64::engine::general_purpose::STANDARD
        .decode(req["publicKey"].as_str().unwrap())
        .unwrap();
    let key = VerifyingKey::from_bytes(&key.try_into().unwrap()).unwrap();

    // It connects with the identity it paired with, and advertises the clone.
    let Seen::Hello(hello) = stub.next().await else {
        panic!("expected a hello")
    };
    eprintln!("booted and connected in {:?}", started.elapsed());
    assert_eq!(hello.runner_id, "rnr_sandbox_test");
    let signature = Signature::from_slice(&hello.signature).unwrap();
    key.verify(
        &auth_payload(&NONCE, &hello.runner_id, hello.timestamp_ms),
        &signature,
    )
    .expect("the hello is signed with the paired key");
    let inv = hello.inventory.unwrap();
    assert_eq!(inv.repos.len(), 1);
    assert_eq!(inv.repos[0].name, "site");
    assert_eq!(inv.repos[0].default_branch, "main");
    assert_eq!(
        inv.repos[0].remote_url,
        format!("file://{}", remote.display())
    );
    assert!(!inv.repos[0].network);
    assert_eq!(inv.max_concurrent_tasks, 1);
    assert_eq!(inv.max_mode(), PermissionMode::FullAccess);
    assert!(inv.labels.iter().any(|l| l.starts_with("os:")));
    let codex = inv
        .capabilities
        .iter()
        .find(|c| c.name == "coding.codex")
        .unwrap();
    assert!(codex.ready, "{codex:?}");
    // A sandbox works only in the repos it was given.
    assert!(!inv.remote_repos);
    assert!(inv.found_repos.is_empty());
    stub.send(Body::RepoChange(RepoChange {
        request_id: "rc_sbx".into(),
        op: repo_change::Op::Add as i32,
        path: root.display().to_string(),
        name: String::new(),
    }));
    let result = loop {
        if let Seen::RepoChangeResult(r) = stub.next().await {
            break r;
        }
    };
    assert_eq!(result.request_id, "rc_sbx");
    assert!(!result.ok);
    assert!(
        result.message.contains("remote-repos"),
        "{}",
        result.message
    );
    stub.send(Body::RepoScan(RepoScan {}));
    let rescanned = loop {
        if let Seen::Inventory(i) = stub.next().await {
            break i;
        }
    };
    assert!(!rescanned.remote_repos && rescanned.found_repos.is_empty());
    assert_eq!(rescanned.repos.len(), 1);

    // It runs the task and commits.
    stub.send(Body::TaskAssign(TaskAssign {
        task_id: "tsk_sbx1".into(),
        repo: "site".into(),
        title: "Add a line".into(),
        objective: "[fake:env] Update the fake file.".into(),
        mode: PermissionMode::Auto as i32,
        harness: "codex".into(),
        branch: "sling/sbx1-add-a-line".into(),
        ..Default::default()
    }));
    let mut events = Vec::new();
    let finished = loop {
        let ev = stub.next_event().await;
        if let Some(Kind::Finished(f)) = &ev.kind {
            break f.clone();
        }
        events.push(ev);
    };
    assert_eq!(
        finished.outcome(),
        task_finished::Outcome::Succeeded,
        "{finished:?}"
    );
    assert!(!finished.commit_sha.is_empty());
    let seen_env = events
        .iter()
        .find_map(|e| match &e.kind {
            Some(Kind::AgentMessage(m)) if m.text.starts_with("Sensitive environment") => {
                Some(m.text.clone())
            }
            _ => None,
        })
        .expect("fake-codex reports its environment");
    assert_eq!(
        seen_env, "Sensitive environment: []",
        "no SLING_* variables, tokens, or the API key Codex was logged in with"
    );

    // It pushes the branch to the bare repo.
    stub.send(Body::ActionRequest(ActionRequest {
        action_id: "act_1".into(),
        task_id: "tsk_sbx1".into(),
        kind: action_request::Kind::Push as i32,
        ..Default::default()
    }));
    let result = loop {
        if let Some(Kind::ActionResult(r)) = stub.next_event().await.kind {
            break r;
        }
    };
    assert_eq!(
        result.outcome(),
        action_result::Outcome::Succeeded,
        "{result:?}"
    );
    assert_eq!(
        git(&remote, &["rev-parse", "refs/heads/sling/sbx1-add-a-line"]),
        finished.commit_sha
    );

    // Revoking it is how the control plane tears it down.
    stub.send(Body::Error(sling_runner_protocol::Error {
        code: error::Code::Revoked as i32,
        message: "sandbox destroyed".into(),
    }));
    assert_eq!(sandbox.exit_code(Duration::from_secs(20)).await, Some(0));
    assert!(
        !root.join("user-home/.sling-sandbox-sbx_test01").exists(),
        "the Codex home made for the API key is removed"
    );

    // The token never landed on disk or in the log.
    let clone = match docker_image() {
        Some(_) => root.join("workspace/site"),
        None => home.join("workspace/site"),
    };
    let git_config = std::fs::read_to_string(clone.join(".git/config")).unwrap();
    assert!(!git_config.contains(GIT_TOKEN));
    assert!(git_config.contains(&format!("file://{}", remote.display())));
    assert!(home.join("data/spool/tsk_sbx1/events.bin").exists());
    assert_eq!(
        files_containing(&home, GIT_TOKEN.as_bytes()),
        Vec::<PathBuf>::new()
    );
    assert_eq!(
        files_containing(&home, OPENAI_KEY.as_bytes()),
        Vec::<PathBuf>::new()
    );
    let logs = sandbox.log_text();
    assert!(!logs.contains(GIT_TOKEN));
    assert!(!logs.contains(OPENAI_KEY));
    assert!(
        logs.contains("Codex: logged in with OPENAI_API_KEY"),
        "{logs}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn exits_when_idle() {
    let (_dir, root) = test_dir();
    let root = root.as_path();
    let remote = bare_repo(root);
    let mut stub = Stub::start().await;
    let mut vars = base_vars(&stub.url, &remote, &root.join("home"));
    vars.retain(|(k, _)| *k != "SLING_IDLE_EXIT_SECONDS");
    vars.push(("SLING_IDLE_EXIT_SECONDS", "2".into()));
    let mut sandbox = Sandbox::start(root, &vars);
    assert!(matches!(stub.next().await, Seen::Paired(_)));
    assert!(matches!(stub.next().await, Seen::Hello(_)));
    let connected = Instant::now();
    assert_eq!(sandbox.exit_code(Duration::from_secs(20)).await, Some(0));
    assert!(connected.elapsed() >= Duration::from_secs(1));
    assert!(sandbox.log_text().contains("no task for 2s"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_variable_fails_the_boot() {
    let (_dir, root) = test_dir();
    let root = root.as_path();
    let remote = bare_repo(root);
    let mut vars = base_vars("http://127.0.0.1:9", &remote, &root.join("home"));
    vars.retain(|(k, _)| *k != "SLING_PAIR_CODE");
    let mut sandbox = Sandbox::start(root, &vars);
    assert_eq!(sandbox.exit_code(Duration::from_secs(20)).await, Some(2));
    assert!(sandbox.log_text().contains("SLING_PAIR_CODE is not set"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_clone_fails_the_boot() {
    let (_dir, root) = test_dir();
    let root = root.as_path();
    let mut vars = base_vars(
        "http://127.0.0.1:9",
        &root.join("missing.git"),
        &root.join("home"),
    );
    vars.push(("SLING_GIT_TOKEN", GIT_TOKEN.into()));
    let mut sandbox = Sandbox::start(root, &vars);
    assert_eq!(sandbox.exit_code(Duration::from_secs(30)).await, Some(3));
    let logs = sandbox.log_text();
    assert!(logs.contains("cloning site from"), "{logs}");
    assert!(!logs.contains(GIT_TOKEN));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_pairing_fails_the_boot() {
    let (_dir, root) = test_dir();
    let root = root.as_path();
    let remote = bare_repo(root);
    // Nothing listens on this port.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let vars = base_vars(
        &format!("http://127.0.0.1:{port}"),
        &remote,
        &root.join("home"),
    );
    let mut sandbox = Sandbox::start(root, &vars);
    assert_eq!(sandbox.exit_code(Duration::from_secs(60)).await, Some(4));
}

#[test]
fn git_uses_the_helper_for_https_only() {
    let dir = tempfile::tempdir().unwrap();
    let helper = format!("!'{RUNNER}' git-credential");
    let fill = |protocol: &str, host: &str| {
        let mut child = std::process::Command::new("git")
            .args(["credential", "fill"])
            .env("HOME", dir.path())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "")
            .env("GIT_CONFIG_COUNT", "2")
            .env("GIT_CONFIG_KEY_0", "credential.helper")
            .env("GIT_CONFIG_VALUE_0", "")
            .env("GIT_CONFIG_KEY_1", "credential.helper")
            .env("GIT_CONFIG_VALUE_1", &helper)
            .env("SLING_GIT_TOKEN", GIT_TOKEN)
            .env(
                "SLING_REPOS",
                repos_json("https://github.com/acme/site.git"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(format!("protocol={protocol}\nhost={host}\n\n").as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let reply = fill("https", "github.com");
    assert!(reply.contains(&format!("password={GIT_TOKEN}")), "{reply}");
    assert!(reply.contains("username=x-access-token"));
    assert!(!fill("https", "evil.example").contains(GIT_TOKEN));
    assert!(!fill("http", "github.com").contains(GIT_TOKEN));
}
