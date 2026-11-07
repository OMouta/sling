# iMessage

Message Sling from iMessage on your phone. iMessage has no API, so a Mac you paired with Sling does it: the Runner reads new messages from the Messages app's database and sends replies through Messages.

Only the Mac decides who gets through. It forwards messages from the senders you allow there, and nothing until you allow one.

## Before you start

- A Mac paired with Sling and running `sling-runner`. See [runner.md](../runner.md).
- Messages on that Mac signed in to iMessage.
- An Apple ID for Sling to answer as. Messages sends from the Apple ID signed in on the Mac, and a message from that same Apple ID counts as yours, not as one to answer. So sign the Mac's Messages in to an Apple ID of its own, and message that from your phone.

## Set it up on the Mac

```sh
sling-runner channel add imessage
sling-runner channel allow imessage +351912345678   # your number, with its country code
```

`channel add` checks two things and says what to grant when one is missing:

1. **Full Disk Access**, so it can read `~/Library/Messages/chat.db`. In **System Settings → Privacy & Security → Full Disk Access**, turn it on for your terminal app. If the Runner runs as a service, turn it on for the `sling-runner` binary too; `channel add` prints its path.
2. **Messages answers AppleScript.** The first time, macOS asks whether your terminal may control Messages. Allow it. The Runner's service asks again the first time it sends. You can change both under **Privacy & Security → Automation**.

Full Disk Access also lets what the Runner starts, such as the assistant's commands, read your protected files. The [threat model](../threat-model.md#known-gaps) says how to keep it to a copy of the Runner that only relays iMessage.

Allow an email address the same way, for someone who uses iMessage with their Apple ID email. A running Runner picks up changes within a minute.

## Add it to Sling

Under **Connectors**, add iMessage. The form lists the Macs that relay iMessage and picks yours when there's one. It says when a Mac still needs something, such as Full Disk Access or an allowed sender.

Then install the **iMessage assistant** template under **Workflows** and turn it on. It answers in the same chat, and tells you there when a task you started from iMessage finishes.

## Nodes

**iMessage received** is the trigger. It fires for a message from a sender the Mac allows, one to one or in a group they're in. Its output is a `channel.message`:

| Field | Holds |
|---|---|
| `id` | The message's ID on that Mac |
| `conversation` | Where a reply goes: the sender's number or email, or the group's ID |
| `sender` | Who sent it |
| `text` | The message, also when Messages kept it only in its rich text form |
| `isGroup` | Whether it came in a group chat |
| `sentAt` | When it was sent |

Set **Senders** to take only some of the allowed senders. Messages from one chat run one at a time, in order.

**Send iMessage** sends from the Mac.

| Setting | Meaning |
|---|---|
| Conversation | A number with its country code, an email address, or a group's ID from a received message. Empty sends to the one sender the Mac allows |
| Text | The message. A connected `text` input replaces it. Markdown goes out as plain text |

The assistant can send too, with your approval in Supervised and Auto. An approval's **Always allow** can cover one conversation.

## What the Mac does

- It reads the Messages database read-only every 2 seconds, for messages newer than the last one it handled. It skips messages sent from the Mac, tapbacks, attachments without text, and anyone it doesn't allow.
- Messages from before `channel add` are never forwarded.
- It keeps its place in the Runner's data folder, and moves it only once Sling has stored a message. A message that arrives while the Runner or Sling is down is answered once, after they're back.
- It sends with `osascript`, outside the Runner's command sandbox. The recipient and the text are passed as arguments to a fixed script, never written into it.
- It sends only to the senders it allows and to groups they wrote in, whatever Sling asks.
- A send waits up to 5 minutes for the Mac to come online, then fails and names the Mac.

`sling-runner config set channels off` stops every channel on the machine. What arrives while they're off is skipped, not answered later.

## When it doesn't work

- **"Needs Full Disk Access"** on **Machines**. Turn it on for the path shown, then wait a few seconds.
- **"macOS doesn't let sling-runner control Messages."** Allow it under **Privacy & Security → Automation**.
- **"Messages isn't signed in to iMessage on this Mac."** Sign in under **Messages → Settings → iMessage**.
- **Nothing answers.** Check that `sling-runner channel list` allows your number, written as it shows in Messages, with its country code, and that the template's workflow is on.
- **"This machine sends iMessage messages only to the senders it allows."** Run `sling-runner channel allow imessage <number>` on the Mac.
