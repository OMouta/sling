# Sling Runner

`sling-runner` runs on each machine that Sling may work on. It connects out to the control plane, runs Codex in a fresh git worktree per task, commits the result, and pushes or opens a PR when the permission mode allows it.

## Install

From a release (set `SLING_REPO` to the repo that publishes Sling):

```sh
curl -fsSL https://github.com/$SLING_REPO/releases/latest/download/install.sh | SLING_REPO=$SLING_REPO sh
```

On Windows, use `install.ps1` from the same release. From source: `cargo build --release -p sling-runner`.

You also need, on the same machine and as the same user:

- `git`
- Codex, installed and logged in (`codex login`)
- Optional: GitHub CLI logged in (`gh auth login`), so Sling can open pull requests. Without it Sling gives you a compare link instead.

## Set up

```sh
sling-runner repo add ~/code/site          # repeat for each repo
sling-runner pair <SLING_PUBLIC_URL> <code> # code from Machines > Add machine
sling-runner service install                # run in the background
sling-runner doctor                         # check everything
```

Only repos you add here are visible to Sling. The control plane has no way to add one.

## Settings

```sh
sling-runner config show
sling-runner config set max-mode supervised      # read-only | supervised | auto | full-access
sling-runner config set max-concurrent-tasks 2
sling-runner config set name "work laptop"
sling-runner config set codex-bin /opt/codex/bin/codex
```

`max-mode` is the highest permission mode this machine accepts. A task above it is refused here, whatever the control plane says.

Network inside Codex's sandbox is off by default. To let Codex install dependencies in one repo:

```sh
sling-runner repo remove site
sling-runner repo add ~/code/site --network
```

A running Runner picks up config changes within a minute.

## Running it

| Command | What it does |
|---|---|
| `sling-runner run` | Run in the foreground. |
| `sling-runner service install` | launchd on macOS, a systemd user unit on Linux, a logon task on Windows. |
| `sling-runner service status` / `uninstall` | |
| `sling-runner gc` | Remove worktrees of finished tasks older than 7 days. Also runs daily on its own. |

On Linux, `loginctl enable-linger $USER` keeps the service running while you're logged out. On Windows the logon task only runs while you're logged in.

## Files

| Path (macOS and Linux) | Contents |
|---|---|
| `~/.config/sling/runner.toml` | Settings and repos |
| `~/.config/sling/runner.key` | The machine's private key, readable only by you |
| `~/.local/share/sling/spool/` | Task events not yet acknowledged by the server |
| `~/.local/share/sling/worktrees/` | One git worktree per task |
| `~/.local/share/sling/runner.log` | Log when running as a service |

On Windows these live under `%APPDATA%\Sling` and `%LOCALAPPDATA%\Sling`. `SLING_RUNNER_HOME` puts everything in one directory, which lets you run two Runners on one machine.

## Revoking

Revoke a machine on the **Machines** page. It disconnects within seconds and exits. To use it again, pair it with a new code.
