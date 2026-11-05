# S2. Codex sandbox per OS

## macOS (tested, codex-cli 0.166.0)

With `-s workspace-write` in a real `codex exec` run:
- Writes inside the working directory worked.
- `curl https://example.com` returned nothing. Network is blocked.

With `codex sandbox` running commands directly (no model):
- Reading `~/.gitconfig` worked. Reads are not limited to the workspace.
- Writing to `$HOME` failed with "Operation not permitted".

So on macOS, `workspace-write` stops writes outside the worktree and stops network, but it does not stop reads. A task can read `~/.ssh` and anything else the user can read. It just can't send it anywhere while network is off.

## Linux and Windows (not tested yet)

No Linux or Windows machine was available for this spike. Codex documents Landlock plus seccomp on Linux. Windows support has historically been weaker. Both need a run of the same probe before Stage 1 is called done:

```sh
codex sandbox -- sh -c 'echo x > $HOME/probe.txt; cat ~/.gitconfig; curl -sI https://example.com'
```

## Decision: network stays off, per-repo opt-in on the Runner

Turning network on in Supervised and Auto would let tests install dependencies, but with reads unrestricted it also opens a path for a prompt-injected task to send local files out. So:

- Read-only, Supervised, and Auto run with network off.
- A repo entry in the Runner's local config can set `network = true`. The Runner then passes `-c sandbox_workspace_write.network_access=true`. The control plane can't flip this, same as the repo allowlist (D17).
- Full access runs unsandboxed, network included.
