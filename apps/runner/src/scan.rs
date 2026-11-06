//! Finds git repos on this machine, so the owner can choose in Sling which
//! ones it may use. Sling can only add a repo this scan found, so a
//! compromised control plane can't point the Runner at any other path.

use std::collections::{HashSet, VecDeque};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sling_runner_protocol::FoundRepo;

use crate::config::{Config, Paths};
use crate::git;

/// How far below a scan root to look. A repo at `~/code/org/team/repo` is
/// depth 4.
pub const MAX_DEPTH: usize = 4;
/// Most repos one scan reports.
pub const MAX_REPOS: usize = 300;
/// How long one scan may walk the disk.
pub const TIME_LIMIT: Duration = Duration::from_secs(3);

/// Directory names never looked into: build output, dependencies, and the
/// macOS and Windows folders that hold apps, media, and app data. Hidden
/// directories are skipped too.
const SKIPPED: &[&str] = &[
    "node_modules",
    "target",
    "vendor",
    "dist",
    "build",
    "Library",
    "Applications",
    "Movies",
    "Music",
    "Pictures",
    "AppData",
];

/// A repo the scan found, before it gets a suggested name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    /// Canonical path of the working tree.
    pub path: PathBuf,
    pub default_branch: String,
    pub remote_url: String,
}

pub struct Limits {
    pub depth: usize,
    pub repos: usize,
    pub time: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            depth: MAX_DEPTH,
            repos: MAX_REPOS,
            time: TIME_LIMIT,
        }
    }
}

/// A directory with a `.git` directory or file (worktrees and submodules
/// have a file).
pub fn is_repo(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(".git")).is_ok_and(|m| m.is_dir() || m.is_file())
}

fn skipped_name(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    name.starts_with('.') || SKIPPED.contains(&name.as_ref())
}

/// Walks `roots` breadth first and returns the repos under them, sorted.
/// Never descends into a repo, except that a root which is itself a repo is
/// both listed and searched. Doesn't follow symlinks, and never enters
/// anything under `skip`.
pub fn walk(roots: &[PathBuf], skip: &[PathBuf], limits: &Limits) -> Vec<PathBuf> {
    let started = Instant::now();
    let mut queue: VecDeque<(PathBuf, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut found = Vec::new();
    while let Some((dir, depth)) = queue.pop_front() {
        if found.len() >= limits.repos || started.elapsed() >= limits.time {
            break;
        }
        if skip.iter().any(|s| dir.starts_with(s)) || !visited.insert(dir.clone()) {
            continue;
        }
        if is_repo(&dir) {
            if dir.to_str().is_some() {
                found.push(dir.clone());
            }
            if depth > 0 {
                continue;
            }
        }
        if depth >= limits.depth {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut children: Vec<PathBuf> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| !skipped_name(&e.file_name()))
            .map(|e| e.path())
            .collect();
        children.sort();
        queue.extend(children.into_iter().map(|c| (c, depth + 1)));
    }
    found.sort();
    found.dedup();
    found
}

/// Scans the configured roots for repos that aren't configured yet, and
/// looks up their default branch and remote.
pub async fn scan(cfg: &Config, paths: &Paths) -> Vec<Found> {
    let canonical = |p: &Path| std::fs::canonicalize(p).ok();
    let roots: Vec<PathBuf> = cfg
        .scan_roots()
        .iter()
        .filter_map(|p| canonical(p))
        .collect();
    // Task worktrees are git checkouts too; they live under the data dir.
    let skip: Vec<PathBuf> = [cfg.worktree_root(paths), paths.data_dir.clone()]
        .iter()
        .filter_map(|p| canonical(p))
        .collect();
    let started = Instant::now();
    let dirs = tokio::task::spawn_blocking(move || walk(&roots, &skip, &Limits::default()))
        .await
        .unwrap_or_default();
    let dirs: Vec<PathBuf> = dirs
        .into_iter()
        .filter(|d| !cfg.repos.iter().any(|r| &r.path == d))
        .collect();
    let found: Vec<Found> = futures_util::stream::iter(dirs)
        .map(|path| async move {
            Found {
                default_branch: git::default_branch(&path).await,
                remote_url: git::remote_url(&path).await.unwrap_or_default(),
                path,
            }
        })
        .buffered(8)
        .collect()
        .await;
    tracing::debug!(
        "found {} repos in {:.1}s",
        found.len(),
        started.elapsed().as_secs_f64()
    );
    found
}

/// The found repos that still aren't configured, each with a suggested name:
/// the directory name, made unique against configured repos and the other
/// suggestions by adding `-2`, `-3`, and so on.
pub fn suggest(found: &[Found], cfg: &Config) -> Vec<FoundRepo> {
    let mut taken: HashSet<String> = cfg.repos.iter().map(|r| r.name.clone()).collect();
    found
        .iter()
        .filter(|f| !cfg.repos.iter().any(|r| r.path == f.path))
        .map(|f| {
            let name = unique_name(&base_name(&f.path), &taken);
            taken.insert(name.clone());
            FoundRepo {
                path: f.path.display().to_string(),
                name,
                default_branch: f.default_branch.clone(),
                remote_url: f.remote_url.clone(),
            }
        })
        .collect()
}

/// The directory name, with characters repo names can't use replaced by `-`.
pub fn base_name(path: &Path) -> String {
    let raw = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name: String = raw
        .chars()
        .map(|c| {
            if crate::repos::valid_name_char(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    let name = name.trim_matches('-');
    if name.is_empty() {
        "repo".into()
    } else {
        name.into()
    }
}

fn unique_name(base: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(base) {
        return base.to_string();
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|n| !taken.contains(n))
        .expect("some suffix is free")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RepoEntry;

    fn mkrepo(dir: &Path) {
        std::fs::create_dir_all(dir.join(".git")).unwrap();
    }

    fn rel(root: &Path, found: &[PathBuf]) -> Vec<String> {
        found
            .iter()
            .map(|p| p.strip_prefix(root).unwrap().display().to_string())
            .collect()
    }

    #[test]
    fn finds_repos_down_to_the_depth_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        mkrepo(&root.join("site"));
        mkrepo(&root.join("code/org/team/api"));
        mkrepo(&root.join("code/org/team/deep/too-deep"));
        // A worktree has a .git file instead of a directory.
        std::fs::create_dir_all(root.join("code/wt")).unwrap();
        std::fs::write(root.join("code/wt/.git"), "gitdir: /elsewhere\n").unwrap();
        // Nothing inside a repo is reported, not even another repo.
        mkrepo(&root.join("site/packages/inner"));
        let found = walk(std::slice::from_ref(&root), &[], &Limits::default());
        assert_eq!(rel(&root, &found), ["code/org/team/api", "code/wt", "site"]);
    }

    #[test]
    fn skips_hidden_build_and_system_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        for skipped in [
            ".cache/repo",
            "node_modules/dep",
            "app/target/x",
            "go/vendor/lib",
            "web/dist/out",
            "build/gen",
            "Library/Caches/thing",
            "Applications/Some.app",
            "Movies/clips",
            "Music/songs",
            "Pictures/raw",
            "worktrees/t1",
        ] {
            mkrepo(&root.join(skipped));
        }
        mkrepo(&root.join("code/keep"));
        let found = walk(
            std::slice::from_ref(&root),
            &[root.join("worktrees")],
            &Limits::default(),
        );
        assert_eq!(rel(&root, &found), ["code/keep"]);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        mkrepo(&outside.path().join("secret"));
        std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        mkrepo(&root.join("mine"));
        let found = walk(std::slice::from_ref(&root), &[], &Limits::default());
        assert_eq!(rel(&root, &found), ["mine"]);
    }

    #[test]
    fn stops_at_the_repo_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        for i in 0..10 {
            mkrepo(&root.join(format!("r{i}")));
        }
        let limits = Limits {
            repos: 4,
            ..Limits::default()
        };
        assert_eq!(walk(std::slice::from_ref(&root), &[], &limits).len(), 4);
    }

    #[test]
    fn a_root_that_is_a_repo_is_listed_and_searched() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        mkrepo(&root);
        mkrepo(&root.join("code/site"));
        let found = walk(std::slice::from_ref(&root), &[], &Limits::default());
        assert_eq!(found, [root.clone(), root.join("code/site")]);
    }

    #[test]
    fn suggested_names_are_unique_and_skip_configured_repos() {
        let found = |p: &str| Found {
            path: PathBuf::from(p),
            default_branch: "main".into(),
            remote_url: String::new(),
        };
        let cfg = Config {
            repos: vec![RepoEntry {
                name: "site".into(),
                path: "/code/site".into(),
                network: false,
                ..RepoEntry::default()
            }],
            ..Config::default()
        };
        let list = [
            found("/code/site"),
            found("/work/site"),
            found("/other/site"),
            found("/code/my app"),
            found("/code/api"),
        ];
        let names: Vec<(String, String)> = suggest(&list, &cfg)
            .into_iter()
            .map(|f| (f.path, f.name))
            .collect();
        assert_eq!(
            names,
            [
                ("/work/site".to_string(), "site-2".to_string()),
                ("/other/site".into(), "site-3".into()),
                ("/code/my app".into(), "my-app".into()),
                ("/code/api".into(), "api".into()),
            ]
        );
        assert_eq!(base_name(Path::new("/x/---")), "repo");
    }

    #[tokio::test]
    async fn scan_leaves_out_configured_repos_and_the_data_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(tmp.path()).unwrap();
        for name in ["site", "api"] {
            let dir = root.join("code").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            for args in [
                &["init", "-q", "-b", "trunk"][..],
                &["commit", "-q", "--allow-empty", "-m", "init"],
            ] {
                let ok = std::process::Command::new("git")
                    .args(["-c", "user.email=t@t", "-c", "user.name=t"])
                    .args(args)
                    .current_dir(&dir)
                    .status()
                    .unwrap()
                    .success();
                assert!(ok, "git {args:?}");
            }
        }
        mkrepo(&root.join("sling/data/worktrees/t1"));
        let paths = Paths {
            config_dir: root.join("sling"),
            data_dir: root.join("sling/data"),
        };
        let cfg = Config {
            scan_roots: vec![root.clone()],
            repos: vec![RepoEntry {
                name: "site".into(),
                path: root.join("code/site"),
                network: false,
                ..RepoEntry::default()
            }],
            ..Config::default()
        };
        let found = scan(&cfg, &paths).await;
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].path, root.join("code/api"));
        assert_eq!(found[0].default_branch, "trunk");
        assert_eq!(found[0].remote_url, "");
    }
}
