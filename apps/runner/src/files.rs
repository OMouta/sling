//! Folders the machine's owner shares with Sling, for the assistant to search
//! and read. Only the machine decides which: the inventory reports their
//! names, and paths never leave the machine.
//!
//! This Runner doesn't share folders yet, so it reports none and answers
//! every FileSearch and FileRead with an error.

use std::sync::Arc;

use sling_runner_protocol::envelope::Body;
use sling_runner_protocol::{FileRead, FileReadResult, FileSearch, FileSearchResult};
use tokio::sync::mpsc;

use crate::config::Config;
use crate::tasks::Manager;

const UNSUPPORTED: &str = "This machine's Runner can't share folders. Update sling-runner there.";

/// Names of the shared folders, for the inventory.
pub fn folder_names(_cfg: &Config) -> Vec<String> {
    Vec::new()
}

/// Whether this machine answers FileSearch and FileRead.
pub fn enabled(_cfg: &Config) -> bool {
    false
}

impl Manager {
    /// Handles FileSearch: answers with one FileSearchResult on `out`.
    pub fn file_search(self: &Arc<Self>, r: FileSearch, out: mpsc::Sender<Body>) {
        tokio::spawn(async move {
            let result = FileSearchResult {
                request_id: r.request_id,
                error: UNSUPPORTED.into(),
                ..Default::default()
            };
            let _ = out.send(Body::FileSearchResult(result)).await;
        });
    }

    /// Handles FileRead: answers with one FileReadResult on `out`.
    pub fn file_read(self: &Arc<Self>, r: FileRead, out: mpsc::Sender<Body>) {
        tokio::spawn(async move {
            let result = FileReadResult {
                request_id: r.request_id,
                error: UNSUPPORTED.into(),
                ..Default::default()
            };
            let _ = out.send(Body::FileReadResult(result)).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Paths;

    #[tokio::test]
    async fn answers_searches_and_reads_with_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            config_dir: dir.path().join("home"),
            data_dir: dir.path().join("home/data"),
        };
        let mgr = Manager::new(paths, Config::default()).unwrap();
        let (tx, mut rx) = mpsc::channel(4);
        mgr.file_search(
            FileSearch {
                request_id: "s1".into(),
                query: "boiler".into(),
                ..Default::default()
            },
            tx.clone(),
        );
        mgr.file_read(
            FileRead {
                request_id: "r1".into(),
                folder: "Notes".into(),
                path: "a.md".into(),
                max_bytes: 1024,
            },
            tx,
        );
        let mut seen = Vec::new();
        for _ in 0..2 {
            match rx.recv().await {
                Some(Body::FileSearchResult(r)) => {
                    assert!(r.hits.is_empty() && !r.error.is_empty());
                    seen.push(r.request_id);
                }
                Some(Body::FileReadResult(r)) => {
                    assert!(r.content.is_empty() && !r.error.is_empty());
                    seen.push(r.request_id);
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        seen.sort();
        assert_eq!(seen, ["r1", "s1"]);
        assert!(folder_names(&Config::default()).is_empty());
        assert!(!enabled(&Config::default()));
    }
}
