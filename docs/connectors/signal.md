# Signal

Message Sling on Signal. Signal has no API for bots, so one of your machines does it through [signal-cli](https://github.com/AsamK/signal-cli), linked to a Signal account as another device. The Runner runs signal-cli, forwards the messages it receives, and sends replies through it.

Only the machine decides who gets through. It forwards messages from the senders you allow there, and nothing until you allow one.

## Before you start

- A machine paired with Sling and running `sling-runner`. See [runner.md](../runner.md).
- signal-cli installed on it: `brew install signal-cli` on a Mac, or a release from its GitHub page.
- A Signal account for Sling to answer as, such as a second number. signal-cli links to it like Signal Desktop does, and messages you send from that account count as yours, not as ones to answer. Message it from your own account.

## Set it up on the machine

Link signal-cli to the account, once:

```sh
signal-cli link -n Sling
```

It prints a link. Turn it into a QR code (for example with `qrencode -t ansi`) and scan it in Signal on the phone with that account, under **Settings → Linked devices**. Then:

```sh
sling-runner channel add signal --account +351900000000   # the account's number
sling-runner channel allow signal +351912345678           # your number, with its country code
```

`channel add` checks that signal-cli is installed and linked to that account, and keeps signal-cli's full path, so the Runner's service finds it. Use `--signal-cli <path>` when it isn't on your PATH. You can also allow someone by their Signal account ID, for people who hide their number. A running Runner picks up changes within a minute.

While the Runner runs, it holds the account: other signal-cli commands for it wait until the Runner stops.

## Add it to Sling

Under **Connectors**, add Signal. The form lists the machines that relay Signal and picks yours when there's one. When a machine has more than one Signal account, it asks which. It says when a channel still needs something, such as linking or an allowed sender.

Then install the **Signal assistant** template under **Workflows** and turn it on. It answers in the same chat, and tells you there when a task you started from Signal finishes.

## Nodes

**Signal message received** is the trigger. It fires for a message from a sender the machine allows, one to one or in a group they're in. Its output is a `channel.message`, with the same fields as iMessage's: `id`, `conversation` (the sender's number, or the group's ID), `sender`, `text`, `isGroup`, and `sentAt`. Set **Senders** to take only some of the allowed senders. Messages from one chat run one at a time, in order.

**Send Signal message** sends from the account.

| Setting | Meaning |
|---|---|
| Conversation | A number with its country code, an account ID, or a group's ID from a received message. Empty sends to the one sender the machine allows |
| Text | The message. A connected `text` input replaces it. Markdown goes out as plain text |

The assistant can send too, with your approval in Supervised and Auto. An approval's **Always allow** can cover one conversation.

## What the machine does

- It runs `signal-cli -a <account> jsonRpc`, reads its `receive` notifications, and sends with its `send` method. If signal-cli stops, the Runner starts it again, waiting longer each time it fails quickly, up to a minute.
- It skips reactions, receipts, typing notices, messages from the account itself, and anyone it doesn't allow. Messages sent before `channel add` are never forwarded.
- signal-cli takes a message off Signal's servers as it reads it, so the Runner saves each forwarded message in its data folder until Sling has stored it. A message that arrives while the Runner or Sling is down is answered once, after they're back.
- It sends only to the senders it allows and to groups they wrote in, whatever Sling asks.
- A send waits up to 5 minutes for the machine to come online, then fails and names the machine. Sling's check of a send says only that Signal took it.

`sling-runner config set channels off` stops every channel on the machine. What arrives while they're off is skipped, not answered later.

## When it doesn't work

- **"signal-cli isn't linked to this account."** Run `signal-cli link -n Sling` and scan the code, then wait a few seconds.
- **"signal-cli isn't installed."** Install it, or pass `--signal-cli <path>` to `channel add`.
- **"Signal couldn't deliver it: unregistered failure."** That number has no Signal account.
- **Nothing answers.** Check that `sling-runner channel list` allows your number, with its country code, and that the template's workflow is on.
