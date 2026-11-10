# Permission modes

Every conversation has a permission mode. It decides two things at once: how tightly the coding agent is sandboxed on your machines, and which steps wait for your approval.

| Mode | Codex | Claude Code | Writes files | Asks before |
|---|---|---|---|---|
| Read-only | `read-only` sandbox | plan mode, sandboxed, no network | no | nothing to approve |
| Supervised | `workspace-write` sandbox | accept edits, sandboxed | in its worktree | push, PR, merge, deploy |
| Auto | `workspace-write` sandbox | accept edits, sandboxed | in its worktree | merge, deploy |
| Full access | `danger-full-access` | permissions skipped, no sandbox | anywhere | nothing |

In Supervised and Auto, Claude Code refuses to start rather than run commands unsandboxed. On Linux that means it needs bubblewrap and socat installed.

New conversations start in the workspace default (**Settings**, Auto out of the box). You can switch any conversation from its header. A switch applies to tasks started after it, and running tasks keep the mode they started with. Every task records its mode in the audit log.

Merge and deploy happen only when a task is delivered as a deploy, to a repo with a [site check that deploys it](checks.md#sites-that-deploy). Auto then pushes and opens the PR on its own and asks once, "Approve deployment?", after the PR exists. Supervised asks for push and PR first, then for the deployment. Full access merges and deploys without asking, once the PR's CI passes, and a Read-only conversation can't deploy at all.

## Sending from chat

With a personality that has Apps and workflows, the assistant can read your calendar and use the apps you connected. Reading never asks. Anything that leaves Sling, such as an email, a Discord message, a new calendar event, or a workflow run with side effects, follows the conversation's mode:

| Mode | Sending something |
|---|---|
| Read-only | Refused |
| Supervised | Asks you in the chat first |
| Auto | Asks you in the chat first |
| Full access | Goes out at once |

The question shows what would go out, such as `Email ana@example.com: Lunch moved`, with Deny and Allow. If nobody answers within 5 minutes, nothing is sent. See [personalities.md](personalities.md).

## Rules

**Always allow** on a question makes an allow rule, such as "Email to anyone at acme.com". In Supervised and Auto, a send the rule covers then goes without asking, and so does a task's push or pull request in Supervised. Read-only still refuses, and Full access never asked. Merges, deploys, commands outside the sandbox, and setup changes never match a rule. A start rule opens a chat when a check changes, in Read-only, Supervised, or Auto, never Full access. See [rules.md](rules.md).

## Changing Sling's setup

With a personality that has Change Sling's setup, the assistant can add deploy targets, connect app accounts, add and change workflows, edit personalities, and change workspace settings. Reading the setup never asks. A change follows the conversation's mode:

| Mode | A change to Sling's setup |
|---|---|
| Read-only | Refused |
| Supervised | Shows the change in the chat and waits for Apply |
| Auto | Shows the change in the chat and waits for Apply |
| Full access | Applies at once, unless it needs a password or token |

A workflow the assistant writes shows its steps in plain words on the card, with the ones that send marked. See [workflows.md](workflows.md#from-a-chat).

The card lists every value it would set, the old one next to the new one for an edit, with **Cancel** and **Apply**. A password, token, or deploy hook URL is typed into a field on the card and goes straight to the server with **Apply**, so even Full access shows the card for a change that needs one. If nobody answers within 5 minutes, nothing changes. See [personalities.md](personalities.md#what-it-can-use).

## Commands

The assistant can run shell commands on your machines itself, to list a folder, read a file, or check a version, without starting a coding task. A command runs as you, in your home directory unless the assistant picks another one. By default it runs in the machine's read-only sandbox, which can read files but can't write them, use the network, open apps, send Apple Events, or signal other processes. That's `sandbox-exec` on macOS and bubblewrap on Linux.

| Mode | A command that only reads | A command that writes or needs the network |
|---|---|---|
| Read-only | Runs in the sandbox | Refused |
| Supervised | Runs in the sandbox | Asks you in the chat, then runs outside it |
| Auto | Runs in the sandbox | Asks you in the chat, then runs outside it |
| Full access | Runs outside the sandbox | Runs outside the sandbox |

The question shows on the command in the chat, with Deny and Run it. If nobody answers within 5 minutes, the command doesn't run. On a machine with no sandbox, for example Linux without bubblewrap, every command asks first in Supervised and Auto, and Read-only can't run any.

A machine whose `max-mode` is below Full access runs every command in its sandbox, whatever the conversation's mode, and refuses to leave it. `sling-runner config set commands off` turns commands off on a machine. Every command, and every approval or denial, goes in the audit log.

## What enforces what

The assistant never picks the mode. It isn't a tool parameter, and the server reads it from the conversation when a task is created. Limits are enforced in code, in two places:

**On the control plane**
- The task gets the conversation's current mode.
- A machine whose reported cap is below the conversation's mode isn't picked for the task. If no machine qualifies, the task is refused, or offered to a sandbox (see [sandboxes.md](sandboxes.md)).
- Push, PR, merge, and deploy steps that need approval wait as approval records. They survive restarts and expire after 24 hours.

**On the Runner** (holds even if the control plane is compromised)
- `max-mode` in the local config. Tasks above it are refused. A newly paired machine starts at Auto.
- Only repos listed in the local config exist. Sling can ask the Runner to add one, but only a git repo the Runner found on the machine itself, and only while `remote-repos` is on. `sling-runner config set remote-repos off` makes the local list final.
- Branch names must start with `sling/` and can't be the default branch.
- Pushes never force, and only push the task's own branch.
- Read-only tasks can't push at all.
- Commands run outside the read-only sandbox only when `max-mode` is Full access and the conversation isn't Read-only. `commands off` refuses them all.
- Codex never commits or pushes. The Runner does, after the gate.
- Merges and deploys are refused with `sling-runner config set deploys off`, or when `max-mode` is Read-only. A merge takes only a Sling task branch, never forces, and a deploy runs only the command set on that machine, only on a commit that's already on the remote's default branch. See [checks.md](checks.md#what-the-machine-refuses).

## Network

Codex's `workspace-write` sandbox and Claude Code's sandbox both block network. That stops a task from sending your files anywhere, but it also stops `npm install`. You can allow network for one repo on the Runner with `sling-runner repo add <path> --network`. Codex then gets the network, and Claude Code gets a list of package registries and code hosts, because its sandbox doesn't take a wildcard. Full access always has network.

## Full access

Full access runs Codex with no sandbox and skips every approval. A prompt injection in a README, an issue, or a log file then reaches your machine with no gate in between. The web app shows a red banner while a conversation is in this mode. A newly paired machine refuses it until you allow it there:

```sh
sling-runner config set max-mode full-access
```

To make a machine refuse it again:

```sh
sling-runner config set max-mode auto
```

## Sandboxes

A task in a [sandbox](sandboxes.md) runs in the conversation's mode, and the steps that ask first don't change, so a Supervised task in a sandbox still waits for your approval before it pushes.

The agent's own sandbox does change. Codex's and Claude Code's sandboxes need unprivileged user namespaces, which a normal Docker container doesn't allow, so inside a sandbox container the agent runs without them: Codex with `danger-full-access`, and Claude Code skipping permissions in every mode except Read-only, which stays in plan mode. Read-only tasks still never commit or push.

What does differ is the Runner's own limits. A sandbox's Runner allows up to Full access, and its only repo is the one it cloned from the sandbox list. The control plane sets both when it starts the sandbox, so unlike a machine's `max-mode` they don't hold if the control plane is compromised. The container is the boundary instead: it holds one fresh clone and that task's secrets, can't reach your machines, and is destroyed when the task is done.
