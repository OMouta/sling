use std::time::Instant;

use super::*;

fn request(command: &str, sandboxed: bool, mode: PermissionMode) -> ExecRequest {
    ExecRequest {
        request_id: "exe_1".into(),
        command: command.into(),
        cwd: String::new(),
        timeout_seconds: 10,
        mode: mode as i32,
        sandboxed,
    }
}

async fn run_here(r: &ExecRequest, dir: &Path, sandbox: &Sandbox) -> ExecResult {
    let (tx, _rx) = mpsc::channel(4);
    run(r, dir, sandbox, crate::agent_env::for_agent(&[]), &tx).await
}

#[test]
fn keeps_the_start_and_the_end_of_long_output() {
    let mut c = Capture::default();
    c.push(b"short");
    assert_eq!(c.text(), "short");
    assert!(!c.truncated());

    let mut c = Capture::default();
    c.push(&vec![b'a'; HEAD_BYTES]);
    c.push(&vec![b'b'; 100_000]);
    c.push(b"END");
    assert!(c.truncated());
    let text = c.text();
    assert!(text.starts_with("aaaa"));
    assert!(text.ends_with("bbbEND"));
    assert!(text.contains("bytes cut"));
    assert!(text.len() < HEAD_BYTES + TAIL_BYTES + 100);
}

#[test]
fn resolves_working_directories() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("Desktop")).unwrap();
    let h = Some(home.path());
    assert_eq!(resolve_cwd("", h).unwrap(), home.path());
    assert_eq!(resolve_cwd("~", h).unwrap(), home.path());
    assert_eq!(
        resolve_cwd("~/Desktop", h).unwrap(),
        home.path().join("Desktop")
    );
    assert!(resolve_cwd("Desktop", h).unwrap_err().contains("absolute"));
    assert!(
        resolve_cwd("~/Nope", h)
            .unwrap_err()
            .contains("isn't a directory")
    );
    assert!(resolve_cwd("", None).is_err());
}

#[test]
fn leaves_the_sandbox_only_at_full_access() {
    let full = Config {
        max_mode: Mode::FullAccess,
        ..Config::default()
    };
    let capped = Config {
        max_mode: Mode::Auto,
        ..Config::default()
    };
    let off = Config {
        commands: false,
        ..full.clone()
    };
    let have = Sandbox::Seatbelt;
    let none = Sandbox::Missing("no bwrap".into());

    let sandboxed = request("ls", true, PermissionMode::ReadOnly);
    assert_eq!(refusal(&sandboxed, &full, &have), None);
    assert_eq!(refusal(&sandboxed, &capped, &have), None);
    assert!(
        refusal(&sandboxed, &full, &none)
            .unwrap()
            .contains("no bwrap")
    );
    assert!(refusal(&sandboxed, &off, &have).unwrap().contains("off"));

    let outside = request("touch x", false, PermissionMode::Auto);
    assert_eq!(refusal(&outside, &full, &none), None);
    assert!(
        refusal(&outside, &capped, &have)
            .unwrap()
            .contains("max-mode is auto")
    );
    let read_only = request("touch x", false, PermissionMode::ReadOnly);
    assert!(
        refusal(&read_only, &full, &have)
            .unwrap()
            .contains("Read-only")
    );
    let unknown = ExecRequest {
        mode: 99,
        ..outside.clone()
    };
    assert!(
        refusal(&unknown, &full, &have).is_some(),
        "unknown modes are read-only"
    );

    assert!(refusal(&request(" ", true, PermissionMode::Auto), &full, &have).is_some());
    assert!(refusal(&request("a\0b", true, PermissionMode::Auto), &full, &have).is_some());
}

#[tokio::test]
async fn runs_a_command_and_keeps_both_streams() {
    let dir = tempfile::tempdir().unwrap();
    let r = request(
        "echo out; echo err >&2; pwd; exit 3",
        false,
        PermissionMode::FullAccess,
    );
    let res = run_here(&r, dir.path(), &Sandbox::Missing(String::new())).await;
    assert_eq!(res.exit_code, Some(3));
    assert!(res.error.is_empty(), "{}", res.error);
    assert!(res.output.contains("out\n"));
    assert!(res.output.contains("err\n"));
    let real = dir.path().canonicalize().unwrap();
    assert!(
        res.output.contains(real.to_str().unwrap()),
        "{}",
        res.output
    );
    assert!(!res.timed_out);
    assert_eq!(res.cwd, dir.path().display().to_string());
}

#[tokio::test]
async fn stops_a_command_that_runs_too_long() {
    let dir = tempfile::tempdir().unwrap();
    let mut r = request("echo started; sleep 30", false, PermissionMode::FullAccess);
    r.timeout_seconds = 1;
    let t = Instant::now();
    let res = run_here(&r, dir.path(), &Sandbox::Missing(String::new())).await;
    assert!(res.timed_out);
    assert_eq!(res.exit_code, None);
    assert!(res.output.contains("started"));
    assert!(t.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn does_not_wait_for_processes_left_behind() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("still-running");
    let r = request(
        &format!("(sleep 3; touch '{}') & echo bg", marker.display()),
        false,
        PermissionMode::FullAccess,
    );
    let t = Instant::now();
    let res = run_here(&r, dir.path(), &Sandbox::Missing(String::new())).await;
    assert_eq!(res.exit_code, Some(0));
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(!marker.exists(), "the leftover process was stopped");
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn the_sandbox_reads_but_never_writes() {
    let sandbox = detect_sandbox().await;
    assert_eq!(sandbox, Sandbox::Seatbelt);
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("note.txt"), "hello from a file").unwrap();
    let r = request(
        "cat note.txt; echo; touch made.txt; echo touched=$?; echo hidden 2>/dev/null",
        true,
        PermissionMode::ReadOnly,
    );
    let res = run_here(&r, dir.path(), &sandbox).await;
    assert_eq!(res.exit_code, Some(0), "{}", res.output);
    assert!(res.output.contains("hello from a file"));
    assert!(res.output.contains("touched=1"), "{}", res.output);
    assert!(res.output.contains("hidden"));
    assert!(!dir.path().join("made.txt").exists());
    assert!(res.sandboxed);
}
