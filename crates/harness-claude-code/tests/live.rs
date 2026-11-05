//! Runs the real `claude` with the flags and settings this crate builds.
//! Uses your Claude Code login, so it only runs when asked:
//!
//! ```sh
//! SLING_LIVE_CLAUDE=1 cargo test -p sling-harness-claude-code --test live -- --ignored --nocapture
//! ```

use sling_harness_claude_code::{Access, Event, Outcome, Run, RunOptions, detect};
use sling_runner_protocol::{CommandRun, command_run, task_event::Kind};
use tokio::sync::mpsc;

fn bin() -> String {
    std::env::var("SLING_CLAUDE_BIN").unwrap_or_else(|_| "claude".into())
}

fn repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        assert!(
            std::process::Command::new("git")
                .args(["-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .current_dir(dir.path())
                .status()
                .unwrap()
                .success()
        )
    };
    git(&["init", "-q", "-b", "main"]);
    std::fs::write(dir.path().join("README.md"), "# demo\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "init"]);
    dir
}

async fn run(
    dir: &std::path::Path,
    access: Access,
    network: bool,
    prompt: &str,
) -> (Vec<Kind>, Outcome) {
    let (tx, mut rx) = mpsc::channel(256);
    let opts = RunOptions {
        bin: bin(),
        cwd: dir.to_path_buf(),
        prompt: prompt.into(),
        access,
        network,
        env: None,
        model: None,
        effort: None,
    };
    let (mut run, reader) = Run::start(&opts, tx).await.unwrap();
    let mut kinds = Vec::new();
    while let Some(ev) = rx.recv().await {
        if let Event::Task(k) = ev {
            kinds.push(k);
        }
    }
    let code = run.wait().await.unwrap();
    let outcome = reader.finish(code).await;
    (kinds, outcome)
}

fn finished_commands(kinds: &[Kind]) -> Vec<CommandRun> {
    kinds
        .iter()
        .filter_map(|k| match k {
            Kind::Command(c) if c.status() != command_run::Status::Started => Some(c.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
#[ignore = "runs the real Claude Code"]
async fn real_claude_code_follows_each_mode() {
    if std::env::var_os("SLING_LIVE_CLAUDE").is_none() {
        eprintln!("set SLING_LIVE_CLAUDE=1 to run");
        return;
    }
    let d = detect(&bin()).await;
    assert!(d.ready(), "{d:?}");

    // Supervised and Auto, network off.
    let dir = repo();
    let (kinds, outcome) = run(
        dir.path(),
        Access::Edit,
        false,
        "Integration test. Use exactly these tools, once each, in order, and do not retry another way:\n\
         1. Write tool: create notes.txt containing \"hi\".\n\
         2. Bash: python3 -c 'print(6*7)'\n\
         3. Bash: curl -sS -m 8 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/\n\
         Then reply with one line per step.",
    )
    .await;
    eprintln!("edit, no network: {kinds:#?}");
    assert!(outcome.failure.is_none(), "{:?}", outcome.failure);
    assert!(dir.path().join("notes.txt").exists());
    let cmds = finished_commands(&kinds);
    assert!(
        cmds.iter().any(|c| c.output.trim() == "42"),
        "sandboxed Bash runs"
    );
    assert!(
        cmds.iter()
            .any(|c| c.command.contains("curl") && c.status() == command_run::Status::Failed),
        "network is blocked"
    );

    // The same with the repo's network allowed.
    let (kinds, outcome) = run(
        dir.path(),
        Access::Edit,
        true,
        "Integration test. Use Bash once to run: curl -sS -m 8 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/\nReply with the output.",
    )
    .await;
    eprintln!("edit, network: {kinds:#?}");
    assert!(outcome.failure.is_none(), "{:?}", outcome.failure);
    assert!(
        finished_commands(&kinds)
            .iter()
            .any(|c| c.output.trim() == "200"),
        "the registry is reachable"
    );

    // Read-only.
    let (kinds, outcome) = run(
        dir.path(),
        Access::ReadOnly,
        false,
        "Integration test. Use Bash to run `git log --oneline`, then use Bash to run `touch probe.txt`. Reply with what happened.",
    )
    .await;
    eprintln!("read-only: {kinds:#?}");
    assert!(outcome.failure.is_none(), "{:?}", outcome.failure);
    assert!(!dir.path().join("probe.txt").exists());
}
