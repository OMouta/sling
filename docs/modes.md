# Permission modes

Every conversation has a permission mode. It decides two things at once: how tightly Codex is sandboxed, and which steps wait for your approval.

| Mode | Codex sandbox | Writes files | Asks before |
|---|---|---|---|
| Read-only | `read-only` | no | nothing to approve |
| Supervised | `workspace-write` | in its worktree | push, PR, merge, deploy |
| Auto | `workspace-write` | in its worktree | merge, deploy |
| Full access | `danger-full-access` | anywhere | nothing |

New conversations start in the workspace default (**Settings**, Auto out of the box). You can switch any conversation from its header. A switch applies to tasks started after it, and running tasks keep the mode they started with. Every task records its mode in the audit log.

Stage 1 has no merge or deploy steps yet, so in practice Auto pushes and opens PRs on its own, and Supervised asks for both.

## What enforces what

The assistant never picks the mode. It isn't a tool parameter, and the server reads it from the conversation when a task is created. Limits are enforced in code, in two places:

**On the control plane**
- The task gets the conversation's current mode.
- A task above the machine's reported cap is refused before it's sent.
- Push and PR steps that need approval wait as approval records. They survive restarts and expire after 24 hours.

**On the Runner** (holds even if the control plane is compromised)
- `max-mode` in the local config. Tasks above it are refused.
- Only repos listed in the local config exist. There's no message that adds one.
- Branch names must start with `sling/` and can't be the default branch.
- Pushes never force, and only push the task's own branch.
- Read-only tasks can't push at all.
- Codex never commits or pushes. The Runner does, after the gate.

## Network

Codex's `workspace-write` sandbox blocks network. That stops a task from sending your files anywhere, but it also stops `npm install`. You can allow network for one repo on the Runner with `sling-runner repo add <path> --network`. Full access always has network.

## Full access

Full access runs Codex with no sandbox and skips every approval. A prompt injection in a README, an issue, or a log file then reaches your machine with no gate in between. The web app shows a red banner while a conversation is in this mode. To make a machine refuse it entirely:

```sh
sling-runner config set max-mode auto
```
