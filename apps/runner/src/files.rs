//! Folders the machine's owner shares with Sling, for the assistant to search
//! and read: `sling-runner folder add|remove|list`. Only the machine decides
//! which. The inventory reports their names, and every path Sling sends is
//! taken inside one of them and refused if it leads anywhere else.
//!
//! Each request reads `runner.toml` again, so `folder remove` and
//! `config set files off` take effect on the next request, not a minute later.

use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use clap::Subcommand;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use sling_runner_protocol::envelope::Body;
use sling_runner_protocol::{
    FileRead, FileReadResult, FileSearch, FileSearchResult, file_search_result,
};
use tokio::sync::{Semaphore, mpsc};

use crate::config::{Config, Paths};
use crate::tasks::Manager;

/// Most hits one search returns.
pub const MAX_HITS: usize = 50;
/// Most hits from one file, so one long note can't fill the whole answer.
const MAX_HITS_PER_FILE: usize = 5;
/// A search returns what it has after this long.
const SEARCH_BUDGET: Duration = Duration::from_secs(2);
/// Files bigger than this aren't searched.
const MAX_SEARCH_FILE: u64 = 2 * 1024 * 1024;
/// Most of a file one read returns.
pub const MAX_READ: usize = 256 * 1024;
/// A snippet is at most this many characters of its line.
const SNIPPET_CHARS: usize = 200;
const MAX_QUERY_CHARS: usize = 200;
/// Bytes looked at to tell a binary file from a text one.
const SNIFF_BYTES: usize = 8 * 1024;
/// Most entries a folder's listing shows.
const MAX_LISTING: usize = 500;
const MAX_NAME_CHARS: usize = 64;

/// Searches walk the disk on several threads, so only a couple run at once.
static SEARCHES: Semaphore = Semaphore::const_new(2);

const FILES_OFF: &str = "Files are off on this machine. The owner can turn them on there with \
     `sling-runner config set files on`.";
const NONE_SHARED: &str = "This machine shares no folders. The owner can share one there with \
     `sling-runner folder add <path>`.";

/// A folder shared with Sling.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FolderEntry {
    pub name: String,
    pub path: PathBuf,
}

#[derive(Subcommand)]
pub enum FolderCommand {
    /// Share a folder. The assistant can then search and read the text files in it.
    Add {
        path: PathBuf,
        /// The name Sling shows. Defaults to the folder's own name.
        #[arg(long)]
        name: Option<String>,
    },
    /// Stop sharing a folder.
    Remove {
        name: String,
    },
    List,
}

/// `sling-runner folder ...`.
pub fn run_command(paths: &Paths, command: FolderCommand) -> Result<()> {
    match command {
        FolderCommand::Add { path, name } => {
            let f = add(paths, &path, name)?;
            println!("Shared {} ({})", f.name, f.path.display());
            println!("A running Runner tells Sling within a minute.");
            if !Config::load(paths)?.files {
                println!(
                    "Files are off here. Turn them on with `sling-runner config set files on`."
                );
            }
        }
        FolderCommand::Remove { name } => {
            let removed = remove(paths, &name)?;
            println!("Stopped sharing {removed}. Sling can't search or read it from now on.");
        }
        FolderCommand::List => {
            let cfg = Config::load(paths)?;
            if cfg.folders.is_empty() {
                println!("No shared folders. Share one with `sling-runner folder add <path>`.");
            }
            for f in &cfg.folders {
                println!("{:<20} {}", f.name, f.path.display());
            }
            if !cfg.folders.is_empty() && !cfg.files {
                println!("Files are off, so Sling can't search or read these.");
            }
        }
    }
    Ok(())
}

/// What `config show` and `doctor` say about shared folders.
pub fn summary(cfg: &Config) -> String {
    let n = cfg.folders.len();
    let shared = match n {
        0 => "no folders shared".to_string(),
        1 => "1 folder shared".to_string(),
        _ => format!("{n} folders shared"),
    };
    if cfg.files {
        format!("on: {shared}")
    } else {
        format!("off: this machine refuses every search and read ({shared})")
    }
}

/// Names of the shared folders, for the inventory.
pub fn folder_names(cfg: &Config) -> Vec<String> {
    cfg.folders.iter().map(|f| f.name.clone()).collect()
}

/// Whether this machine answers FileSearch and FileRead.
pub fn enabled(cfg: &Config) -> bool {
    cfg.files
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && name.trim() == name
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
        && !name.starts_with('.')
}

/// The Runner's own directories, which no shared folder may reach.
fn own_dirs(paths: &Paths) -> Vec<PathBuf> {
    [&paths.config_dir, &paths.data_dir]
        .into_iter()
        .map(|d| std::fs::canonicalize(d).unwrap_or_else(|_| d.clone()))
        .collect()
}

pub fn add(paths: &Paths, path: &Path, name: Option<String>) -> Result<FolderEntry> {
    let abs = match std::fs::canonicalize(path) {
        Ok(p) => p,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            bail!("{} doesn't exist", path.display())
        }
        Err(e) => return Err(e.into()),
    };
    if !abs.is_dir() {
        bail!("{} isn't a folder", abs.display());
    }
    if abs.parent().is_none() {
        bail!("the whole disk can't be shared; pick a folder");
    }
    if own_dirs(paths).iter().any(|d| abs.starts_with(d)) {
        bail!("{} holds this Runner's own files", abs.display());
    }
    let name = match name {
        Some(n) => n.trim().to_string(),
        None => abs
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "folder".into()),
    };
    if !valid_name(&name) {
        bail!(
            "folder names may use letters, digits, spaces, '-', '_' and '.', up to {MAX_NAME_CHARS} characters. Pick one with --name."
        );
    }
    let mut cfg = Config::load(paths)?;
    if let Some(f) = cfg
        .folders
        .iter()
        .find(|f| f.name.eq_ignore_ascii_case(&name))
    {
        bail!(
            "a folder named {:?} is already shared; pick another name with --name",
            f.name
        );
    }
    for f in &cfg.folders {
        if f.path == abs {
            bail!("{} is already shared as {}", abs.display(), f.name);
        }
        if abs.starts_with(&f.path) {
            bail!("{} is already shared, inside {}", abs.display(), f.name);
        }
        if f.path.starts_with(&abs) {
            bail!(
                "{} holds {}, which is already shared. Remove that one first.",
                abs.display(),
                f.name
            );
        }
    }
    let entry = FolderEntry { name, path: abs };
    cfg.folders.push(entry.clone());
    cfg.save(paths)?;
    Ok(entry)
}

/// Returns the removed folder's name as it was saved.
pub fn remove(paths: &Paths, name: &str) -> Result<String> {
    let mut cfg = Config::load(paths)?;
    let Some(i) = cfg
        .folders
        .iter()
        .position(|f| f.name.eq_ignore_ascii_case(name.trim()))
    else {
        bail!("no shared folder named {name:?}");
    };
    let removed = cfg.folders.remove(i);
    cfg.save(paths)?;
    Ok(removed.name)
}

/// One matching line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub folder: String,
    /// Relative to the folder, with forward slashes.
    pub path: String,
    pub line: u32,
    pub snippet: String,
}

#[derive(Debug, Default)]
pub struct SearchOutcome {
    pub hits: Vec<Hit>,
    /// There were more hits than it returned, or time ran out.
    pub truncated: bool,
}

#[derive(Debug, Default)]
pub struct ReadOutcome {
    pub content: String,
    pub truncated: bool,
    pub size: u64,
}

/// A shared folder, by the name Sling gave, resolved on disk.
fn folder<'a>(cfg: &'a Config, name: &str) -> Result<(&'a FolderEntry, PathBuf), String> {
    if !cfg.files {
        return Err(FILES_OFF.into());
    }
    if cfg.folders.is_empty() {
        return Err(NONE_SHARED.into());
    }
    let Some(entry) = cfg.folders.iter().find(|f| f.name == name).or_else(|| {
        cfg.folders
            .iter()
            .find(|f| f.name.eq_ignore_ascii_case(name))
    }) else {
        return Err(format!(
            "This machine doesn't share a folder named {name:?}. It shares {}.",
            names_list(cfg)
        ));
    };
    match std::fs::canonicalize(&entry.path) {
        Ok(root) if root.is_dir() => Ok((entry, root)),
        _ => Err(format!(
            "The shared folder {} is gone from this machine.",
            entry.name
        )),
    }
}

fn names_list(cfg: &Config) -> String {
    cfg.folders
        .iter()
        .map(|f| f.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// `path` relative to `root`, with forward slashes.
fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    Some(
        rel.components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

fn hidden(rel: &str) -> bool {
    rel.split('/').any(|part| part.starts_with('.'))
}

/// Searches the shared folders, or the ones named, for lines that contain
/// `query`, ignoring case. Hidden files, `.git`, `node_modules`, files that
/// `.gitignore` or `.ignore` leave out, files over 2 MB, and binary files are
/// skipped, and so are symlinks, so a search never leaves a folder.
pub fn search(
    cfg: &Config,
    query: &str,
    folders: &[String],
    max: usize,
) -> Result<SearchOutcome, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("There's nothing to search for.".into());
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(format!(
            "The search is longer than {MAX_QUERY_CHARS} characters."
        ));
    }
    if !cfg.files {
        return Err(FILES_OFF.into());
    }
    if cfg.folders.is_empty() {
        return Err(NONE_SHARED.into());
    }
    let max = if max == 0 {
        MAX_HITS
    } else {
        max.min(MAX_HITS)
    };
    let mut roots: Vec<(String, PathBuf)> = Vec::new();
    let mut gone = Vec::new();
    if folders.is_empty() {
        for f in &cfg.folders {
            match folder(cfg, &f.name) {
                Ok((entry, root)) => roots.push((entry.name.clone(), root)),
                Err(_) => gone.push(f.name.clone()),
            }
        }
    } else {
        for name in folders {
            let (entry, root) = folder(cfg, name)?;
            if !roots.iter().any(|(n, _)| n == &entry.name) {
                roots.push((entry.name.clone(), root));
            }
        }
    }
    if roots.is_empty() {
        return Err(format!(
            "The shared folders {} are gone from this machine.",
            gone.join(", ")
        ));
    }

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(true)
        .fixed_strings(true)
        .build(query)
        .map_err(|e| format!("Can't search for that: {e}"))?;
    let deadline = Instant::now() + SEARCH_BUDGET;
    let found: Arc<Mutex<Vec<Hit>>> = Arc::default();
    let truncated = Arc::new(AtomicBool::new(false));

    let mut walk = WalkBuilder::new(&roots[0].1);
    for (_, root) in &roots[1..] {
        walk.add(root);
    }
    walk.hidden(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false)
        .ignore(true)
        .parents(false)
        .follow_links(false)
        .max_filesize(Some(MAX_SEARCH_FILE))
        .filter_entry(|e| {
            let n = e.file_name();
            n != "node_modules" && n != ".git"
        });
    let roots = Arc::new(roots);
    walk.build_parallel().run(|| {
        let matcher = matcher.clone();
        let found = found.clone();
        let truncated = truncated.clone();
        let roots = roots.clone();
        let mut searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::quit(0))
            .line_number(true)
            .build();
        Box::new(move |entry| {
            if Instant::now() > deadline {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            // Symlinks are never followed, in or out.
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let path = entry.path();
            let Some((name, rel)) = roots
                .iter()
                .filter(|(_, root)| path.starts_with(root))
                .max_by_key(|(_, root)| root.as_os_str().len())
                .and_then(|(name, root)| relative(root, path).map(|rel| (name.clone(), rel)))
            else {
                return WalkState::Continue;
            };
            let mut sink = FileSink {
                matcher: &matcher,
                hits: Vec::new(),
                more: false,
                binary: false,
            };
            if searcher.search_path(&matcher, path, &mut sink).is_err() || sink.binary {
                return WalkState::Continue;
            }
            if sink.hits.is_empty() {
                return WalkState::Continue;
            }
            if sink.more {
                truncated.store(true, Ordering::Relaxed);
            }
            let mut all = found.lock().unwrap();
            for (line, snippet) in sink.hits {
                if all.len() >= max {
                    truncated.store(true, Ordering::Relaxed);
                    return WalkState::Quit;
                }
                all.push(Hit {
                    folder: name.clone(),
                    path: rel.clone(),
                    line,
                    snippet,
                });
            }
            WalkState::Continue
        })
    });

    let mut hits = std::mem::take(&mut *found.lock().unwrap());
    hits.sort_by(|a, b| (&a.folder, &a.path, a.line).cmp(&(&b.folder, &b.path, b.line)));
    Ok(SearchOutcome {
        hits,
        truncated: truncated.load(Ordering::Relaxed),
    })
}

/// Collects one file's matching lines. A binary file gives none.
struct FileSink<'m> {
    matcher: &'m RegexMatcher,
    hits: Vec<(u32, String)>,
    /// The file had more matching lines than it keeps.
    more: bool,
    binary: bool,
}

impl Sink for FileSink<'_> {
    type Error = io::Error;

    fn matched(&mut self, _: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
        if self.hits.len() >= MAX_HITS_PER_FILE {
            self.more = true;
            return Ok(false);
        }
        let line = String::from_utf8_lossy(mat.bytes());
        let line = line.trim_end_matches(['\n', '\r']);
        let at = grep_matcher::Matcher::find(self.matcher, line.as_bytes())
            .ok()
            .flatten()
            .map(|m| line[..m.start()].chars().count())
            .unwrap_or(0);
        let n = mat.line_number().unwrap_or(0);
        self.hits
            .push((u32::try_from(n).unwrap_or(u32::MAX), snippet(line, at)));
        Ok(true)
    }

    fn binary_data(&mut self, _: &Searcher, _: u64) -> Result<bool, io::Error> {
        self.binary = true;
        Ok(false)
    }
}

/// At most SNIPPET_CHARS of `line` around the character at `at`, trimmed,
/// with "…" where it was cut.
pub fn snippet(line: &str, at: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    let first = chars.iter().position(|c| !c.is_whitespace()).unwrap_or(0);
    let last = chars
        .iter()
        .rposition(|c| !c.is_whitespace())
        .map_or(0, |i| i + 1);
    if last <= first {
        return String::new();
    }
    let chars = &chars[first..last];
    let at = at.saturating_sub(first).min(chars.len());
    if chars.len() <= SNIPPET_CHARS {
        return chars.iter().collect();
    }
    // Leave room for the ellipses, and show some of what comes before the match.
    let room = SNIPPET_CHARS - 2;
    let start = at.saturating_sub(room / 3).min(chars.len() - room);
    let end = start + room;
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// Reads a text file in a shared folder, or lists a folder in it, refusing a
/// path that leaves the folder once `..` and symlinks are resolved, a hidden
/// file or folder, the Runner's own files, and binary files.
pub fn read(
    cfg: &Config,
    paths: &Paths,
    folder_name: &str,
    path: &str,
    max: usize,
) -> Result<ReadOutcome, String> {
    let (entry, root) = folder(cfg, folder_name)?;
    let max = if max == 0 {
        MAX_READ
    } else {
        max.min(MAX_READ)
    };
    let asked = path.trim().replace('\\', "/");
    let asked = asked.trim_start_matches("./");
    let rel = Path::new(asked);
    if rel
        .components()
        .any(|c| matches!(c, Component::RootDir | Component::Prefix(_)))
    {
        return Err(format!(
            "Paths are relative to the folder: {asked} isn't. Leave out everything up to {}/.",
            entry.name
        ));
    }
    let outside = || format!("{asked} is outside the shared folder {}.", entry.name);
    let resolved = match std::fs::canonicalize(root.join(rel)) {
        Ok(p) => p,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            // A path that climbs out is refused as such, even when there's nothing there.
            if rel.components().any(|c| c == Component::ParentDir) {
                return Err(outside());
            }
            return Err(format!("There's no {asked} in {}.", entry.name));
        }
        Err(e) => return Err(format!("Can't open {asked}: {e}")),
    };
    if !resolved.starts_with(&root) {
        return Err(outside());
    }
    let shown = relative(&root, &resolved).unwrap_or_default();
    if hidden(&shown) {
        return Err(format!(
            "{asked} is hidden. Hidden files and folders aren't shared."
        ));
    }
    if own_dirs(paths).iter().any(|d| resolved.starts_with(d)) {
        return Err(format!("{asked} holds this Runner's own files."));
    }
    let meta = std::fs::metadata(&resolved).map_err(|e| format!("Can't open {asked}: {e}"))?;
    if meta.is_dir() {
        return Ok(listing(&resolved, max));
    }
    if !meta.is_file() {
        return Err(format!("{asked} isn't a file."));
    }
    read_text(&resolved, asked, meta.len(), max)
}

/// A folder's entries, one per line, folders ending in `/`. Hidden ones and
/// `node_modules` are left out, as a search leaves them out.
fn listing(dir: &Path, max: usize) -> ReadOutcome {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') || name == "node_modules" {
                        return None;
                    }
                    let dir = e.file_type().is_ok_and(|t| t.is_dir());
                    Some(if dir { format!("{name}/") } else { name })
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort_by_key(|n| n.to_lowercase());
    let count = names.len();
    let mut truncated = count > MAX_LISTING;
    names.truncate(MAX_LISTING);
    let mut content = names.join("\n");
    if content.len() > max {
        content.truncate(floor_char_boundary(&content, max));
        truncated = true;
    }
    ReadOutcome {
        size: content.len() as u64,
        content,
        truncated,
    }
}

fn read_text(path: &Path, asked: &str, size: u64, max: usize) -> Result<ReadOutcome, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("Can't open {asked}: {e}"))?;
    let mut buf = Vec::with_capacity(max.min(size as usize) + 1);
    file.take(max as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Can't read {asked}: {e}"))?;
    if buf[..buf.len().min(SNIFF_BYTES)].contains(&0) {
        return Err(format!(
            "{asked} is a binary file. Only text files can be read."
        ));
    }
    let truncated = size > buf.len() as u64;
    let content = match std::str::from_utf8(&buf) {
        Ok(s) => s.to_string(),
        // Cut in the middle of a character.
        Err(e) if e.error_len().is_none() => {
            String::from_utf8_lossy(&buf[..e.valid_up_to()]).into_owned()
        }
        Err(_) => String::from_utf8_lossy(&buf).into_owned(),
    };
    Ok(ReadOutcome {
        content,
        truncated,
        size,
    })
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

impl Manager {
    /// The config on disk now, so a folder removed or `files off` counts at once.
    fn files_config(&self) -> Config {
        match Config::load(&self.paths) {
            Ok(cfg) => cfg,
            Err(e) => {
                tracing::warn!("could not read the config for a file request: {e:#}");
                self.config()
            }
        }
    }

    /// Handles FileSearch: answers with one FileSearchResult on `out`.
    pub fn file_search(self: &Arc<Self>, r: FileSearch, out: mpsc::Sender<Body>) {
        let mgr = self.clone();
        tokio::spawn(async move {
            let request_id = r.request_id.clone();
            let outcome = match SEARCHES.acquire().await {
                Ok(_permit) => {
                    let cfg = mgr.files_config();
                    tokio::task::spawn_blocking(move || {
                        search(&cfg, &r.query, &r.folders, r.max_results as usize)
                    })
                    .await
                    .unwrap_or_else(|e| Err(format!("The search failed: {e}")))
                }
                Err(_) => Err("The Runner is stopping.".into()),
            };
            let result = match outcome {
                Ok(o) => FileSearchResult {
                    request_id,
                    hits: o
                        .hits
                        .into_iter()
                        .map(|h| file_search_result::Hit {
                            folder: h.folder,
                            path: h.path,
                            line: h.line,
                            snippet: h.snippet,
                        })
                        .collect(),
                    truncated: o.truncated,
                    error: String::new(),
                },
                Err(error) => FileSearchResult {
                    request_id,
                    error,
                    ..Default::default()
                },
            };
            let _ = out.send(Body::FileSearchResult(result)).await;
        });
    }

    /// Handles FileRead: answers with one FileReadResult on `out`.
    pub fn file_read(self: &Arc<Self>, r: FileRead, out: mpsc::Sender<Body>) {
        let mgr = self.clone();
        tokio::spawn(async move {
            let request_id = r.request_id.clone();
            let cfg = mgr.files_config();
            let paths = mgr.paths.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                read(&cfg, &paths, &r.folder, &r.path, r.max_bytes as usize)
            })
            .await
            .unwrap_or_else(|e| Err(format!("The read failed: {e}")));
            let result = match outcome {
                Ok(o) => FileReadResult {
                    request_id,
                    content: o.content,
                    truncated: o.truncated,
                    error: String::new(),
                    size: o.size,
                },
                Err(error) => FileReadResult {
                    request_id,
                    error,
                    ..Default::default()
                },
            };
            let _ = out.send(Body::FileReadResult(result)).await;
        });
    }
}

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;
