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

Stage 1 has no merge or deploy steps yet, so in practice Auto pushes and opens PRs on its own, and Supervised asks for both.

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
- Push and PR steps that need approval wait as approval records. They survive restarts and expire after 24 hours.

**On the Runner** (holds even if the control plane is compromised)
- `max-mode` in the local config. Tasks above it are refused.
- Only repos listed in the local config exist. Sling can ask the Runner to add one, but only a git repo the Runner found on the machine itself, and only while `remote-repos` is on. `sling-runner config set remote-repos off` makes the local list final.
- Branch names must start with `sling/` and can't be the default branch.
- Pushes never force, and only push the task's own branch.
- Read-only tasks can't push at all.
- Commands run outside the read-only sandbox only when `max-mode` is Full access and the conversation isn't Read-only. `commands off` refuses them all.
- Codex never commits or pushes. The Runner does, after the gate.

## Network

Codex's `workspace-write` sandbox and Claude Code's sandbox both block network. That stops a task from sending your files anywhere, but it also stops `npm install`. You can allow network for one repo on the Runner with `sling-runner repo add <path> --network`. Codex then gets the network, and Claude Code gets a list of package registries and code hosts, because its sandbox doesn't take a wildcard. Full access always has network.

## Full access

Full access runs Codex with no sandbox and skips every approval. A prompt injection in a README, an issue, or a log file then reaches your machine with no gate in between. The web app shows a red banner while a conversation is in this mode. To make a machine refuse it entirely:

```sh
sling-runner config set max-mode auto
```

## Sandboxes

A task in a [sandbox](sandboxes.md) runs in the conversation's mode, and the steps that ask first don't change, so a Supervised task in a sandbox still waits for your approval before it pushes.

The agent's own sandbox does change. Codex's and Claude Code's sandboxes need unprivileged user namespaces, which a normal Docker container doesn't allow, so inside a sandbox container the agent runs without them: Codex with `danger-full-access`, and Claude Code skipping permissions in every mode except Read-only, which stays in plan mode. Read-only tasks still never commit or push.

What does differ is the Runner's own limits. A sandbox's Runner allows up to Full access, and its only repo is the one it cloned from the sandbox list. The control plane sets both when it starts the sandbox, so unlike a machine's `max-mode` they don't hold if the control plane is compromised. The container is the boundary instead: it holds one fresh clone and that task's secrets, can't reach your machines, and is destroyed when the task is done.
