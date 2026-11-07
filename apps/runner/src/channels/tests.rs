//! Channels against a database with the Messages schema made here and the
//! stand-ins in `tests/fixtures`, never the real Messages, osascript sending
//! anything, or a linked signal-cli.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::json;
use sling_runner_protocol::{ChannelMessage, ChannelMessageAck, ChannelSend};

use super::imessage::testdb::{self, Row};
use super::imessage::{Reader, attributed_text};
use super::store::Store;
use super::*;

const JO: &str = "+351912345678";
const ANA: &str = "ana@icloud.com";
const STRANGER: &str = "+351960000000";
const ACCOUNT: &str = "+351900000000";

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// A copy of a stand-in in its own folder, which it writes its calls to.
fn stand_in(dir: &Path, name: &str) -> PathBuf {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let to = bin.join(name);
    std::fs::copy(fixture(name), &to).unwrap();
    to
}

struct Setup {
    _dir: tempfile::TempDir,
    root: PathBuf,
    paths: Paths,
}

fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let paths = Paths {
        config_dir: root.join("home"),
        data_dir: root.join("home/data"),
    };
    Setup {
        _dir: dir,
        root,
        paths,
    }
}

fn imessage_entry(name: &str, db: &Path, allowed: &[&str]) -> ChannelEntry {
    ChannelEntry {
        kind: Kind::Imessage,
        name: name.into(),
        account: None,
        bin: None,
        messages_db: Some(db.to_path_buf()),
        allowed_senders: allowed.iter().map(|s| s.to_string()).collect(),
    }
}

fn signal_entry(name: &str, bin: &Path, allowed: &[&str]) -> ChannelEntry {
    ChannelEntry {
        kind: Kind::Signal,
        name: name.into(),
        account: Some(ACCOUNT.into()),
        bin: Some(bin.display().to_string()),
        messages_db: None,
        allowed_senders: allowed.iter().map(|s| s.to_string()).collect(),
    }
}

fn manager(paths: &Paths, entries: Vec<ChannelEntry>) -> Arc<Manager> {
    let cfg = Config {
        channel_entries: entries,
        ..Config::default()
    };
    Manager::new(paths.clone(), cfg).unwrap()
}

/// Stops the workers, as a Runner that exits would.
fn stop(mgr: &Manager) {
    mgr.channels.workers.lock().unwrap().clear();
}

async fn until<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(v) = f() {
            return v;
        }
        if Instant::now() > end {
            panic!("timed out waiting for {what}");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// The messages handed to the connection, waiting until there are `n`.
async fn forwarded(mgr: &Manager, n: usize) -> Vec<ChannelMessage> {
    let mut got = Vec::new();
    until(&format!("{n} forwarded messages"), || {
        got.extend(mgr.channels.unsent().into_iter().filter_map(|b| match b {
            Body::ChannelMessage(m) => Some(m),
            _ => None,
        }));
        (got.len() >= n).then_some(())
    })
    .await;
    got
}

async fn settle_quietly() {
    tokio::time::sleep(Duration::from_millis(400)).await;
}

fn ack(mgr: &Manager, m: &ChannelMessage) {
    mgr.channel_message_ack(&ChannelMessageAck {
        channel: m.channel.clone(),
        message_id: m.message_id.clone(),
    });
}

async fn send(mgr: &Arc<Manager>, channel: &str, to: &str, text: &str) -> ChannelSendResult {
    let (tx, mut rx) = mpsc::channel(4);
    mgr.channel_send(
        ChannelSend {
            request_id: "c1".into(),
            channel: channel.into(),
            conversation: to.into(),
            text: text.into(),
        },
        tx,
    );
    match tokio::time::timeout(Duration::from_secs(40), rx.recv()).await {
        Ok(Some(Body::ChannelSendResult(r))) => r,
        other => panic!("no ChannelSendResult: {other:?}"),
    }
}

/// Each osascript call's arguments, oldest first.
fn osascript_calls(bin: &Path) -> Vec<Vec<String>> {
    let dir = bin.parent().unwrap().join("calls");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .map(|d| d.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default();
    files.retain(|p| p.extension().is_some_and(|e| e == "args"));
    files.sort_by_key(|p| {
        p.file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.split('.').next())
            .and_then(|s| s.parse::<u32>().ok())
    });
    files
        .iter()
        .map(|p| {
            std::fs::read_to_string(p)
                .unwrap()
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .collect()
}

// ---------------------------------------------------------------- addresses

#[test]
fn addresses_are_normalized() {
    assert_eq!(
        normalize_address(" +351 912-345 (678) ").as_deref(),
        Some(JO)
    );
    assert_eq!(normalize_address("Ana@iCloud.com").as_deref(), Some(ANA));
    assert_eq!(
        normalize_address("0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0").as_deref(),
        Some("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")
    );
    for bad in [
        "912345678",
        "+12",
        "+1234567890123456",
        "12345",
        "a@b",
        "@x.com",
        "a b@x.com",
        "",
        "iMessage;+;chat1",
        "-e",
    ] {
        assert_eq!(normalize_address(bad), None, "{bad}");
    }
    assert!(check_name("imessage").is_ok());
    assert!(check_name("work-signal_2").is_ok());
    assert!(check_name("../x").is_err());
    assert!(check_name("Signal").is_err());
}

// ---------------------------------------------------------------- the Messages database

#[test]
fn reads_text_kept_only_in_attributed_body() {
    assert_eq!(
        attributed_text(&testdb::attributed_body("hi there")).as_deref(),
        Some("hi there")
    );
    let long = "é".repeat(200);
    assert_eq!(
        attributed_text(&testdb::attributed_body(&long)).as_deref(),
        Some(long.as_str())
    );
    let mutable = testdb::attributed_body("ok");
    let mutable =
        String::from_utf8_lossy(&mutable).replace("\u{8}NSString", "\u{f}NSMutableString");
    assert_eq!(attributed_text(mutable.as_bytes()).as_deref(), Some("ok"));
    assert_eq!(attributed_text(b"streamtyped NSNumber"), None);
    assert_eq!(
        attributed_text(b"NSString\x01\x94\x84\x01+\x40short"),
        None,
        "cut short"
    );
}

#[test]
fn reads_rows_from_a_messages_database() {
    let s = setup();
    let db = s.root.join("chat.db");
    let c = testdb::create(&db);
    let a = testdb::insert(
        &c,
        Row {
            text: Some("plain"),
            ..Row::default()
        },
    );
    let b = testdb::insert(
        &c,
        Row {
            text: None,
            body: Some("only in the body"),
            ..Row::default()
        },
    );
    let me = testdb::insert(
        &c,
        Row {
            from_me: true,
            ..Row::default()
        },
    );
    let tap = testdb::insert(
        &c,
        Row {
            reaction: true,
            text: Some("Loved “plain”"),
            ..Row::default()
        },
    );
    let g = testdb::insert(
        &c,
        Row {
            from: ANA,
            group: Some("iMessage;+;chat42"),
            ..Row::default()
        },
    );
    let att = testdb::insert(
        &c,
        Row {
            text: Some("\u{fffc}"),
            ..Row::default()
        },
    );

    let r = Reader::open(&db).unwrap();
    assert_eq!(r.last_rowid().unwrap(), att);
    let rows = r.after(0, 100).unwrap();
    assert_eq!(
        rows.iter().map(|m| m.rowid).collect::<Vec<_>>(),
        [a, b, me, tap, g, att]
    );
    assert_eq!(rows[0].text, "plain");
    assert_eq!(rows[0].sender.as_deref(), Some(JO));
    assert!(!rows[0].group);
    // 784e15 ns after 2001-01-01 is 2025-11-04.
    assert_eq!(rows[0].at_ms, 978_307_200_000 + 784_000_000_000);
    assert_eq!(rows[1].text, "only in the body");
    assert!(rows[2].from_me);
    assert!(rows[3].not_a_message);
    assert!(rows[4].group);
    assert_eq!(rows[4].chat.as_deref(), Some("iMessage;+;chat42"));
    assert_eq!(rows[5].text, "");
    assert_eq!(
        r.after(b, 2)
            .unwrap()
            .iter()
            .map(|m| m.rowid)
            .collect::<Vec<_>>(),
        [me, tap]
    );

    let e = imessage_entry("imessage", &db, &[JO]);
    let fwd = |m| imessage::forwardable(&e, m).map(|(p, g)| (p.text, p.conversation, g));
    assert_eq!(fwd(&rows[0]), Some(("plain".into(), JO.into(), false)));
    assert_eq!(fwd(&rows[1]).map(|f| f.0), Some("only in the body".into()));
    assert_eq!(fwd(&rows[2]), None, "sent from this Mac");
    assert_eq!(fwd(&rows[3]), None, "a tapback");
    assert_eq!(fwd(&rows[4]), None, "Ana isn't allowed");
    assert_eq!(fwd(&rows[5]), None, "an attachment only");
    let both = imessage_entry("imessage", &db, &[JO, ANA]);
    assert_eq!(
        imessage::forwardable(&both, &rows[4]).map(|(p, g)| (p.conversation, p.sender, g)),
        Some(("iMessage;+;chat42".into(), ANA.into(), true))
    );
}

#[test]
fn says_what_to_grant_when_messages_cant_be_read() {
    let s = setup();
    let missing = s.root.join("nope/chat.db");
    assert!(matches!(
        Reader::open(&missing),
        Err(imessage::DbError::Missing(_))
    ));
    let db = s.root.join("chat.db");
    drop(testdb::create(&db));
    let mut perms = std::fs::metadata(&db).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o000);
    std::fs::set_permissions(&db, perms).unwrap();
    // Root reads it anyway.
    if std::fs::File::open(&db).is_err() {
        let err = Reader::open(&db).err().unwrap();
        assert_eq!(err, imessage::DbError::NoAccess);
        assert!(err.for_machine().contains("Full Disk Access"));
    }
}

// ---------------------------------------------------------------- iMessage end to end

#[tokio::test]
async fn forwards_allowed_imessages_once_across_restarts() {
    let s = setup();
    let db = s.root.join("chat.db");
    let c = testdb::create(&db);
    testdb::insert(
        &c,
        Row {
            text: Some("from before"),
            ..Row::default()
        },
    );
    let entry = imessage_entry("im-restarts", &db, &[JO]);

    let mgr = manager(&s.paths, vec![entry.clone()]);
    reconcile(&mgr);
    until("a place in the database", || {
        Store::load(&s.paths, "im-restarts").cursor
    })
    .await;
    assert!(
        mgr.channels.unsent().is_empty(),
        "nothing from before it started"
    );

    let a = testdb::insert(
        &c,
        Row {
            text: Some("book dinner"),
            ..Row::default()
        },
    );
    testdb::insert(
        &c,
        Row {
            from: STRANGER,
            text: Some("hi, it's not Jo"),
            ..Row::default()
        },
    );
    let b = testdb::insert(
        &c,
        Row {
            text: None,
            body: Some("with Jo on Friday"),
            ..Row::default()
        },
    );
    testdb::insert(
        &c,
        Row {
            from_me: true,
            text: Some("an answer"),
            ..Row::default()
        },
    );
    let last = testdb::insert(
        &c,
        Row {
            reaction: true,
            ..Row::default()
        },
    );

    let got = forwarded(&mgr, 2).await;
    settle_quietly().await;
    assert!(mgr.channels.unsent().is_empty(), "nothing else goes");
    assert_eq!(
        got.iter()
            .map(|m| (m.text.as_str(), m.conversation.as_str(), m.sender.as_str()))
            .collect::<Vec<_>>(),
        [("book dinner", JO, JO), ("with Jo on Friday", JO, JO)]
    );
    assert_eq!(got[0].message_id, a.to_string());
    assert_eq!(got[0].channel, "im-restarts");

    // Only the first is stored, so the place stays before the second.
    ack(&mgr, &got[0]);
    assert_eq!(Store::load(&s.paths, "im-restarts").cursor, Some(b - 1));
    // A reconnect sends again what Sling hasn't stored.
    mgr.reset_sent();
    assert_eq!(forwarded(&mgr, 1).await[0].message_id, b.to_string());

    // The Runner stops, and a message arrives while it's down.
    stop(&mgr);
    drop(mgr);
    let c2 = testdb::insert(
        &c,
        Row {
            text: Some("are you there?"),
            ..Row::default()
        },
    );
    let mgr = manager(&s.paths, vec![entry]);
    reconcile(&mgr);
    let got = forwarded(&mgr, 2).await;
    assert_eq!(
        got.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["with Jo on Friday", "are you there?"]
    );
    for m in &got {
        ack(&mgr, m);
    }
    assert_eq!(Store::load(&s.paths, "im-restarts").cursor, Some(c2));
    assert!(c2 > last);
    stop(&mgr);
}

#[tokio::test]
async fn forwards_nothing_without_allowed_senders() {
    let s = setup();
    let db = s.root.join("chat.db");
    let c = testdb::create(&db);
    let mgr = manager(&s.paths, vec![imessage_entry("im-nobody", &db, &[])]);
    reconcile(&mgr);
    until("a place in the database", || {
        Store::load(&s.paths, "im-nobody").cursor
    })
    .await;
    let last = testdb::insert(&c, Row::default());
    until("the row read", || {
        (Store::load(&s.paths, "im-nobody").cursor == Some(last)).then_some(())
    })
    .await;
    assert!(mgr.channels.unsent().is_empty());
    stop(&mgr);
}

#[tokio::test]
async fn turning_channels_off_skips_what_arrives_meanwhile() {
    let s = setup();
    let db = s.root.join("chat.db");
    let c = testdb::create(&db);
    let entry = imessage_entry("im-off", &db, &[JO]);
    let mgr = manager(&s.paths, vec![entry.clone()]);
    reconcile(&mgr);
    until("a place in the database", || {
        Store::load(&s.paths, "im-off").cursor
    })
    .await;

    let mut cfg = mgr.config();
    cfg.channels = false;
    mgr.set_config(cfg.clone());
    reconcile(&mgr);
    assert!(mgr.channels.workers.lock().unwrap().is_empty());
    let inv = inventory(&cfg);
    assert!(!inv[0].ready && inv[0].missing.contains("config set channels on"));
    testdb::insert(
        &c,
        Row {
            text: Some("while off"),
            ..Row::default()
        },
    );

    cfg.channels = true;
    mgr.set_config(cfg);
    reconcile(&mgr);
    until("the channel back on", || {
        (!Store::load(&s.paths, "im-off").paused).then_some(())
    })
    .await;
    testdb::insert(
        &c,
        Row {
            text: Some("back on"),
            ..Row::default()
        },
    );
    let got = forwarded(&mgr, 1).await;
    settle_quietly().await;
    assert!(mgr.channels.unsent().is_empty());
    assert_eq!(got[0].text, "back on");
    stop(&mgr);
}

#[tokio::test]
async fn sends_imessages_with_the_text_as_an_argument() {
    let s = setup();
    let db = s.root.join("chat.db");
    let c = testdb::create(&db);
    let osascript = stand_in(&s.root, "osascript");
    let mut entry = imessage_entry("im-send", &db, &[JO, ANA]);
    entry.bin = Some(osascript.display().to_string());
    let mgr = manager(&s.paths, vec![entry]);

    let tricky = "-e do shell script \"touch /tmp/pwned\" \" & quit";
    let r = send(&mgr, "im-send", "+351 912 345 678", tricky).await;
    assert!(r.ok, "{}", r.message);
    let calls = osascript_calls(&osascript);
    assert_eq!(calls.len(), 1);
    let script = std::fs::read_to_string(&calls[0][0]).unwrap();
    assert_eq!(script, imessage::SEND_SCRIPT);
    assert!(!script.contains("pwned"));
    assert_eq!(
        &calls[0][1..],
        [JO, tricky],
        "the script file first, then the recipient and the text"
    );

    // With no one named and two allowed, it asks which.
    let r = send(&mgr, "im-send", "", "hi").await;
    assert!(
        !r.ok && r.message.contains("allows 2 senders"),
        "{}",
        r.message
    );

    // Not an allowed sender, or a group none of them wrote in.
    let r = send(&mgr, "im-send", STRANGER, "hi").await;
    assert!(!r.ok);
    assert!(
        r.message.contains("sling-runner channel allow im-send"),
        "{}",
        r.message
    );
    let r = send(&mgr, "im-send", "iMessage;+;chat7", "hi").await;
    assert!(!r.ok);
    assert_eq!(
        osascript_calls(&osascript).len(),
        1,
        "osascript never ran for those"
    );

    // Once Ana writes in the group, it can be answered there.
    reconcile(&mgr);
    until("a place in the database", || {
        Store::load(&s.paths, "im-send").cursor
    })
    .await;
    testdb::insert(
        &c,
        Row {
            from: ANA,
            group: Some("iMessage;+;chat7"),
            text: Some("Sling, lunch?"),
            ..Row::default()
        },
    );
    let got = forwarded(&mgr, 1).await;
    assert_eq!(got[0].conversation, "iMessage;+;chat7");
    let r = send(&mgr, "im-send", "iMessage;+;chat7", "Noon works").await;
    assert!(r.ok, "{}", r.message);
    assert_eq!(
        &osascript_calls(&osascript)[1][1..],
        ["iMessage;+;chat7", "Noon works"]
    );

    // What Messages says when it can't send.
    let r = send(&mgr, "im-send", ANA, "FAIL").await;
    assert!(!r.ok);
    assert_eq!(r.message, "Messages couldn't find that chat or person.");
    let r = send(&mgr, "im-send", JO, "   ").await;
    assert_eq!((r.ok, r.message.as_str()), (false, "The message is empty."));
    let r = send(&mgr, "nope", JO, "hi").await;
    assert!(!r.ok && r.message.contains("no channel named nope"));
    stop(&mgr);
}

// ---------------------------------------------------------------- Signal

fn receive(
    source: &str,
    uuid: &str,
    ts: i64,
    text: Option<&str>,
    group: Option<&str>,
) -> serde_json::Value {
    let mut data = json!({ "timestamp": ts, "expiresInSeconds": 0, "viewOnce": false });
    if let Some(t) = text {
        data["message"] = json!(t);
    }
    if let Some(g) = group {
        data["groupInfo"] = json!({ "groupId": g, "type": "DELIVER" });
    }
    json!({
        "jsonrpc": "2.0",
        "method": "receive",
        "params": {
            "envelope": {
                "source": source,
                "sourceNumber": source,
                "sourceUuid": uuid,
                "sourceName": "Someone",
                "sourceDevice": 1,
                "timestamp": ts,
                "dataMessage": data,
            },
            "account": ACCOUNT,
        }
    })
}

fn deliver(bin: &Path, name: &str, v: &serde_json::Value) {
    let inbox = bin.parent().unwrap().join("inbox");
    std::fs::create_dir_all(&inbox).unwrap();
    let tmp = inbox.join(format!("{name}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(v).unwrap()).unwrap();
    std::fs::rename(&tmp, inbox.join(format!("{name}.json"))).unwrap();
}

fn requests(bin: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(bin.parent().unwrap().join("requests.log"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn reads_signal_notifications() {
    let e = signal_entry(
        "signal",
        Path::new("signal-cli"),
        &[JO, "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"],
    );
    let params = |v: serde_json::Value| v["params"].clone();
    let (p, group) = signal::incoming(
        &e,
        &params(receive(JO, "u-1", 1_000, Some(" hi "), None)),
        0,
    )
    .unwrap();
    assert_eq!(
        (
            p.text.as_str(),
            p.conversation.as_str(),
            p.sender.as_str(),
            group
        ),
        ("hi", JO, JO, false)
    );
    assert_eq!(p.message_id, format!("1000-{JO}"));
    let (p, group) = signal::incoming(
        &e,
        &params(receive(JO, "u-1", 1_000, Some("hi"), Some("R3JvdXA="))),
        0,
    )
    .unwrap();
    assert_eq!((p.conversation.as_str(), group), ("R3JvdXA=", true));
    // Allowed by account ID, with the number hidden.
    let hidden = json!({ "envelope": { "source": "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0", "sourceUuid": "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0", "timestamp": 5, "dataMessage": { "message": "yo" } } });
    assert_eq!(
        signal::incoming(&e, &hidden, 0).unwrap().0.sender,
        "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
    );

    assert!(
        signal::incoming(
            &e,
            &params(receive(STRANGER, "u-2", 1_000, Some("hi"), None)),
            0
        )
        .is_none()
    );
    assert!(
        signal::incoming(&e, &params(receive(JO, "u-1", 1_000, None, None)), 0).is_none(),
        "a reaction"
    );
    assert!(
        signal::incoming(
            &e,
            &params(receive(JO, "u-1", 1_000, Some("old"), None)),
            2_000
        )
        .is_none()
    );
    let mut own = e.clone();
    own.allowed_senders.push(ACCOUNT.into());
    assert!(
        signal::incoming(
            &own,
            &params(receive(ACCOUNT, "u-0", 1_000, Some("me"), None)),
            0
        )
        .is_none()
    );
    let receipt = json!({ "envelope": { "source": JO, "timestamp": 5, "receiptMessage": { "isDelivery": true } } });
    assert!(signal::incoming(&e, &receipt, 0).is_none());
}

#[tokio::test]
async fn relays_signal_through_signal_cli() {
    let s = setup();
    let bin = stand_in(&s.root, "signal-cli");
    let entry = signal_entry("sig-relay", &bin, &[JO]);
    Store {
        skip_before_ms: 10_000,
        ..Store::default()
    }
    .save(&s.paths, "sig-relay");
    // Waiting on Signal's servers from before the channel was added, and
    // from someone it doesn't allow.
    deliver(
        &bin,
        "1",
        &receive(JO, "u-1", 9_000, Some("from before"), None),
    );
    deliver(
        &bin,
        "2",
        &receive(STRANGER, "u-2", 20_000, Some("hello?"), None),
    );
    deliver(
        &bin,
        "3",
        &receive(JO, "u-1", 20_001, Some("what's on today?"), None),
    );

    let mgr = manager(&s.paths, vec![entry.clone()]);
    reconcile(&mgr);
    let got = forwarded(&mgr, 1).await;
    settle_quietly().await;
    assert!(mgr.channels.unsent().is_empty());
    assert_eq!(
        (got[0].text.as_str(), got[0].conversation.as_str()),
        ("what's on today?", JO)
    );
    // Saved, since signal-cli won't hand it out again.
    assert_eq!(Store::load(&s.paths, "sig-relay").pending.len(), 1);
    let inv = until("signal-cli running", || {
        let inv = inventory(&mgr.config());
        inv[0].ready.then_some(inv)
    })
    .await;
    assert_eq!(
        (inv[0].kind.as_str(), inv[0].allowed_senders),
        ("signal", 1)
    );

    // No one named: the one sender it allows.
    let r = send(&mgr, "sig-relay", "", "Lunch with Jo at 1").await;
    assert!(r.ok, "{}", r.message);
    let r = send(&mgr, "sig-relay", JO, "UNREGISTERED").await;
    assert_eq!(
        (r.ok, r.message.as_str()),
        (false, "Signal couldn't deliver it: unregistered failure")
    );
    let r = send(&mgr, "sig-relay", STRANGER, "hi").await;
    assert!(!r.ok);
    let sent = requests(&bin);
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["method"], "send");
    assert_eq!(
        sent[0]["params"],
        json!({ "recipient": [JO], "message": "Lunch with Jo at 1" })
    );

    // The Runner stops before Sling stored it, so it goes again after.
    stop(&mgr);
    drop(mgr);
    let mgr = manager(&s.paths, vec![entry]);
    reconcile(&mgr);
    let again = forwarded(&mgr, 1).await;
    assert_eq!(again[0].message_id, got[0].message_id);
    ack(&mgr, &again[0]);
    assert!(Store::load(&s.paths, "sig-relay").pending.is_empty());

    // A group an allowed sender wrote in can be answered.
    deliver(
        &bin,
        "4",
        &receive(JO, "u-1", 30_000, Some("team lunch?"), Some("R3JvdXA=")),
    );
    let g = forwarded(&mgr, 1).await;
    assert_eq!(g[0].conversation, "R3JvdXA=");
    let r = send(&mgr, "sig-relay", "R3JvdXA=", "Yes").await;
    assert!(r.ok, "{}", r.message);
    assert_eq!(
        requests(&bin)[2]["params"],
        json!({ "groupId": "R3JvdXA=", "message": "Yes" })
    );
    stop(&mgr);
}

#[tokio::test]
async fn restarts_signal_cli_when_it_stops() {
    let s = setup();
    let bin = stand_in(&s.root, "signal-cli");
    let crash = bin.parent().unwrap().join("crash");
    std::fs::write(&crash, "").unwrap();
    let mgr = manager(&s.paths, vec![signal_entry("sig-crash", &bin, &[JO])]);
    reconcile(&mgr);
    let missing = until("signal-cli to fail", || {
        let inv = inventory(&mgr.config());
        (!inv[0].ready && inv[0].missing.contains("signal-cli link"))
            .then(|| inv[0].missing.clone())
    })
    .await;
    assert!(missing.contains("isn't linked"), "{missing}");
    let r = send(&mgr, "sig-crash", JO, "hi").await;
    assert!(!r.ok);

    std::fs::remove_file(&crash).unwrap();
    until("signal-cli to come back", || {
        inventory(&mgr.config())[0].ready.then_some(())
    })
    .await;
    let starts = std::fs::read_to_string(bin.parent().unwrap().join("starts")).unwrap();
    assert!(starts.lines().count() >= 2);
    let r = send(&mgr, "sig-crash", JO, "hi").await;
    assert!(r.ok, "{}", r.message);
    stop(&mgr);
}

// ---------------------------------------------------------------- commands

#[tokio::test]
async fn channel_commands_set_up_the_machine() {
    let s = setup();
    let db = s.root.join("chat.db");
    let c = testdb::create(&db);
    let newest = testdb::insert(&c, Row::default());
    let osascript = stand_in(&s.root, "osascript");

    let out = cli::add_imessage(
        &s.paths,
        None,
        Some(db.clone()),
        &osascript.display().to_string(),
    )
    .await
    .unwrap();
    assert!(out.contains("sling-runner channel allow imessage"), "{out}");
    assert_eq!(osascript_calls(&osascript)[0][0], "-e", "it asked Messages");
    assert_eq!(Store::load(&s.paths, "imessage").cursor, Some(newest));
    assert!(
        cli::add_imessage(
            &s.paths,
            Some("other".into()),
            Some(db.clone()),
            "osascript"
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("already set up")
    );

    let bin = stand_in(&s.root, "signal-cli");
    std::fs::write(
        bin.parent().unwrap().join("accounts"),
        format!("{ACCOUNT}\n"),
    )
    .unwrap();
    let err = cli::add_signal(
        &s.paths,
        "+351 999 999 999",
        None,
        Some(bin.display().to_string()),
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("signal-cli link"), "{err}");
    assert!(cli::add_signal(&s.paths, "999", None, None).await.is_err());
    cli::add_signal(
        &s.paths,
        "+351 900 000 000",
        None,
        Some(bin.display().to_string()),
    )
    .await
    .unwrap();
    assert!(Store::load(&s.paths, "signal").skip_before_ms > 0);

    assert!(
        cli::allow(&s.paths, "imessage", "+351 912 345 678")
            .unwrap()
            .contains(JO)
    );
    assert!(
        cli::allow(&s.paths, "imessage", JO)
            .unwrap()
            .contains("already allowed")
    );
    assert!(cli::allow(&s.paths, "imessage", "Ana@iCloud.com").is_ok());
    assert!(cli::allow(&s.paths, "imessage", "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0").is_err());
    assert!(cli::allow(&s.paths, "imessage", "912345678").is_err());
    assert!(cli::allow(&s.paths, "nope", JO).is_err());
    cli::disallow(&s.paths, "imessage", ANA).unwrap();

    let cfg = Config::load(&s.paths).unwrap();
    assert_eq!(cfg.channel_entries.len(), 2);
    assert_eq!(cfg.channel_entries[0].allowed_senders, [JO]);
    assert_eq!(cfg.channel_entries[1].account.as_deref(), Some(ACCOUNT));
    let text = std::fs::read_to_string(s.paths.config_file()).unwrap();
    assert!(text.contains("[[channel]]"), "{text}");
    let listed = cli::list(&s.paths).unwrap();
    assert!(
        listed.contains(&format!("allows {JO}")) && listed.contains("no senders allowed"),
        "{listed}"
    );

    let inv = inventory(&cfg);
    assert_eq!(
        inv.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["imessage", "signal"]
    );
    assert_eq!(inv[0].allowed_senders, 1);

    cli::remove(&s.paths, "signal").unwrap();
    assert!(!Store::path(&s.paths, "signal").exists());
    assert!(cli::remove(&s.paths, "signal").is_err());
}
