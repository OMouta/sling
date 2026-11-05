//! Generated types for the Runner protocol, plus the few helpers both sides
//! must agree on byte for byte. The source of truth is
//! `packages/runner-protocol/proto/sling/runner/v1/runner.proto`.

pub mod v1 {
    #![allow(clippy::all)]
    include!(concat!(env!("OUT_DIR"), "/sling.runner.v1.rs"));
}

pub use prost::Message;
pub use v1::*;

/// WebSocket path the Runner connects to.
pub const RUNNER_WS_PATH: &str = "/runner/v1/ws";

/// Bytes the Runner signs in `Hello`. Must match `authPayload` in the TS package.
pub fn auth_payload(nonce: &[u8], runner_id: &str, timestamp_ms: i64) -> Vec<u8> {
    let mut hex = String::with_capacity(nonce.len() * 2);
    for b in nonce {
        hex.push_str(&format!("{b:02x}"));
    }
    format!("sling-runner-auth-v1\n{hex}\n{runner_id}\n{timestamp_ms}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        let path = format!(
            "{}/../../packages/runner-protocol/fixtures/{name}.bin",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read(path).expect("fixture exists")
    }

    #[test]
    fn auth_payload_format() {
        let p = auth_payload(&[0xab, 0x01], "rnr_01", 1234);
        assert_eq!(p, b"sling-runner-auth-v1\nab01\nrnr_01\n1234");
    }

    #[test]
    fn decodes_and_reencodes_hello_fixture() {
        let bytes = fixture("hello");
        let env = Envelope::decode(bytes.as_slice()).unwrap();
        let Some(envelope::Body::Hello(hello)) = &env.body else {
            panic!("expected hello");
        };
        assert_eq!(hello.runner_id, "rnr_01");
        assert_eq!(hello.timestamp_ms, 1_767_225_600_000);
        let inv = hello.inventory.as_ref().unwrap();
        assert_eq!(inv.max_mode(), PermissionMode::Auto);
        assert_eq!(inv.capabilities[0].name, "coding.codex");
        assert_eq!(inv.repos[0].default_branch, "main");
        assert_eq!(hello.held_tasks[0].last_seq, 7);
        assert_eq!(env.encode_to_vec(), bytes);
    }

    #[test]
    fn decodes_and_reencodes_task_finished_fixture() {
        let bytes = fixture("taskFinished");
        let env = Envelope::decode(bytes.as_slice()).unwrap();
        let Some(envelope::Body::TaskEvent(ev)) = &env.body else {
            panic!("expected task event");
        };
        assert_eq!(ev.seq, 8);
        let Some(task_event::Kind::Finished(fin)) = &ev.kind else {
            panic!("expected finished");
        };
        assert_eq!(fin.outcome(), task_finished::Outcome::Succeeded);
        assert_eq!(fin.diff_stats.as_ref().unwrap().insertions, 14);
        assert_eq!(env.encode_to_vec(), bytes);
    }
}
