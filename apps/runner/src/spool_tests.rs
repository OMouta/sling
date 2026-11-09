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
    assert_eq!(e, 4);
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
    assert_eq!(s.append(log("next")).unwrap(), 2);
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

fn events_len(root: &Path, id: &str) -> u64 {
    std::fs::metadata(root.join(id).join(EVENTS)).unwrap().len()
}

fn big(i: usize) -> Kind {
    log(&format!("{i:>8}{}", "x".repeat(8 * 1024)))
}

#[test]
fn a_running_task_compacts_what_the_server_acknowledged() {
    let root = tempfile::tempdir().unwrap();
    let mut s = TaskSpool::create(root.path(), meta("run")).unwrap();
    let mut peak = 0;
    for i in 0..600 {
        s.append(big(i)).unwrap();
        if i % 10 == 9 {
            let sent = s.unsent();
            s.ack(sent.last().unwrap().seq).unwrap();
        }
        peak = peak.max(events_len(root.path(), "run"));
    }
    // Without compaction this would be about 5 MB.
    assert!(peak < 2 * COMPACT_MIN + 64 * 1024, "peak {peak}");
    drop(s);
    let mut s = TaskSpool::open(&root.path().join("run")).unwrap();
    assert_eq!(s.last_seq(), 600);
    assert!(s.unsent().is_empty());
    assert_eq!(s.append(log("next")).unwrap(), 601);
}

#[test]
fn a_finished_task_keeps_only_its_last_record_once_acknowledged() {
    let root = tempfile::tempdir().unwrap();
    let mut s = TaskSpool::create(root.path(), meta("done")).unwrap();
    for i in 0..5 {
        s.append(big(i)).unwrap();
    }
    s.append(Kind::Finished(Default::default())).unwrap();
    s.set_meta(|m| m.state = SpoolState::Finished).unwrap();
    s.ack(5).unwrap();
    assert!(events_len(root.path(), "done") > 5 * 8 * 1024);
    s.ack(6).unwrap();
    assert!(events_len(root.path(), "done") < 100);
    drop(s);
    let s = TaskSpool::open(&root.path().join("done")).unwrap();
    assert_eq!(s.last_seq(), 6);
}

#[test]
fn spools_written_before_compaction_are_compacted_on_open() {
    let root = tempfile::tempdir().unwrap();
    let mut s = TaskSpool::create(root.path(), meta("old")).unwrap();
    for i in 0..200 {
        s.append(big(i)).unwrap();
    }
    drop(s);
    // An older Runner recorded the ack without compacting.
    std::fs::write(root.path().join("old/acked"), "190").unwrap();
    let before = events_len(root.path(), "old");
    let mut s = TaskSpool::open(&root.path().join("old")).unwrap();
    assert!(events_len(root.path(), "old") < before / 10);
    let replayed: Vec<u64> = s.unsent().iter().map(|e| e.seq).collect();
    assert_eq!(replayed, (191..=200).collect::<Vec<_>>());
    assert_eq!(s.append(log("next")).unwrap(), 201);
}

/// Tests on a simulated disk: crashes and power cuts at every step, and
/// states that storage which loses confirmed writes can leave behind.
mod faults {
    use std::collections::BTreeMap;

    use super::*;
    use crate::spool::sim::{CUTS, SimDisk};

    const ID: &str = "tsk_sim";

    fn root() -> PathBuf {
        PathBuf::from("/spool")
    }

    fn dir() -> PathBuf {
        root().join(ID)
    }

    fn record(task_id: &str, seq: u64, text: &str) -> Vec<u8> {
        TaskEvent {
            task_id: task_id.into(),
            seq,
            at_ms: 0,
            kind: Some(log(text)),
        }
        .encode_length_delimited_to_vec()
    }

    /// A spool directory written straight onto the disk.
    fn spool_on(disk: &SimDisk, acked: Option<&str>, events: &[u8]) {
        disk.put(
            &dir().join("meta.json"),
            &serde_json::to_vec(&meta(ID)).unwrap(),
        );
        if let Some(acked) = acked {
            disk.put(&dir().join("acked"), acked.as_bytes());
        }
        disk.put(&dir().join(EVENTS), events);
    }

    fn open(disk: &SimDisk) -> TaskSpool {
        TaskSpool::open_on(Arc::new(disk.clone()), &dir()).unwrap()
    }

    /// Everything the spool would send on a new connection.
    fn replay(s: &mut TaskSpool) -> Vec<TaskEvent> {
        s.reset_sent();
        let mut out = Vec::new();
        loop {
            let batch = s.unsent();
            if batch.is_empty() {
                return out;
            }
            out.extend(batch);
        }
    }

    fn seqs(events: &[TaskEvent]) -> Vec<u64> {
        events.iter().map(|e| e.seq).collect()
    }

    /// What callers and the server were told before the crash.
    #[derive(Default)]
    struct Promised {
        /// Records whose append returned, by seq.
        records: BTreeMap<u64, Kind>,
        /// The record being appended when the process died.
        attempted: Option<(u64, Kind)>,
        /// Highest seq the server acknowledged. It has every record up to it.
        server: u64,
    }

    struct Run {
        spool: TaskSpool,
        promised: Promised,
    }

    impl Run {
        fn append(&mut self, text: &str) -> Result<()> {
            let seq = self.spool.last_seq() + 1;
            self.promised.attempted = Some((seq, log(text)));
            assert_eq!(self.spool.append(log(text))?, seq);
            self.promised.records.insert(seq, log(text));
            self.promised.attempted = None;
            Ok(())
        }

        fn ack(&mut self, seq: u64) -> Result<()> {
            self.promised.server = self.promised.server.max(seq);
            self.spool.ack(seq)
        }

        fn finish(&mut self) -> Result<()> {
            self.spool.set_meta(|m| m.state = SpoolState::Finished)
        }
    }

    /// Checks a spool that restarted on `disk`: it opens; replay is in order
    /// with no gap after what the server has; every replayed record is the
    /// one first written with that seq; nothing the server lacks is missing;
    /// and the next record gets a seq no earlier record had, and survives
    /// another restart.
    fn check(disk: &SimDisk, p: &Promised, label: &str) {
        let mut s = TaskSpool::open_on(Arc::new(disk.clone()), &dir())
            .unwrap_or_else(|e| panic!("{label}: open failed: {e:#}"));
        let replayed = replay(&mut s);
        for pair in replayed.windows(2) {
            assert_eq!(pair[1].seq, pair[0].seq + 1, "{label}: replay skips");
        }
        if let Some(first) = replayed.first() {
            assert!(
                first.seq <= p.server + 1,
                "{label}: gap before {}",
                first.seq
            );
        }
        for e in &replayed {
            let expected = p.records.get(&e.seq).or(p
                .attempted
                .as_ref()
                .filter(|(seq, _)| *seq == e.seq)
                .map(|(_, kind)| kind));
            assert_eq!(e.kind.as_ref(), expected, "{label}: seq {} changed", e.seq);
        }
        for seq in p.records.keys().filter(|seq| **seq > p.server) {
            assert!(
                replayed.iter().any(|e| e.seq == *seq),
                "{label}: lost unacknowledged seq {seq}"
            );
        }
        let highest = p.records.keys().max().copied().unwrap_or(0).max(p.server);
        let next = s.append(log("after restart")).unwrap();
        assert!(next > highest, "{label}: seq {next} reused");
        drop(s);
        let mut s = TaskSpool::open_on(Arc::new(disk.clone()), &dir()).unwrap();
        assert_eq!(seqs(&replay(&mut s)).last(), Some(&next), "{label}");
    }

    /// Runs `steps` once for every change they make to the disk, with the
    /// process dying at that change, and checks the spool after each kind of
    /// power cut. The last run completes and is checked the same way.
    fn at_every_crash(setup: impl Fn(&mut Run), steps: impl Fn(&mut Run) -> Result<()>) {
        for at in 0.. {
            let disk = SimDisk::new(&root());
            let spool = TaskSpool::create_on(Arc::new(disk.clone()), &root(), meta(ID)).unwrap();
            let mut run = Run {
                spool,
                promised: Promised::default(),
            };
            setup(&mut run);
            disk.crash_after(at);
            let result = steps(&mut run);
            let crashed = disk.crashed();
            if !crashed {
                result.unwrap();
            }
            let Run { spool, promised } = run;
            drop(spool);
            for cut in CUTS {
                check(
                    &disk.power_cut(cut),
                    &promised,
                    &format!("crash at {at}, {cut:?}"),
                );
            }
            if !crashed {
                return;
            }
        }
    }

    #[test]
    fn appends_and_acks_survive_a_crash_at_every_step() {
        at_every_crash(
            |run| {
                for i in 0..3 {
                    run.append(&format!("setup {i}")).unwrap();
                }
            },
            |run| {
                run.append("a")?;
                run.append("b")?;
                run.ack(4)?;
                run.append("c")?;
                run.ack(6)?;
                run.finish()
            },
        );
    }

    #[test]
    fn a_failed_write_does_not_hide_later_records() {
        let disk = SimDisk::new(&root());
        let mut s = TaskSpool::create_on(Arc::new(disk.clone()), &root(), meta(ID)).unwrap();
        s.append(log("one")).unwrap();
        disk.fail_after(0);
        assert!(s.append(log("lost")).is_err());
        assert_eq!(s.append(log("two")).unwrap(), 2);
        drop(s);
        let replayed = replay(&mut open(&disk));
        assert_eq!(seqs(&replayed), [1, 2]);
        assert_eq!(replayed[1].kind, Some(log("two")));
    }

    #[test]
    fn acknowledgements_that_outlived_their_events_keep_the_sequence() {
        // `acked` reached the disk but the records it covers didn't.
        let disk = SimDisk::new(&root());
        let events = [record(ID, 1, "a"), record(ID, 2, "b")].concat();
        spool_on(&disk, Some("5"), &events);
        let mut s = open(&disk);
        assert_eq!(s.last_seq(), 5);
        assert!(replay(&mut s).is_empty());
        assert_eq!(s.append(log("new")).unwrap(), 6);
        drop(s);
        let mut s = open(&disk);
        assert_eq!(seqs(&replay(&mut s)), [6]);

        // The events file is gone entirely.
        let disk = SimDisk::new(&root());
        spool_on(&disk, Some("3"), &[]);
        let mut s = open(&disk);
        assert_eq!(s.append(log("new")).unwrap(), 4);
        drop(s);
        assert_eq!(seqs(&replay(&mut open(&disk))), [4]);
    }

    #[test]
    fn recovery_stops_at_bytes_that_were_never_written_as_records() {
        let whole = [record(ID, 1, "a"), record(ID, 2, "b"), record(ID, 3, "c")].concat();
        let tails: [(&str, Vec<u8>); 4] = [
            ("zeros", vec![0; 64]),
            ("torn", record(ID, 4, "d")[..5].to_vec()),
            ("stale", record(ID, 2, "old")),
            ("another task", record("tsk_other", 4, "d")),
        ];
        for (name, tail) in tails {
            let disk = SimDisk::new(&root());
            spool_on(&disk, Some("1"), &[whole.clone(), tail].concat());
            let mut s = open(&disk);
            assert_eq!(s.last_seq(), 3, "{name}");
            assert_eq!(seqs(&replay(&mut s)), [2, 3], "{name}");
            assert_eq!(s.append(log("d")).unwrap(), 4, "{name}");
            drop(s);
            assert_eq!(seqs(&replay(&mut open(&disk))), [2, 3, 4], "{name}");
        }
    }
    fn big(i: usize) -> String {
        format!("{i:>8}{}", "x".repeat(60 * 1024))
    }

    #[test]
    fn compaction_survives_a_crash_at_every_step() {
        at_every_crash(
            |run| {
                for i in 0..40 {
                    run.append(&big(i)).unwrap();
                }
            },
            |run| {
                // About 1.8 MB acknowledged and 0.6 MB not: this compacts.
                run.ack(30)?;
                run.append("a")?;
                run.append("b")?;
                run.ack(41)?;
                run.finish()?;
                // Fully acknowledged and finished: down to the last record.
                run.ack(42)
            },
        );
    }

    #[test]
    fn compaction_runs_and_leaves_the_last_acknowledged_record() {
        let disk = SimDisk::new(&root());
        let mut s = TaskSpool::create_on(Arc::new(disk.clone()), &root(), meta(ID)).unwrap();
        for i in 0..40 {
            s.append(log(&big(i))).unwrap();
        }
        s.ack(30).unwrap();
        assert_eq!(s.first_seq, 30);
        drop(s);
        let mut s = open(&disk);
        assert_eq!(seqs(&replay(&mut s)), (31..=40).collect::<Vec<_>>());
    }

    #[test]
    fn a_compacted_file_keeps_the_sequence_without_the_acked_file() {
        for acked in [None, Some(""), Some("garbage"), Some("2")] {
            let disk = SimDisk::new(&root());
            let events = [record(ID, 5, "e"), record(ID, 6, "f"), record(ID, 7, "g")].concat();
            spool_on(&disk, acked, &events);
            let mut s = open(&disk);
            // 5 was acknowledged, but sending it again is harmless: Sling
            // ignores a seq it has.
            assert_eq!(seqs(&replay(&mut s)), [5, 6, 7], "{acked:?}");
            assert_eq!(s.append(log("h")).unwrap(), 8, "{acked:?}");

            // A finished task compacted down to its last record.
            let disk = SimDisk::new(&root());
            spool_on(&disk, acked, &record(ID, 9, "done"));
            let mut s = open(&disk);
            assert_eq!(seqs(&replay(&mut s)), [9], "{acked:?}");
            assert_eq!(s.append(log("late")).unwrap(), 10, "{acked:?}");
        }
    }

    #[test]
    fn a_leftover_copy_from_an_interrupted_compaction_is_removed() {
        let disk = SimDisk::new(&root());
        spool_on(
            &disk,
            Some("1"),
            &[record(ID, 1, "a"), record(ID, 2, "b")].concat(),
        );
        disk.put(&dir().join(COMPACTING), &record(ID, 1, "a"));
        let mut s = open(&disk);
        assert_eq!(seqs(&replay(&mut s)), [2]);
        assert!(disk.read(&dir().join(COMPACTING)).is_err());
    }
}
