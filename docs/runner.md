# Sling Runner

`sling-runner` runs on each machine that Sling may work on. It connects out to the control plane, runs a coding agent (Codex or Claude Code) in a fresh git worktree per task, commits the result, and pushes or opens a PR when the permission mode allows it.

## Install

From a release (set `SLING_REPO` to the repo that publishes Sling):

```sh
curl -fsSL https://github.com/$SLING_REPO/releases/latest/download/install.sh | SLING_REPO=$SLING_REPO sh
```

On Windows, use `install.ps1` from the same release. From source: `cargo build --release -p sling-runner`.

You also need, on the same machine and as the same user:

- `git`
- At least one coding agent, installed and logged in:
  - Codex: `codex login`
  - Claude Code: `claude auth login`, or `ANTHROPIC_API_KEY` set in the Runner's environment. On Linux, Supervised and Auto tasks also need `bubblewrap` and `socat` for Claude Code's sandbox. Without them Claude Code refuses to start those tasks rather than run commands unsandboxed.
- Optional: GitHub CLI logged in (`gh auth login`), so Sling can open pull requests. Without it Sling gives you a compare link instead.

The Runner checks each agent with its own CLI (`codex login status`, `claude auth status`) and never reads their credential files. A task for an agent that isn't installed and logged in is refused.

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
sling-runner config set labels ios,gpu          # comma-separated; "" clears them
sling-runner config set codex-bin /opt/codex/bin/codex
sling-runner config set claude-bin ~/.local/bin/claude
```

`max-mode` is the highest permission mode this machine accepts. A task above it is refused here, whatever the control plane says.

## Labels

Labels say what a machine is for, so a task can ask for one. "Run the iOS build" can require `ios`, and only machines with that label get it. Labels use lowercase letters, digits, `-`, `_`, `:`, and `.`, up to 64 characters each and 32 per machine.

The Runner adds `os:<os>` and `arch:<arch>` itself, for example `os:macos` and `arch:aarch64`, so you can't set labels starting with `os:` or `arch:`. Like repos, labels are set only here. The control plane can't change them. `sling-runner config show` and `sling-runner doctor` list the labels the Runner sends.

## Agents and permission modes

| Mode | Codex | Claude Code |
|---|---|---|
| Read-only | `-s read-only` | plan mode |
| Supervised, Auto | `-s workspace-write`. Writes stay in the worktree | accept-edits mode, with Bash in Claude Code's sandbox. Writes stay in the worktree |
| Full access | `-s danger-full-access` | permissions skipped, no sandbox |

Neither agent may commit or push. The Runner commits changes to tracked files, plus new files the agent reported creating. Other untracked files, such as build output from running tests, stay out of the commit, and the task log lists them.

Both agents load your own settings, such as `~/.codex/config.toml`, `~/.claude/settings.json`, `CLAUDE.md`, hooks, and MCP servers, so two machines can behave differently for the same task.

The agent's environment never includes `SLING_*` variables, `GH_TOKEN`, or `GITHUB_TOKEN`.

## Network

Network inside the agent's sandbox is off by default in Read-only, Supervised, and Auto. To allow it in one repo:

```sh
sling-runner repo remove site
sling-runner repo add ~/code/site --network
```

For Codex that opens the whole network. Claude Code's sandbox only takes a list of hosts, so for Claude Code it opens package registries and code hosts: GitHub, GitLab, Bitbucket, npm, Yarn, JSR, Deno, PyPI, crates.io, the Go module proxy, RubyGems, Maven, Gradle, Packagist, NuGet, pub.dev, and Hex. Full access has no sandbox, so network is on there for both.

A running Runner picks up config changes within a minute.

## Running it

| Command | What it does |
|---|---|
| `sling-runner run` | Run in the foreground. |
| `sling-runner service install` | launchd on macOS, a systemd user unit on Linux, a logon task on Windows. |
| `sling-runner service status` / `uninstall` | |
| `sling-runner gc` | Remove worktrees of finished tasks older than 7 days. Also runs daily on its own. |
| `sling-runner doctor` | Check git, the agents, and gh, and show which repos match across machines. |
| `sling-runner sandbox` | The entrypoint of the sandbox image. You don't run it yourself; see below. |

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

## Sandboxes

`sling-runner sandbox` is what runs inside a sandbox, the fresh environment an execution provider such as Docker or Railway creates for one task. It reads its settings from `SLING_*` environment variables, clones the repos it's given, logs the agents in with the API keys it's given, pairs itself with a one-time code, and runs that one task. The control plane revokes it when the task is delivered, and it exits. It also exits after `SLING_IDLE_EXIT_SECONDS` without a task.

A sandbox Runner is disposable. Agents can't start their own sandboxes inside a container, so there they run without one, and the container is the isolation boundary. Read-only tasks still never commit or push. See `docs/sandbox-image.md` for the image and its environment variables.

## Revoking

Revoke a machine on the **Machines** page. It disconnects within seconds and exits. To use it again, pair it with a new code.
