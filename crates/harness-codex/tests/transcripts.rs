//! Parser tests on `codex exec --json` output from real Codex 0.166.0
//! talking to a local stand-in for the model API, so the events are Codex's
//! own and the model's words are the stand-in's.

use sling_harness_codex::chat::ChatParser;
use sling_runner_protocol::chat_event::Kind;

#[test]
fn chat_turn_that_calls_a_sling_tool() {
    let path = format!(
        "{}/tests/transcripts/chat-tool.jsonl",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(path).unwrap();
    let mut p = ChatParser::default();
    let events: Vec<Kind> = text.lines().flat_map(|l| p.line(l)).collect();
    let tools: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            Kind::ToolUse(t) => Some(t.name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        tools,
        ["list_machines"],
        "once, though it starts and completes"
    );
    let deltas: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            Kind::Delta(d) => Some(d.text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas.len(), 1, "warnings aren't reply text: {deltas:?}");
    assert!(deltas[0].starts_with("Tool said: "));
    assert!(deltas[0].contains("You have 2 machines: laptop, desktop."));
    let o = p.outcome(Some(0), &[]);
    assert_eq!(o.text, deltas[0]);
    assert_eq!(o.session_id, "01a1ad9f-9d0e-7ee1-87ec-cdbfe6bf3b6f");
    assert_eq!((o.input_tokens, o.output_tokens), (40, 14));
    assert!(o.failure.is_none() && !o.session_missing);
}
