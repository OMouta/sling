use super::*;
use sling_runner_protocol::{LogLine, TaskAccepted};

fn meta(id: &str) -> TaskMeta {
    TaskMeta {
        task_id: id.into(),
        repo: "site".into(),
        title: "t".into(),
        objective: "o".into(),
        mode: Mode::Auto,
        harness: "codex".into(),
        branch: "sling/x".into(),
        default_branch: "main".into(),
        worktree: None,
        base_sha: None,
        harness_pid: None,
        state: SpoolState::Running,
        created_ms: 0,
    }
}

fn log(text: &str) -> Kind {
    Kind::Log(LogLine {
        stream: 1,
        text: text.into(),
    })
}

#[test]
fn replay_is_batched_and_acknowledged_history_is_not_retained() {
    let root = tempfile::tempdir().unwrap();
    let mut s = TaskSpool::create(root.path(), meta("batch")).unwrap();
    for _ in 0..300 {
        s.append(log("line")).unwrap();
    }
    s.ack(100).unwrap();
    drop(s);
    let mut s = TaskSpool::open(&root.path().join("batch")).unwrap();
    let first = s.unsent();
    assert_eq!(first.len(), 128);
    assert_eq!(first[0].seq, 101);
    assert_eq!(s.unsent().len(), 72);
    assert!(s.unsent().is_empty());
    s.reset_sent();
    assert_eq!(s.unsent()[0].seq, 101);
}

#[test]
fn events_survive_reopen_until_acked() {
    let root = tempfile::tempdir().unwrap();
    let mut s = TaskSpool::create(root.path(), meta("tsk_1")).unwrap();
    s.append(Kind::Accepted(TaskAccepted {})).unwrap();
    s.append(log("a")).unwrap();
    s.append(log("b")).unwrap();
    assert_eq!(s.unsent().len(), 3);
    assert!(s.unsent().is_empty());
    s.ack(2).unwrap();
    drop(s);

    let mut s = TaskSpool::open(&root.path().join("tsk_1")).unwrap();
    assert_eq!(s.last_seq(), 3);
    let unsent = s.unsent();
    assert_eq!(unsent.len(), 1);
    assert_eq!(unsent[0].seq, 3);
    let e = s.append(log("c")).unwrap();
    assert_eq!(e.seq, 4);
}

#[test]
fn a_torn_write_is_dropped() {
    let root = tempfile::tempdir().unwrap();
    let mut s = TaskSpool::create(root.path(), meta("tsk_2")).unwrap();
    s.append(log("whole")).unwrap();
    drop(s);
    let path = root.path().join("tsk_2/events.bin");
    let mut f = OpenOptions::new().append(true).open(&path).unwrap();
    f.write_all(&[0x40, 0x01, 0x02]).unwrap();
    drop(f);
    let mut s = TaskSpool::open(&root.path().join("tsk_2")).unwrap();
    assert_eq!(s.last_seq(), 1);
    assert_eq!(s.append(log("next")).unwrap().seq, 2);
    drop(s);
    let s = TaskSpool::open(&root.path().join("tsk_2")).unwrap();
    assert_eq!(s.last_seq(), 2);
}

#[test]
fn reset_sent_resends_unacked() {
    let root = tempfile::tempdir().unwrap();
    let mut s = TaskSpool::create(root.path(), meta("tsk_3")).unwrap();
    s.append(log("a")).unwrap();
    s.append(log("b")).unwrap();
    s.unsent();
    s.ack(1).unwrap();
    s.reset_sent();
    let again = s.unsent();
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].seq, 2);
}
