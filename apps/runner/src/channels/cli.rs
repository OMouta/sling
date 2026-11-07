//! `sling-runner channel`: adds and removes messaging channels on this
//! machine, and chooses whose messages they forward to Sling.

use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};

use super::imessage::{self, DbError, Reader};
use super::signal;
use super::store::Store;
use super::{ChannelEntry, Kind, check_name, find_program, is_uuid, normalize_address};
use crate::config::{Config, Paths};

/// Most senders one channel may allow.
const MAX_SENDERS: usize = 100;

#[derive(clap::Subcommand)]
pub enum ChannelCommand {
    /// Relay a messaging app for Sling.
    Add {
        #[command(subcommand)]
        what: AddCommand,
    },
    /// Show the channels and whose messages they forward.
    List,
    /// Stop relaying a channel.
    Remove { name: String },
    /// Forward a sender's messages to Sling: a phone number with its country
    /// code, an email address, or a Signal account ID. Sling can also send to
    /// them then.
    Allow { channel: String, sender: String },
    /// Stop forwarding a sender's messages.
    Disallow { channel: String, sender: String },
}

#[derive(clap::Subcommand)]
pub enum AddCommand {
    /// iMessage, on this Mac. Reading Messages needs Full Disk Access.
    Imessage {
        /// Defaults to "imessage".
        #[arg(long)]
        name: Option<String>,
        /// A database with the Messages schema to read instead of yours.
        #[arg(long, hide = true)]
        messages_db: Option<PathBuf>,
    },
    /// Signal, through signal-cli linked to the account as a device.
    Signal {
        /// The account's phone number, with its country code.
        #[arg(long)]
        account: String,
        /// Defaults to "signal".
        #[arg(long)]
        name: Option<String>,
        /// Path to signal-cli, when it isn't on PATH.
        #[arg(long)]
        signal_cli: Option<String>,
    },
}

pub async fn run(paths: &Paths, cmd: ChannelCommand) -> Result<()> {
    let out = match cmd {
        ChannelCommand::Add {
            what: AddCommand::Imessage { name, messages_db },
        } => add_imessage(paths, name, messages_db, "osascript").await?,
        ChannelCommand::Add {
            what:
                AddCommand::Signal {
                    account,
                    name,
                    signal_cli,
                },
        } => add_signal(paths, &account, name, signal_cli).await?,
        ChannelCommand::List => list(paths)?,
        ChannelCommand::Remove { name } => remove(paths, &name)?,
        ChannelCommand::Allow { channel, sender } => allow(paths, &channel, &sender)?,
        ChannelCommand::Disallow { channel, sender } => disallow(paths, &channel, &sender)?,
    };
    println!("{out}");
    Ok(())
}

const PICKED_UP: &str = "A running Runner picks this up within a minute.";

fn new_name(cfg: &Config, name: Option<String>, kind: Kind) -> Result<String> {
    let name = name.unwrap_or_else(|| kind.as_str().to_string());
    check_name(&name)?;
    if cfg.channel_entries.iter().any(|e| e.name == name) {
        bail!("there's already a channel named {name}. Pick another name with --name.");
    }
    Ok(name)
}

fn added(name: &str) -> String {
    format!(
        "Added {name}. It forwards nothing until you allow a sender:\n  sling-runner channel allow {name} <number or email>\n{PICKED_UP}"
    )
}

/// `osascript` is the program that checks Messages answers.
pub async fn add_imessage(
    paths: &Paths,
    name: Option<String>,
    messages_db: Option<PathBuf>,
    osascript: &str,
) -> Result<String> {
    // A test database works anywhere; the real one only on a Mac.
    if messages_db.is_none() && !cfg!(target_os = "macos") {
        bail!("iMessage needs a Mac.");
    }
    let mut cfg = Config::load(paths)?;
    let name = new_name(&cfg, name, Kind::Imessage)?;
    if let Some(other) = cfg
        .channel_entries
        .iter()
        .find(|e| e.kind == Kind::Imessage && e.messages_db == messages_db)
    {
        bail!("iMessage is already set up here, as {}.", other.name);
    }
    let entry = ChannelEntry {
        kind: Kind::Imessage,
        name: name.clone(),
        account: None,
        bin: None,
        messages_db,
        allowed_senders: Vec::new(),
    };
    let db = entry
        .messages_db()
        .context("no home folder to find Messages in")?;
    let newest = match Reader::open(&db) {
        Ok(r) => r.last_rowid()?,
        Err(DbError::NoAccess) => bail!(
            "Sling can't read your messages yet. In System Settings → Privacy & Security → Full Disk Access, turn it on for your terminal app, then run this again. If the Runner runs as a service, turn it on for {} too.",
            std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "sling-runner".into())
        ),
        Err(DbError::Missing(path)) => bail!(
            "There's no Messages database at {}. Open Messages and sign in to iMessage, then run this again.",
            path.display()
        ),
        Err(DbError::Other(e)) => bail!("Couldn't read Messages: {e}"),
    };
    println!(
        "Checking that Messages answers. macOS may ask to let your terminal control Messages."
    );
    imessage::check_messages(osascript)
        .await
        .map_err(|e| anyhow!(e))?;
    // From what's newest, so nothing sent before now is answered.
    Store {
        cursor: Some(newest),
        ..Store::default()
    }
    .save(paths, &name);
    cfg.channel_entries.push(entry);
    cfg.save(paths)?;
    Ok(added(&name))
}

pub async fn add_signal(
    paths: &Paths,
    account: &str,
    name: Option<String>,
    signal_cli: Option<String>,
) -> Result<String> {
    let account = normalize_address(account)
        .filter(|a| a.starts_with('+'))
        .with_context(|| {
            format!("{account:?} isn't a phone number. Write it with its country code, like +351912345678.")
        })?;
    let mut cfg = Config::load(paths)?;
    let name = new_name(&cfg, name, Kind::Signal)?;
    if let Some(other) = cfg
        .channel_entries
        .iter()
        .find(|e| e.kind == Kind::Signal && e.account.as_deref() == Some(account.as_str()))
    {
        bail!("{account} is already set up here, as {}.", other.name);
    }
    // Kept as a full path, so the Runner's service finds it without your PATH.
    let bin = find_program(signal_cli.as_deref().unwrap_or("signal-cli"))
        .with_context(|| signal::NOT_INSTALLED.to_string())?
        .display()
        .to_string();
    match signal::linked(&bin, &account).await {
        Ok(true) => {}
        Ok(false) => bail!(
            "signal-cli isn't linked to {account} yet. Run `signal-cli link -n Sling`, scan the code in Signal on your phone under Settings → Linked devices, then run this again."
        ),
        Err(e) => bail!(e),
    }
    Store {
        skip_before_ms: crate::sys::now_ms(),
        ..Store::default()
    }
    .save(paths, &name);
    cfg.channel_entries.push(ChannelEntry {
        kind: Kind::Signal,
        name: name.clone(),
        account: Some(account),
        bin: Some(bin),
        messages_db: None,
        allowed_senders: Vec::new(),
    });
    cfg.save(paths)?;
    Ok(added(&name))
}

pub fn list(paths: &Paths) -> Result<String> {
    let cfg = Config::load(paths)?;
    if cfg.channel_entries.is_empty() {
        return Ok("No channels yet. Add one with `sling-runner channel add imessage`, or `sling-runner channel add signal --account <number>`.".into());
    }
    let mut out = Vec::new();
    for e in &cfg.channel_entries {
        let who = if e.allowed_senders.is_empty() {
            "no senders allowed".to_string()
        } else {
            format!("allows {}", e.allowed_senders.join(", "))
        };
        let account = e
            .account
            .as_deref()
            .map(|a| format!(" {a}"))
            .unwrap_or_default();
        out.push(format!("{:<14} {}{account}, {who}", e.name, e.kind.label()));
    }
    if !cfg.channels {
        out.push(
            "Channels are off. Turn them on with `sling-runner config set channels on`.".into(),
        );
    }
    Ok(out.join("\n"))
}

pub fn remove(paths: &Paths, name: &str) -> Result<String> {
    let mut cfg = Config::load(paths)?;
    let before = cfg.channel_entries.len();
    cfg.channel_entries.retain(|e| e.name != name);
    if cfg.channel_entries.len() == before {
        bail!("no channel named {name:?}");
    }
    cfg.save(paths)?;
    Store::remove(paths, name);
    Ok(format!("Removed {name}. {PICKED_UP}"))
}

fn sender_for(e: &ChannelEntry, sender: &str) -> Result<String> {
    let addr = normalize_address(sender).with_context(|| {
        format!("{sender:?} isn't a phone number with its country code (like +351912345678), an email address, or a Signal account ID")
    })?;
    if e.kind == Kind::Imessage && is_uuid(&addr) {
        bail!("iMessage senders are phone numbers or email addresses");
    }
    Ok(addr)
}

pub fn allow(paths: &Paths, channel: &str, sender: &str) -> Result<String> {
    let mut cfg = Config::load(paths)?;
    let e = cfg
        .channel_entries
        .iter_mut()
        .find(|e| e.name == channel)
        .with_context(|| format!("no channel named {channel:?}"))?;
    let addr = sender_for(e, sender)?;
    if e.allowed_senders.contains(&addr) {
        return Ok(format!("{addr} is already allowed on {channel}."));
    }
    if e.allowed_senders.len() >= MAX_SENDERS {
        bail!("a channel can allow at most {MAX_SENDERS} senders");
    }
    e.allowed_senders.push(addr.clone());
    cfg.save(paths)?;
    Ok(format!("Allowed {addr} on {channel}. {PICKED_UP}"))
}

pub fn disallow(paths: &Paths, channel: &str, sender: &str) -> Result<String> {
    let mut cfg = Config::load(paths)?;
    let e = cfg
        .channel_entries
        .iter_mut()
        .find(|e| e.name == channel)
        .with_context(|| format!("no channel named {channel:?}"))?;
    let addr = sender_for(e, sender)?;
    if !e.allowed_senders.contains(&addr) {
        return Ok(format!("{addr} wasn't allowed on {channel}."));
    }
    e.allowed_senders.retain(|s| s != &addr);
    cfg.save(paths)?;
    Ok(format!(
        "{addr} can no longer message Sling on {channel}. {PICKED_UP}"
    ))
}
