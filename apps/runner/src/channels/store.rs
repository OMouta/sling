//! A channel's place on disk, in the Runner's data folder: how far iMessage
//! has read, the Signal messages Sling hasn't stored yet, and the groups an
//! allowed sender wrote in.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sling_runner_protocol::ChannelMessage;

use crate::config::{Paths, write_private};

/// A message on its way to Sling.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub message_id: String,
    pub conversation: String,
    pub sender: String,
    pub text: String,
    pub at_ms: i64,
}

impl Pending {
    pub fn to_proto(&self, channel: &str) -> ChannelMessage {
        ChannelMessage {
            channel: channel.to_string(),
            conversation: self.conversation.clone(),
            sender: self.sender.clone(),
            text: self.text.clone(),
            at_ms: self.at_ms,
            message_id: self.message_id.clone(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Store {
    /// iMessage: every row up to this one has been handled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<i64>,
    /// Signal: messages sent before this, in ms since the epoch, are skipped.
    /// Set when the channel is added and when it's turned back on, so nothing
    /// from before then is answered.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub skip_before_ms: i64,
    /// Channels were turned off. The next start skips what came meanwhile.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub paused: bool,
    /// Group conversations an allowed sender wrote in, newest last. Sends may
    /// go to these.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<String>,
    /// Signal: received and not stored by Sling yet.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending: Vec<Pending>,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

impl Store {
    pub fn path(paths: &Paths, name: &str) -> PathBuf {
        paths.data_dir.join("channels").join(format!("{name}.json"))
    }

    /// A missing or unreadable file starts over, from what's new.
    pub fn load(paths: &Paths, name: &str) -> Store {
        let path = Store::path(paths, name);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!("{} is unreadable, starting over: {e}", path.display());
                Store::default()
            }),
            Err(_) => Store::default(),
        }
    }

    pub fn save(&self, paths: &Paths, name: &str) {
        let path = Store::path(paths, name);
        let tmp = path.with_extension("json.tmp");
        let write = serde_json::to_vec(self)
            .map_err(anyhow::Error::from)
            .and_then(|bytes| write_private(&tmp, &bytes))
            .and_then(|()| std::fs::rename(&tmp, &path).map_err(Into::into));
        if let Err(e) = write {
            tracing::warn!("couldn't save {}: {e:#}", path.display());
        }
    }

    pub fn remove(paths: &Paths, name: &str) {
        let _ = std::fs::remove_file(Store::path(paths, name));
    }

    pub fn remember_group(&mut self, conversation: &str, max: usize) {
        self.groups.retain(|g| g != conversation);
        self.groups.push(conversation.to_string());
        if self.groups.len() > max {
            let extra = self.groups.len() - max;
            self.groups.drain(..extra);
        }
    }
}
