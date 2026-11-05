//! Parser tests on stream-json captured from real Claude Code 2.1.318 runs.
//! Paths and personal details in the captures were replaced.

use sling_harness_claude_code::{Event, Outcome, Parser};
use sling_runner_protocol::{command_run, file_change, task_event::Kind};

fn parse(name: &str) -> (Vec<Event>, Outcome) {
    let path = format!(
        "{}/tests/transcripts/{name}.jsonl",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(path).unwrap();
    let mut p = Parser::default();
    let events = text.lines().flat_map(|l| p.line(l)).collect();
    (events, p.outcome(Some(0)))
}

fn kinds(events: &[Event]) -> Vec<&Kind> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::Task(k) => Some(k),
            _ => None,
        })
        .collect()
}

fn commands(events: &[Event]) -> Vec<&sling_runner_protocol::CommandRun> {
    kinds(events)
        .into_iter()
        .filter_map(|k| match k {
            Kind::Command(c) => Some(c),
            _ => None,
        })
        .collect()
}

fn file_changes(events: &[Event]) -> Vec<(String, file_change::Kind)> {
    kinds(events)
        .into_iter()
        .filter_map(|k| match k {
            Kind::FileChange(f) => Some(f),
            _ => None,
        })
        .flat_map(|f| f.changes.iter().map(|c| (c.path.clone(), c.kind())))
        .collect()
}

fn logs(events: &[Event]) -> Vec<String> {
    kinds(events)
        .into_iter()
        .filter_map(|k| match k {
            Kind::Log(l) => Some(l.text.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn plan_mode_read() {
    let (events, outcome) = parse("plan-read");
    assert!(matches!(
        &events[0],
        Event::SessionStarted { session_id, .. } if session_id == "2aae4c1c-d372-4cb0-9397-8f823850baff"
    ));
    assert!(file_changes(&events).is_empty());
    assert!(commands(&events).is_empty(), "Read is not a command");
    assert!(outcome.failure.is_none());
    assert!(outcome.summary.contains("tiny repo"));
    let usage = kinds(&events)
        .into_iter()
        .find_map(|k| match k {
            Kind::Usage(u) => Some(*u),
            _ => None,
        })
        .unwrap();
    // input + cache creation + cache reads
    assert_eq!(usage.input_tokens, 4 + 16169 + 49733);
    assert_eq!(usage.cached_input_tokens, 49733);
    assert_eq!(usage.output_tokens, 161);
}

#[test]
fn accept_edits_in_the_sandbox() {
    let (events, outcome) = parse("accept-edits-sandboxed");
    assert_eq!(
        file_changes(&events),
        vec![
            ("/work/repo/hello.txt".to_string(), file_change::Kind::Add),
            ("/work/repo/calc.py".to_string(), file_change::Kind::Modify),
        ],
        "the denied write outside the repo is not reported"
    );

    let cmds = commands(&events);
    let done: Vec<_> = cmds
        .iter()
        .filter(|c| c.status() != command_run::Status::Started)
        .collect();
    assert_eq!(done.len(), 4);
    assert_eq!(done[0].status(), command_run::Status::Completed);
    assert_eq!(done[0].output, "2");
    assert_eq!(done[0].exit_code, Some(0));
    // Writing to $HOME from Bash is blocked by the sandbox.
    assert_eq!(done[1].status(), command_run::Status::Failed);
    assert_eq!(done[1].exit_code, Some(1));
    assert!(done[1].output.contains("operation not permitted"));
    // So is the network.
    assert_eq!(done[2].exit_code, Some(56));
    assert!(done[2].output.contains("deny network-outbound"));
    // Reads outside the repo are not blocked.
    assert_eq!(done[3].status(), command_run::Status::Completed);

    let logs = logs(&events);
    assert!(
        logs.iter()
            .any(|l| l.contains("not allowed to use Write") && l.contains("outside allowed")),
        "{logs:?}"
    );
    assert!(
        logs.iter()
            .any(|l| l.contains("denied 1 tool call(s): Write"))
    );
    assert!(outcome.failure.is_none());
    assert!(
        outcome
            .summary
            .starts_with("Three of the seven steps worked")
    );
}

#[test]
fn full_access_overwrite_is_a_modify() {
    let (events, outcome) = parse("full-access");
    assert_eq!(
        file_changes(&events),
        vec![(
            "/work/repo/README.md".to_string(),
            file_change::Kind::Modify
        )]
    );
    let done: Vec<_> = commands(&events)
        .into_iter()
        .filter(|c| c.status() == command_run::Status::Completed)
        .collect();
    assert_eq!(done.len(), 2);
    assert_eq!(done[0].output, "200");
    assert!(outcome.failure.is_none());
}

#[test]
fn an_interrupted_run_reports_an_error_result() {
    let (events, outcome) = parse("cancelled");
    let cmds = commands(&events);
    assert_eq!(cmds.last().unwrap().status(), command_run::Status::Failed);
    assert_eq!(cmds.last().unwrap().exit_code, None);
    assert!(outcome.failure.unwrap().contains("ede_diagnostic"));
}

#[test]
fn an_invalid_api_key_is_a_failure() {
    let (events, outcome) = parse("invalid-api-key");
    assert_eq!(
        outcome.failure.as_deref(),
        Some("Invalid API key · Fix external API key")
    );
    assert!(logs(&events).iter().any(|l| l.contains("Invalid API key")));
}
