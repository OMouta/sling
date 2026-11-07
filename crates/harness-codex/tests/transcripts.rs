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

#[test]
fn chat_turn_that_searches_the_web() {
    let path = format!(
        "{}/tests/transcripts/chat-web.jsonl",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(path).unwrap();
    let mut p = ChatParser::default();
    let events: Vec<Kind> = text.lines().flat_map(|l| p.line(l)).collect();
    let uses: Vec<(&str, &str, bool)> = events
        .iter()
        .filter_map(|e| match e {
            Kind::ToolUse(t) => Some((t.name.as_str(), t.input_json.as_str(), t.builtin)),
            _ => None,
        })
        .collect();
    assert_eq!(
        uses,
        [(
            "web_search",
            r#"{"query":"current stable Rust version official"}"#,
            true
        )],
        "the empty started item isn't a step"
    );
    let results: Vec<serde_json::Value> = events
        .iter()
        .filter_map(|e| match e {
            Kind::ToolResult(r) => Some(serde_json::from_str(&r.output).unwrap()),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["results"].as_array().unwrap().len(), 4);
    assert_eq!(
        results[0]["results"][2],
        serde_json::json!({ "title": "Rust Versions | Rust Changelogs", "url": "https://releases.rs/" })
    );
    let o = p.outcome(Some(0), &[]);
    assert_eq!(
        o.text,
        "1.99.1 ([official Rust website](https://rust-lang.org/))"
    );
    assert_eq!(o.session_id, "01a1b761-0cb1-7081-95eb-ead27e815e43");
}
