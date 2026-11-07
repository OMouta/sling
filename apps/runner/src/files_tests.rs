use std::fs;
use std::path::Path;

use super::*;
use crate::config::Paths;

struct Fixture {
    _dir: tempfile::TempDir,
    paths: Paths,
    /// The shared folder, canonical.
    notes: PathBuf,
    /// A folder next to it that isn't shared.
    private: PathBuf,
}

/// A Runner home, a shared `Notes` folder, and a `Private` folder beside it.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(dir.path()).unwrap();
    let paths = Paths {
        config_dir: base.join("home"),
        data_dir: base.join("home/data"),
    };
    let notes = base.join("Notes");
    let private = base.join("Private");
    fs::create_dir_all(notes.join("house")).unwrap();
    fs::create_dir_all(&private).unwrap();
    fs::write(
        notes.join("house/boiler.md"),
        "# Boiler\n\nThe BOILER was serviced in March.\nNext service: October.\n",
    )
    .unwrap();
    fs::write(
        notes.join("todo.txt"),
        "call the bank\nboiler pressure low?\n",
    )
    .unwrap();
    fs::write(private.join("secret.md"), "boiler password hunter2\n").unwrap();
    Config::default().save(&paths).unwrap();
    add(&paths, &notes, None).unwrap();
    Fixture {
        _dir: dir,
        paths,
        notes,
        private,
    }
}

fn cfg(f: &Fixture) -> Config {
    Config::load(&f.paths).unwrap()
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[test]
fn folders_are_added_by_the_machine_and_listed_by_name() {
    let f = fixture();
    let c = cfg(&f);
    assert_eq!(folder_names(&c), ["Notes"]);
    assert_eq!(c.folders[0].path, f.notes);
    assert!(enabled(&c));
    assert_eq!(summary(&c), "on: 1 folder shared");

    let named = add(&f.paths, &f.private, Some("Work stuff".into())).unwrap();
    assert_eq!(named.name, "Work stuff");
    assert_eq!(folder_names(&cfg(&f)), ["Notes", "Work stuff"]);
    assert_eq!(remove(&f.paths, "work STUFF").unwrap(), "Work stuff");
    assert!(remove(&f.paths, "Work stuff").is_err());
}

#[test]
fn adding_refuses_what_it_shouldnt_share() {
    let f = fixture();
    let err = |r: Result<FolderEntry>| r.unwrap_err().to_string();
    assert!(err(add(&f.paths, &f.notes, Some("Again".into()))).contains("already shared as Notes"));
    assert!(err(add(&f.paths, &f.private, Some("notes".into()))).contains("already shared"));
    assert!(err(add(&f.paths, &f.notes.join("house"), None)).contains("inside Notes"));
    assert!(
        err(add(&f.paths, f.notes.parent().unwrap(), Some("All".into()))).contains("holds Notes")
    );
    assert!(err(add(&f.paths, &f.notes.join("todo.txt"), None)).contains("isn't a folder"));
    assert!(err(add(&f.paths, &f.notes.join("nope"), None)).contains("doesn't exist"));
    assert!(err(add(&f.paths, Path::new("/"), None)).contains("whole disk"));
    fs::create_dir_all(f.paths.data_dir.join("spool")).unwrap();
    assert!(err(add(&f.paths, &f.paths.data_dir.join("spool"), None)).contains("Runner's own"));
    assert!(err(add(&f.paths, &f.private, Some(".hidden".into()))).contains("folder names"));
    assert!(err(add(&f.paths, &f.private, Some("a/b".into()))).contains("folder names"));
}

#[test]
fn search_finds_lines_ignoring_case() {
    let f = fixture();
    let out = search(&cfg(&f), "boiler", &[], 50).unwrap();
    let got: Vec<(&str, u32)> = out.hits.iter().map(|h| (h.path.as_str(), h.line)).collect();
    assert_eq!(
        got,
        [
            ("house/boiler.md", 1),
            ("house/boiler.md", 3),
            ("todo.txt", 2)
        ]
    );
    assert!(out.hits.iter().all(|h| h.folder == "Notes"));
    assert_eq!(out.hits[1].snippet, "The BOILER was serviced in March.");
    assert!(!out.truncated);
    // Never what's next to the folder.
    assert!(!out.hits.iter().any(|h| h.snippet.contains("hunter2")));
    // Literal text, not a pattern.
    assert!(search(&cfg(&f), "bo.ler", &[], 50).unwrap().hits.is_empty());
}

#[test]
fn search_skips_hidden_ignored_big_and_binary_files() {
    let f = fixture();
    let n = &f.notes;
    fs::create_dir_all(n.join(".git")).unwrap();
    fs::write(n.join(".git/config"), "boiler").unwrap();
    fs::write(n.join(".hidden.md"), "boiler").unwrap();
    fs::create_dir_all(n.join(".obsidian")).unwrap();
    fs::write(n.join(".obsidian/cache.md"), "boiler").unwrap();
    fs::create_dir_all(n.join("node_modules/pkg")).unwrap();
    fs::write(n.join("node_modules/pkg/readme.md"), "boiler").unwrap();
    fs::write(n.join(".gitignore"), "build/\n*.log\n").unwrap();
    fs::create_dir_all(n.join("build")).unwrap();
    fs::write(n.join("build/out.md"), "boiler").unwrap();
    fs::write(n.join("debug.log"), "boiler").unwrap();
    fs::write(n.join("photo.jpg"), b"\xff\xd8boiler\0\0\0\x01").unwrap();
    let mut big = "boiler\n".to_string();
    big.push_str(&"x".repeat(2 * 1024 * 1024 + 10));
    fs::write(n.join("big.md"), big).unwrap();

    let out = search(&cfg(&f), "boiler", &[], 50).unwrap();
    let paths: Vec<&str> = out.hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(paths, ["house/boiler.md", "house/boiler.md", "todo.txt"]);
}

#[cfg(unix)]
#[test]
fn search_never_follows_a_symlink_out() {
    let f = fixture();
    symlink(&f.private.join("secret.md"), &f.notes.join("link.md"));
    symlink(&f.private, &f.notes.join("private"));
    let out = search(&cfg(&f), "hunter2", &[], 50).unwrap();
    assert!(out.hits.is_empty(), "{:?}", out.hits);
}

#[test]
fn search_stops_at_the_limit_and_says_so() {
    let f = fixture();
    for i in 0..30 {
        fs::write(f.notes.join(format!("n{i:02}.md")), "boiler\nboiler\n").unwrap();
    }
    // One file gives at most five lines.
    fs::write(f.notes.join("many.md"), "boiler\n".repeat(20)).unwrap();
    let out = search(&cfg(&f), "BOILER", &[], 10).unwrap();
    assert_eq!(out.hits.len(), 10);
    assert!(out.truncated);
    let only_many = search(&cfg(&f), "boiler", &[], 50).unwrap();
    assert_eq!(only_many.hits.len(), 50);
    let all = {
        let mut c = cfg(&f);
        c.folders[0].path = f.notes.join("house");
        search(&c, "boiler", &[], 50).unwrap()
    };
    assert!(!all.truncated);
    let many = {
        fs::create_dir_all(f.private.join("one")).unwrap();
        fs::write(f.private.join("one/many.md"), "boiler\n".repeat(20)).unwrap();
        let mut c = cfg(&f);
        c.folders[0].path = f.private.join("one");
        search(&c, "boiler", &[], 50).unwrap()
    };
    assert_eq!(many.hits.len(), 5);
    assert!(many.truncated);
}

#[test]
fn search_takes_folders_by_name_and_refuses_others() {
    let f = fixture();
    add(&f.paths, &f.private, None).unwrap();
    let only = search(&cfg(&f), "hunter2", &["private".into()], 50).unwrap();
    assert_eq!(only.hits.len(), 1);
    assert_eq!(only.hits[0].folder, "Private");
    assert!(
        search(&cfg(&f), "hunter2", &["Notes".into()], 50)
            .unwrap()
            .hits
            .is_empty()
    );
    let err = search(&cfg(&f), "boiler", &["Photos".into()], 50).unwrap_err();
    assert!(
        err.contains("doesn't share a folder named \"Photos\""),
        "{err}"
    );
    assert!(err.contains("Notes, Private"), "{err}");
    assert!(search(&cfg(&f), "  ", &[], 50).is_err());
    assert!(search(&cfg(&f), &"x".repeat(201), &[], 50).is_err());
}

#[test]
fn files_off_refuses_everything() {
    let f = fixture();
    let mut c = cfg(&f);
    c.files = false;
    assert!(
        search(&c, "boiler", &[], 50)
            .unwrap_err()
            .contains("files on")
    );
    let err = read(&c, &f.paths, "Notes", "todo.txt", 0).unwrap_err();
    assert!(err.contains("files on"), "{err}");
    assert!(!enabled(&c));
    assert!(summary(&c).starts_with("off"));
    let none = Config::default();
    assert!(
        search(&none, "boiler", &[], 50)
            .unwrap_err()
            .contains("folder add")
    );
}

#[test]
fn read_returns_a_text_file() {
    let f = fixture();
    let out = read(&cfg(&f), &f.paths, "Notes", "house/boiler.md", 0).unwrap();
    assert!(out.content.contains("serviced in March"));
    assert!(!out.truncated);
    assert_eq!(out.size, out.content.len() as u64);
    // Folder names ignore case, and ./ and backslashes are fine.
    let again = read(&cfg(&f), &f.paths, "notes", "./house\\boiler.md", 0).unwrap();
    assert_eq!(again.content, out.content);
}

#[test]
fn read_cuts_long_files_on_a_character() {
    let f = fixture();
    fs::write(f.notes.join("long.md"), "é".repeat(1000)).unwrap();
    let out = read(&cfg(&f), &f.paths, "Notes", "long.md", 101).unwrap();
    assert!(out.truncated);
    assert_eq!(out.size, 2000);
    assert_eq!(out.content, "é".repeat(50));
    // Never more than the Runner's own limit, whatever the server asks.
    fs::write(f.notes.join("huge.md"), "a".repeat(MAX_READ + 5)).unwrap();
    let huge = read(&cfg(&f), &f.paths, "Notes", "huge.md", u32::MAX as usize).unwrap();
    assert_eq!(huge.content.len(), MAX_READ);
    assert!(huge.truncated);
}

#[test]
fn read_lists_a_folder() {
    let f = fixture();
    fs::write(f.notes.join(".secret"), "x").unwrap();
    let out = read(&cfg(&f), &f.paths, "Notes", "", 0).unwrap();
    assert_eq!(out.content, "house/\ntodo.txt");
    let sub = read(&cfg(&f), &f.paths, "Notes", "house", 0).unwrap();
    assert_eq!(sub.content, "boiler.md");
}

#[test]
fn read_refuses_paths_that_leave_the_folder() {
    let f = fixture();
    let c = cfg(&f);
    let err = |p: &str| read(&c, &f.paths, "Notes", p, 0).unwrap_err();
    assert!(err("../Private/secret.md").contains("outside the shared folder Notes"));
    assert!(err("house/../../Private/secret.md").contains("outside"));
    assert!(err("../nothing-here.md").contains("outside"));
    assert!(err(&f.private.join("secret.md").display().to_string()).contains("relative"));
    assert!(err("/etc/passwd").contains("relative"));
    assert!(err("nope.md").contains("There's no nope.md in Notes"));
}

#[cfg(unix)]
#[test]
fn read_refuses_a_symlink_out() {
    let f = fixture();
    symlink(&f.private.join("secret.md"), &f.notes.join("link.md"));
    symlink(&f.private, &f.notes.join("private"));
    let c = cfg(&f);
    let err = |p: &str| read(&c, &f.paths, "Notes", p, 0).unwrap_err();
    assert!(err("link.md").contains("outside"));
    assert!(err("private/secret.md").contains("outside"));
    assert!(err("private").contains("outside"));
    // A link that stays inside is fine.
    symlink(&f.notes.join("todo.txt"), &f.notes.join("todo-link.txt"));
    let ok = read(&c, &f.paths, "Notes", "todo-link.txt", 0).unwrap();
    assert!(ok.content.contains("call the bank"));
}

#[test]
fn read_refuses_hidden_binary_and_unknown_folders() {
    let f = fixture();
    fs::create_dir_all(f.notes.join(".obsidian")).unwrap();
    fs::write(f.notes.join(".obsidian/workspace.json"), "{}").unwrap();
    fs::write(f.notes.join("photo.jpg"), b"\xff\xd8\xff\0\x10JFIF").unwrap();
    let c = cfg(&f);
    let err = |folder: &str, p: &str| read(&c, &f.paths, folder, p, 0).unwrap_err();
    assert!(err("Notes", ".obsidian/workspace.json").contains("hidden"));
    assert!(err("Notes", ".obsidian").contains("hidden"));
    assert!(err("Notes", "photo.jpg").contains("binary"));
    assert!(err("Private", "secret.md").contains("doesn't share a folder named"));
    fs::remove_dir_all(&f.notes).unwrap();
    assert!(err("Notes", "todo.txt").contains("gone"));
}

#[cfg(unix)]
#[test]
fn read_refuses_the_runners_own_files() {
    let f = fixture();
    fs::write(f.paths.config_dir.join("runner.key"), "key").unwrap();
    symlink(&f.paths.config_dir, &f.notes.join("runner"));
    let c = cfg(&f);
    // Outside the folder, so refused as that first.
    assert!(
        read(&c, &f.paths, "Notes", "runner/runner.key", 0)
            .unwrap_err()
            .contains("outside")
    );
    // A folder that holds the Runner's home can be shared, but not the Runner's files in it.
    let mut wide = c.clone();
    wide.folders[0].path = f.paths.config_dir.parent().unwrap().to_path_buf();
    let err = read(&wide, &f.paths, "Notes", "home/runner.key", 0).unwrap_err();
    assert!(err.contains("Runner's own"), "{err}");
}

#[test]
fn snippets_keep_the_match_in_view() {
    assert_eq!(snippet("  short line  ", 2), "short line");
    let line = format!("{}boiler{}", "a".repeat(300), "b".repeat(300));
    let s = snippet(&line, 300);
    assert_eq!(s.chars().count(), SNIPPET_CHARS);
    assert!(s.starts_with('…') && s.ends_with('…'));
    assert!(s.contains("boiler"));
    let start = snippet(&format!("boiler{}", "b".repeat(300)), 0);
    assert!(start.starts_with("boiler") && start.ends_with('…'));
    let end = snippet(&format!("{}boiler", "a".repeat(300)), 300);
    assert!(end.ends_with("boiler") && end.starts_with('…'));
}

#[tokio::test]
async fn answers_searches_and_reads_from_the_config_on_disk() {
    let f = fixture();
    // The Manager's copy has no folders: the file on disk is what counts.
    let mgr = Manager::new(f.paths.clone(), Config::default()).unwrap();
    let (tx, mut rx) = mpsc::channel(4);
    mgr.file_search(
        FileSearch {
            request_id: "s1".into(),
            query: "boiler".into(),
            folders: vec![],
            max_results: 50,
        },
        tx.clone(),
    );
    mgr.file_read(
        FileRead {
            request_id: "r1".into(),
            folder: "Notes".into(),
            path: "../Private/secret.md".into(),
            max_bytes: 1024,
        },
        tx.clone(),
    );
    let mut seen = Vec::new();
    for _ in 0..2 {
        match rx.recv().await {
            Some(Body::FileSearchResult(r)) => {
                assert_eq!(r.hits.len(), 3);
                assert_eq!(r.hits[0].folder, "Notes");
                assert_eq!(r.hits[0].path, "house/boiler.md");
                assert!(r.error.is_empty());
                seen.push(r.request_id);
            }
            Some(Body::FileReadResult(r)) => {
                assert!(r.content.is_empty());
                assert!(r.error.contains("outside"), "{}", r.error);
                seen.push(r.request_id);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    seen.sort();
    assert_eq!(seen, ["r1", "s1"]);

    // Removing the folder counts at once.
    remove(&f.paths, "Notes").unwrap();
    mgr.file_read(
        FileRead {
            request_id: "r2".into(),
            folder: "Notes".into(),
            path: "todo.txt".into(),
            max_bytes: 1024,
        },
        tx,
    );
    match rx.recv().await {
        Some(Body::FileReadResult(r)) => assert!(r.error.contains("no folders"), "{}", r.error),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn config_keeps_folders_and_files_through_toml() {
    let old: Config = toml::from_str("name = \"laptop\"\n").unwrap();
    assert!(old.files, "configs from before the setting keep working");
    assert!(old.folders.is_empty());
    let c = Config {
        files: false,
        folders: vec![FolderEntry {
            name: "Notes".into(),
            path: "/home/me/Notes".into(),
        }],
        ..Config::default()
    };
    let text = toml::to_string_pretty(&c).unwrap();
    assert!(text.contains("files = false"));
    let back: Config = toml::from_str(&text).unwrap();
    assert_eq!(back.folders, c.folders);
    assert!(!back.files);
}

/// The budget: a search over 20,000 files answers in under 2 seconds. Run it
/// with `cargo test --release -p sling-runner -- --ignored search_budget --nocapture`.
#[test]
#[ignore]
fn search_budget_over_20000_files() {
    let f = fixture();
    for d in 0..200 {
        let dir = f.notes.join(format!("d{d:03}"));
        fs::create_dir_all(&dir).unwrap();
        for i in 0..100 {
            let body = format!(
                "# Note {d}-{i}\n\n{}\nSomething about the garden.\n",
                "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(40)
            );
            fs::write(dir.join(format!("n{i:03}.md")), body).unwrap();
        }
    }
    let c = cfg(&f);
    let mut times = Vec::new();
    for _ in 0..5 {
        let t = Instant::now();
        let out = search(&c, "boiler", &[], 50).unwrap();
        times.push(t.elapsed());
        assert_eq!(out.hits.len(), 3);
        assert!(!out.truncated);
    }
    times.sort();
    println!("search over 20,002 files: {times:?}");
    assert!(times[4] < SEARCH_BUDGET);
}
