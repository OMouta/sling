//! Runs tasks the control plane assigns, inside the limits set in the local
//! config. Every check here holds even if the control plane is compromised:
//! the repo allowlist (D17), the mode cap (D14), branch naming, and the push
//! guard.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use sling_harness_codex as codex;
use sling_runner_protocol::{
    ActionRequest, ActionResult, DiffStats, HeldTask, LogLine, TaskAccepted, TaskAssign, TaskEvent,
    TaskFinished, TaskRejected, TaskStarted, action_request, action_result, log_line,
    task_event::Kind, task_finished, task_rejected,
};
use tokio::sync::{Notify, mpsc, watch};

use crate::config::{Config, Mode, Paths};
use crate::git;
use crate::spool::{SpoolState, TaskMeta, TaskSpool, open_all};
use crate::sys::now_ms;

const CANCEL_GRACE: Duration = Duration::from_secs(10);

type SharedSpool = Arc<Mutex<TaskSpool>>;

pub struct Manager {
    pub paths: Paths,
    config: Mutex<Config>,
    spools: Mutex<HashMap<String, SharedSpool>>,
    running: Mutex<HashMap<String, watch::Sender<bool>>>,
    /// Cancels that arrived before their task started.
    early_cancels: Mutex<HashSet<String>>,
    /// Wakes the connection to flush new events.
    pub outbox: Notify,
}

impl Manager {
    /// Loads spools from disk. Tasks that were running when the Runner died are
    /// finished as interrupted, so the server learns what happened.
    pub fn new(paths: Paths, config: Config) -> Result<Arc<Manager>> {
        std::fs::create_dir_all(paths.spool_dir())?;
        let mut spools = HashMap::new();
        for mut spool in open_all(&paths.spool_dir()) {
            if spool.meta.state == SpoolState::Running {
                tracing::warn!(task = spool.task_id(), "task was interrupted by a restart");
                if let Some(pid) = spool.meta.harness_pid {
                    crate::sys::kill_orphan_group(pid, "codex");
                }
                spool.append(Kind::Finished(TaskFinished {
                    outcome: task_finished::Outcome::Interrupted as i32,
                    error: "The Runner stopped while this task was running.".into(),
                    branch: spool.meta.branch.clone(),
                    ..Default::default()
                }))?;
                spool.set_meta(|m| m.state = SpoolState::Finished)?;
            }
            spools.insert(spool.task_id().to_string(), Arc::new(Mutex::new(spool)));
        }
        Ok(Arc::new(Manager {
            paths,
            config: Mutex::new(config),
            spools: Mutex::new(spools),
            running: Mutex::new(HashMap::new()),
            early_cancels: Mutex::new(HashSet::new()),
            outbox: Notify::new(),
        }))
    }

    pub fn config(&self) -> Config {
        self.config.lock().unwrap().clone()
    }

    pub fn set_config(&self, cfg: Config) {
        *self.config.lock().unwrap() = cfg;
    }

    pub fn running_count(&self) -> usize {
        self.running.lock().unwrap().len()
    }

    pub fn held_tasks(&self) -> Vec<HeldTask> {
        let running = self.running.lock().unwrap();
        self.spools
            .lock()
            .unwrap()
            .iter()
            .map(|(id, s)| HeldTask {
                task_id: id.clone(),
                running: running.contains_key(id),
                last_seq: s.lock().unwrap().last_seq(),
            })
            .collect()
    }

    /// Everything not yet sent on the current connection.
    pub fn unsent(&self) -> Vec<TaskEvent> {
        let spools: Vec<SharedSpool> = self.spools.lock().unwrap().values().cloned().collect();
        let mut out = Vec::new();
        for s in spools {
            out.extend(s.lock().unwrap().unsent());
        }
        out
    }

    pub fn reset_sent(&self) {
        for s in self.spools.lock().unwrap().values() {
            s.lock().unwrap().reset_sent();
        }
    }

    pub fn ack(&self, task_id: &str, seq: u64) {
        if let Some(s) = self.spool(task_id)
            && let Err(e) = s.lock().unwrap().ack(seq)
        {
            tracing::warn!("ack failed for {task_id}: {e:#}");
        }
    }

    /// Drops spools the server is done with. Worktrees stay until `gc`.
    pub fn forget(&self, ids: &[String]) {
        let running = self.running.lock().unwrap();
        let mut spools = self.spools.lock().unwrap();
        for id in ids {
            if running.contains_key(id) {
                continue;
            }
            if let Some(s) = spools.remove(id)
                && let Ok(s) = Arc::try_unwrap(s)
                && let Err(e) = s.into_inner().unwrap().remove()
            {
                tracing::warn!("could not remove spool {id}: {e:#}");
            }
        }
    }

    fn spool(&self, task_id: &str) -> Option<SharedSpool> {
        self.spools.lock().unwrap().get(task_id).cloned()
    }

    fn emit(&self, spool: &SharedSpool, kind: Kind) {
        if let Err(e) = spool.lock().unwrap().append(kind) {
            tracing::error!("could not write task event: {e:#}");
        }
        self.outbox.notify_one();
    }

    fn log(&self, spool: &SharedSpool, text: impl Into<String>) {
        self.emit(
            spool,
            Kind::Log(LogLine {
                stream: log_line::Stream::Runner as i32,
                text: text.into(),
            }),
        );
    }

    /// Handles TaskAssign. Accepted tasks start running in the background.
    pub async fn assign(self: &Arc<Self>, a: TaskAssign, codex_ready: bool) {
        if self.spool(&a.task_id).is_some() {
            // Already known, for example a re-send after a reconnect.
            return;
        }
        let cfg = self.config();
        let mode = Mode::from_proto(a.mode());
        let repo = cfg.repo(&a.repo).cloned();
        let default_branch = match &repo {
            Some(r) => git::default_branch(&r.path).await,
            None => String::new(),
        };

        let reject = match () {
            _ if repo.is_none() => Some((
                task_rejected::Reason::UnknownRepo,
                format!("This machine has no repo named {:?}.", a.repo),
            )),
            _ if a.mode() == sling_runner_protocol::PermissionMode::Unspecified => Some((
                task_rejected::Reason::Invalid,
                "No permission mode set.".into(),
            )),
            _ if mode > cfg.max_mode => Some((
                task_rejected::Reason::ModeAboveCap,
                format!(
                    "This machine allows at most {} mode; the task asked for {}.",
                    cfg.max_mode.as_str(),
                    mode.as_str()
                ),
            )),
            _ if a.harness != "codex" => Some((
                task_rejected::Reason::HarnessUnavailable,
                format!("Unknown harness {:?}.", a.harness),
            )),
            _ if !codex_ready => Some((
                task_rejected::Reason::HarnessUnavailable,
                "Codex is not installed or not logged in on this machine.".into(),
            )),
            _ if !git::valid_task_branch(&a.branch, &default_branch) => Some((
                task_rejected::Reason::Invalid,
                format!("Refusing branch name {:?}.", a.branch),
            )),
            _ if self.running_count() >= cfg.max_concurrent_tasks as usize => Some((
                task_rejected::Reason::Busy,
                "This machine is already running as many tasks as it allows.".into(),
            )),
            _ => None,
        };

        let meta = TaskMeta {
            task_id: a.task_id.clone(),
            repo: a.repo.clone(),
            title: a.title.clone(),
            objective: a.objective.clone(),
            mode,
            harness: a.harness.clone(),
            branch: a.branch.clone(),
            default_branch,
            worktree: None,
            base_sha: None,
            harness_pid: None,
            state: if reject.is_some() {
                SpoolState::Finished
            } else {
                SpoolState::Running
            },
            created_ms: now_ms(),
        };
        let spool = match TaskSpool::create(&self.paths.spool_dir(), meta) {
            Ok(s) => Arc::new(Mutex::new(s)),
            Err(e) => {
                tracing::error!("cannot create spool for {}: {e:#}", a.task_id);
                return;
            }
        };
        self.spools
            .lock()
            .unwrap()
            .insert(a.task_id.clone(), spool.clone());

        if let Some((reason, message)) = reject {
            tracing::info!(task = a.task_id, "rejected: {message}");
            self.emit(
                &spool,
                Kind::Rejected(TaskRejected {
                    reason: reason as i32,
                    message,
                }),
            );
            return;
        }

        let cancelled_early = self.early_cancels.lock().unwrap().remove(&a.task_id);
        let (cancel_tx, cancel_rx) = watch::channel(cancelled_early);
        self.running
            .lock()
            .unwrap()
            .insert(a.task_id.clone(), cancel_tx);
        self.emit(&spool, Kind::Accepted(TaskAccepted {}));

        let me = self.clone();
        let repo = repo.expect("checked above");
        tokio::spawn(async move {
            let task_id = a.task_id.clone();
            let finished = match me
                .run(&spool, &a, mode, repo.path.clone(), repo.network, cancel_rx)
                .await
            {
                Ok(f) => f,
                Err(e) => TaskFinished {
                    outcome: task_finished::Outcome::Failed as i32,
                    error: format!("{e:#}"),
                    branch: a.branch.clone(),
                    ..Default::default()
                },
            };
            me.emit(&spool, Kind::Finished(finished));
            let _ = spool
                .lock()
                .unwrap()
                .set_meta(|m| m.state = SpoolState::Finished);
            me.running.lock().unwrap().remove(&task_id);
        });
    }

    async fn run(
        self: &Arc<Self>,
        spool: &SharedSpool,
        a: &TaskAssign,
        mode: Mode,
        repo_path: PathBuf,
        network: bool,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<TaskFinished> {
        if *cancel.borrow() {
            return Ok(TaskFinished {
                outcome: task_finished::Outcome::Cancelled as i32,
                error: "Cancelled before it started.".into(),
                branch: a.branch.clone(),
                ..Default::default()
            });
        }
        let cfg = self.config();
        if let Err(e) = git::fetch(&repo_path).await {
            self.log(spool, format!("git fetch failed, using local refs: {e:#}"));
        }
        let default_branch = spool.lock().unwrap().meta.default_branch.clone();
        let (base_ref, base_sha) = git::base_ref(&repo_path, &default_branch).await?;
        let worktree = cfg.worktree_root(&self.paths).join(&a.task_id);
        git::worktree_add(&repo_path, &worktree, &a.branch, &base_sha)
            .await
            .context("creating the task worktree")?;
        spool.lock().unwrap().set_meta(|m| {
            m.worktree = Some(worktree.clone());
            m.base_sha = Some(base_sha.clone());
        })?;

        let detection = codex::detect(&cfg.codex_bin()).await;
        self.emit(
            spool,
            Kind::Started(TaskStarted {
                branch: a.branch.clone(),
                base_sha: base_sha.clone(),
                worktree_path: worktree.display().to_string(),
                harness: "codex".into(),
                harness_version: detection.version.clone(),
            }),
        );
        self.log(spool, format!("Branched {} from {base_ref}", a.branch));

        let opts = codex::RunOptions {
            bin: cfg.codex_bin(),
            cwd: worktree.clone(),
            prompt: codex::build_prompt(&a.title, &a.objective, mode.writes()),
            sandbox: mode.sandbox().into(),
            network,
        };
        let (tx, mut rx) = mpsc::channel(256);
        let (mut run, reader) = codex::Run::start(&opts, tx).await?;
        spool
            .lock()
            .unwrap()
            .set_meta(|m| m.harness_pid = run.pid())?;
        let mut cancelled = false;
        loop {
            tokio::select! {
                ev = rx.recv() => match ev {
                    Some(codex::Event::Task(kind)) => self.emit(spool, kind),
                    Some(codex::Event::ThreadStarted(id)) => {
                        self.log(spool, format!("Codex session {id}"))
                    }
                    None => break,
                },
                changed = cancel.changed(), if !cancelled => {
                    if changed.is_ok() && *cancel.borrow() {
                        cancelled = true;
                        self.log(spool, "Cancelling Codex");
                        run.cancel(CANCEL_GRACE).await;
                    }
                }
            }
        }
        let exit = run.wait().await?;
        let outcome = reader.finish(exit).await;

        let base = TaskFinished {
            branch: a.branch.clone(),
            summary: outcome.summary.clone(),
            ..Default::default()
        };
        if cancelled {
            return Ok(TaskFinished {
                outcome: task_finished::Outcome::Cancelled as i32,
                error: "Cancelled.".into(),
                ..base
            });
        }
        if let Some(failure) = outcome.failure.clone().filter(|_| exit != Some(0)) {
            return Ok(TaskFinished {
                outcome: task_finished::Outcome::Failed as i32,
                error: failure,
                ..base
            });
        }
        if exit != Some(0) {
            return Ok(TaskFinished {
                outcome: task_finished::Outcome::Failed as i32,
                error: format!("Codex exited with code {exit:?}."),
                ..base
            });
        }

        let mut finished = TaskFinished {
            outcome: task_finished::Outcome::Succeeded as i32,
            ..base
        };
        if mode.writes() {
            let message = format!("{}\n\nSling-Task: {}", a.title, a.task_id);
            if let Some(c) = git::commit_all(&worktree, &message, &base_sha).await? {
                self.log(
                    spool,
                    format!("Committed {}", &c.sha[..12.min(c.sha.len())]),
                );
                finished.commit_sha = c.sha;
                finished.diff_stats = Some(DiffStats {
                    files_changed: c.files_changed,
                    insertions: c.insertions,
                    deletions: c.deletions,
                });
            } else {
                self.log(spool, "No changes to commit");
            }
        }
        Ok(finished)
    }

    pub fn cancel(&self, task_id: &str) {
        if let Some(tx) = self.running.lock().unwrap().get(task_id) {
            let _ = tx.send(true);
        } else if self.spool(task_id).is_none() {
            self.early_cancels
                .lock()
                .unwrap()
                .insert(task_id.to_string());
        }
    }

    /// Push and open-PR. The control plane already applied the mode's approval
    /// gate; the Runner still refuses anything outside its own rules.
    pub async fn action(self: &Arc<Self>, req: ActionRequest) {
        let Some(spool) = self.spool(&req.task_id) else {
            tracing::warn!("action for unknown task {}", req.task_id);
            return;
        };
        let meta = spool.lock().unwrap().meta.clone();
        let kind = req.kind();
        let result = self.perform(&meta, &req).await;
        let (outcome, message, url) = match result {
            Ok((url, message)) => (action_result::Outcome::Succeeded, message, url),
            Err(ActionError::Refused(m)) => (action_result::Outcome::Refused, m, String::new()),
            Err(ActionError::Failed(e)) => (
                action_result::Outcome::Failed,
                format!("{e:#}"),
                String::new(),
            ),
        };
        self.emit(
            &spool,
            Kind::ActionResult(ActionResult {
                action_id: req.action_id.clone(),
                kind: kind as i32,
                outcome: outcome as i32,
                message,
                url,
            }),
        );
    }

    async fn perform(
        &self,
        meta: &TaskMeta,
        req: &ActionRequest,
    ) -> Result<(String, String), ActionError> {
        let cfg = self.config();
        let repo = cfg.repo(&meta.repo).ok_or_else(|| {
            ActionError::Refused(format!("repo {:?} is no longer configured", meta.repo))
        })?;
        if !meta.mode.writes() {
            return Err(ActionError::Refused("Read-only tasks can't push.".into()));
        }
        if meta.branch == meta.default_branch && meta.mode != Mode::FullAccess {
            return Err(ActionError::Refused(
                "Pushing to the default branch needs Full access.".into(),
            ));
        }
        let remote = git::remote_url(&repo.path).await.unwrap_or_default();
        match req.kind() {
            action_request::Kind::Push => {
                git::push(&repo.path, &meta.branch)
                    .await
                    .map_err(ActionError::Failed)?;
                let url = git::compare_url(&remote, &meta.default_branch, &meta.branch)
                    .unwrap_or_default();
                Ok((url, format!("Pushed {}", meta.branch)))
            }
            action_request::Kind::OpenPr => {
                if git::gh_ready().await {
                    let url = git::open_pr(
                        &repo.path,
                        &meta.branch,
                        &meta.default_branch,
                        &req.pr_title,
                        &req.pr_body,
                    )
                    .await
                    .map_err(ActionError::Failed)?;
                    Ok((url, "Opened a pull request".into()))
                } else {
                    let url = git::compare_url(&remote, &meta.default_branch, &meta.branch)
                        .ok_or_else(|| {
                            ActionError::Failed(anyhow::anyhow!(
                                "gh is not available and the remote URL isn't a known web host"
                            ))
                        })?;
                    Ok((
                        url,
                        "gh isn't set up on this machine, so here's a link to open the PR.".into(),
                    ))
                }
            }
            action_request::Kind::Unspecified => {
                Err(ActionError::Refused("Unknown action.".into()))
            }
        }
    }
}

enum ActionError {
    Refused(String),
    Failed(anyhow::Error),
}
