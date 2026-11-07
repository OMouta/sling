//! Messaging channels the machine relays for Sling, such as iMessage and
//! Signal, which have no API the control plane can call. Only the machine
//! adds a channel or allows its senders.
//!
//! This Runner has no channels yet, so it reports none, answers every
//! ChannelSend with a failure, and never sends a ChannelMessage.

use std::sync::Arc;

use sling_runner_protocol::envelope::Body;
use sling_runner_protocol::{Channel, ChannelMessageAck, ChannelSend, ChannelSendResult};
use tokio::sync::mpsc;

use crate::config::Config;
use crate::tasks::Manager;

/// The channels set up on this machine, for the inventory.
pub fn inventory(_cfg: &Config) -> Vec<Channel> {
    Vec::new()
}

impl Manager {
    /// Handles ChannelSend: answers with one ChannelSendResult on `out`.
    pub fn channel_send(self: &Arc<Self>, r: ChannelSend, out: mpsc::Sender<Body>) {
        tokio::spawn(async move {
            let result = ChannelSendResult {
                request_id: r.request_id,
                ok: false,
                message: format!(
                    "This machine has no channel named {}. Its Runner can't relay messages; update sling-runner there.",
                    r.channel
                ),
            };
            let _ = out.send(Body::ChannelSendResult(result)).await;
        });
    }

    /// The server has stored a ChannelMessage. Nothing to move yet, since
    /// this Runner sends none.
    pub fn channel_message_ack(&self, _ack: &ChannelMessageAck) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Paths;

    #[tokio::test]
    async fn answers_a_send_with_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            config_dir: dir.path().join("home"),
            data_dir: dir.path().join("home/data"),
        };
        let mgr = Manager::new(paths, Config::default()).unwrap();
        let (tx, mut rx) = mpsc::channel(4);
        mgr.channel_send(
            ChannelSend {
                request_id: "c1".into(),
                channel: "imessage".into(),
                conversation: "+351900000000".into(),
                text: "hi".into(),
            },
            tx,
        );
        let Some(Body::ChannelSendResult(r)) = rx.recv().await else {
            panic!("no ChannelSendResult");
        };
        assert_eq!(r.request_id, "c1");
        assert!(!r.ok);
        assert!(r.message.contains("imessage"));
        mgr.channel_message_ack(&ChannelMessageAck::default());
        assert!(inventory(&Config::default()).is_empty());
    }
}
