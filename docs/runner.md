# Sling Runner

`sling-runner` runs on each machine that Sling may work on. It connects out to the control plane, runs a coding agent (Codex or Claude Code) in a fresh git worktree per task, commits the result, and pushes or opens a PR when the permission mode allows it. It also runs Sling's chat assistant on those agents, with your own login. See [Chat](#chat).

## Install

Copy the install command from **Machines > Add machine** in Sling. It looks like this:

```sh
curl -fsSL https://sling.example.com/install.sh | SLING_CODE=<code> sh
```

The script downloads `sling-runner`, pairs it with the code, and installs the background service. Sling fills in its own URL and the GitHub repo to download from when it serves the script. On Windows, run the PowerShell command from the same page, which does the same with `install.ps1`:

```powershell
$env:SLING_CODE = "<code>"; irm https://sling.example.com/install.ps1 | iex
```

You can also run the script from a GitHub release. Set `SLING_REPO` to the repo that publishes Sling, and add `SLING_URL` and `SLING_CODE` to pair in the same step:

```sh
curl -fsSL https://github.com/$SLING_REPO/releases/latest/download/install.sh | SLING_REPO=$SLING_REPO sh
```

If `SLING_REPO` is empty and `sling-runner` is already on your PATH, the script skips the download and uses that one. From source: `cargo build --release -p sling-runner`.

You also need, on the same machine and as the same user:

- `git`
- At least one coding agent, installed and logged in:
  - Codex: `codex login`
  - Claude Code: `claude auth login`, or `ANTHROPIC_API_KEY` set in the Runner's environment. On Linux, Supervised and Auto tasks also need `bubblewrap` and `socat` for Claude Code's sandbox. Without them Claude Code refuses to start those tasks rather than run commands unsandboxed.
- Optional: GitHub CLI logged in (`gh auth login`), so Sling can open pull requests. Without it Sling gives you a compare link instead.

The Runner checks each agent with its own CLI (`codex login status`, `claude auth status`) and never reads their credential files. A task for an agent that isn't installed and logged in is refused.

## Set up

After the one-line install the machine is paired and running. Without it:

```sh
sling-runner pair <SLING_PUBLIC_URL> <code> # code from Machines > Add machine
sling-runner service install                # run in the background
sling-runner doctor                         # check everything
```

Then choose the repos Sling may use under **Machines** in Sling.

## Repos

Sling works only in repos this machine allows. You can allow them in Sling or on the machine.

In Sling, open the machine under **Machines** and pick from the repos it found. The Runner looks for git repos when it connects, when you ask Sling to look again, and after each change. It searches your home directory down to four levels, so `~/code/org/team/repo` is found. It doesn't look inside a repo it found, and it skips hidden folders, `node_modules`, `target`, `vendor`, `dist`, `build`, `Library`, `Applications`, `Movies`, `Music`, `Pictures`, `AppData`, and its own worktrees. A scan stops after 300 repos or about 3 seconds. Sling suggests each folder's name as the repo name, adding `-2`, `-3` and so on when the name is taken.

To search other folders instead of your home directory:

```sh
sling-runner config set scan-roots ~/code,~/work   # "" goes back to your home directory
```

On macOS, Desktop, Documents, and Downloads are protected folders, so the first scan may ask for permission to read them. If you'd rather it didn't, set `scan-roots` to the folders that hold your code.

On the machine:

```sh
sling-runner repo add ~/code/site       # --name picks the name, --network allows network
sling-runner repo list
sling-runner repo remove site
```

A repo added from Sling starts with network off. Sling can also remove a repo, except while a task is running in it. Removing a repo leaves its files alone.

### Why Sling can only add repos the Runner found

Sling never names a folder of its own. It picks a path from the list the Runner sent, and the Runner adds it only if that exact path is in its latest scan and is still a git repo. Someone who took over the control plane could at most allow a repo that already sits under your scan roots. They couldn't point the Runner at `~/.ssh` or anywhere else.

To keep every repo decision on the machine:

```sh
sling-runner config set remote-repos off
```

With `remote-repos` off, the Runner doesn't scan, Sling sees no found repos, and the Runner refuses every add and remove that comes from Sling. Only `sling-runner repo add` and `repo remove` change repos then. `sling-runner config show` and `sling-runner doctor` show the setting. It's on by default, and always off in a sandbox.

## Settings

```sh
sling-runner config show
sling-runner config set max-mode supervised      # read-only | supervised | auto | full-access
sling-runner config set max-concurrent-tasks 2
sling-runner config set name "work laptop"
sling-runner config set labels ios,gpu          # comma-separated; "" clears them
sling-runner config set codex-bin /opt/codex/bin/codex
sling-runner config set claude-bin ~/.local/bin/claude
sling-runner config set remote-repos off         # on | off
sling-runner config set scan-roots ~/code,~/work # "" means your home directory
```

`max-mode` is the highest permission mode this machine accepts. A task above it is refused here, whatever the control plane says.

## Labels

Labels say what a machine is for, so a task can ask for one. "Run the iOS build" can require `ios`, and only machines with that label get it. Labels use lowercase letters, digits, `-`, `_`, `:`, and `.`, up to 64 characters each and 32 per machine.

The Runner adds `os:<os>` and `arch:<arch>` itself, for example `os:macos` and `arch:aarch64`, so you can't set labels starting with `os:` or `arch:`. Labels are set only here, on the machine. The control plane can't change them. `sling-runner config show` and `sling-runner doctor` list the labels the Runner sends.

## Agents and permission modes

| Mode | Codex | Claude Code |
|---|---|---|
| Read-only | `-s read-only` | plan mode |
| Supervised, Auto | `-s workspace-write`. Writes stay in the worktree | accept-edits mode, with Bash in Claude Code's sandbox. Writes stay in the worktree |
| Full access | `-s danger-full-access` | permissions skipped, no sandbox |

Neither agent may commit or push. The Runner commits changes to tracked files, plus new files the agent reported creating. Other untracked files, such as build output from running tests, stay out of the commit, and the task log lists them.

For tasks, both agents load your own settings, such as `~/.codex/config.toml`, `~/.claude/settings.json`, `CLAUDE.md`, hooks, and MCP servers, so two machines can behave differently for the same task. Chat turns load less; see [Chat](#chat).

The agent's environment never includes `SLING_*` variables, `GH_TOKEN`, or `GITHUB_TOKEN`.

## Models

A task or chat turn can pick the agent's model, its reasoning effort, and the fast tier where the model has one. An empty value leaves the agent's own default. The Runner tells Sling which models each agent offers:

| | Codex | Claude Code |
|---|---|---|
| Models offered | The ones `codex debug models` lists in Codex's own picker. The first by Codex's priority is the default. | `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`, by their full names. Opus 5.5 is the default. Opus 5.5 and Haiku 5.5 default to medium effort, the other two to high. |
| Model | `-m <model>` | `--model <model>` |
| Effort | `-c model_reasoning_effort="<effort>"` | `--effort <effort>` |
| Fast | `-c service_tier="fast"` | `"fastMode": true` in `--settings`, for Opus 5.5 only. Other models ignore it. On a Claude subscription, fast mode is paid from usage credits, not the plan's limits. |

The Runner refuses a task whose model or effort is longer than 64 characters, starts with anything but a letter or digit, or uses anything but letters, digits, `.`, `_`, `:`, and `-`. Codex reads the effort as TOML, and this keeps a value from adding its own settings or flags. The task log names the model settings a task ran with.

## Network

Network inside the agent's sandbox is off by default in Read-only, Supervised, and Auto. To allow it in one repo:

```sh
sling-runner repo remove site
sling-runner repo add ~/code/site --network
```

Repos added from Sling start with network off, so use these commands on the machine to turn it on.

For Codex that opens the whole network. Claude Code's sandbox only takes a list of hosts, so for Claude Code it opens package registries and code hosts: GitHub, GitLab, Bitbucket, npm, Yarn, JSR, Deno, PyPI, crates.io, the Go module proxy, RubyGems, Maven, Gradle, Packagist, NuGet, pub.dev, and Hex. Full access has no sandbox, so network is on there for both.

A running Runner picks up config changes within a minute.

## Chat

Sling's assistant runs on a machine's Codex or Claude Code, with the login that's already there. If that login is a ChatGPT or Claude subscription, chat runs on the subscription, and Sling needs no API key for it.

Each message to the assistant is one turn. Sling sends the turn to a machine, and the Runner runs one turn of the agent's CLI in a new, empty directory under `~/.local/share/sling/chat/`, outside every repo. The reply streams back to Sling as it comes, and the Runner deletes the directory when the turn ends. Up to four turns run at once. They run alongside tasks and don't count toward `max-concurrent-tasks`. If the connection to Sling drops, the Runner stops its running turns, and Sling shows them as failed.

The assistant's only tools are Sling's own: starting a task, listing machines, and getting or cancelling a task. The agent's CLI starts `sling-runner mcp`, a small MCP server that sends each tool call to Sling with a token Sling made for that one turn. The token never appears on a command line. Claude Code reads it from an MCP config file in the turn's directory that only you can read. Codex gets it in its environment and passes it to the MCP server through `env_vars`.

A turn's model and effort follow the same rules as a task's. The agent keeps its own session, in `~/.claude/projects` or `~/.codex/sessions`, and the next turn on the same machine resumes it. When the session isn't on this machine, for example because the last turn ran on another one, the Runner starts a new session and gives it the conversation so far.

### What the assistant can reach

| | Claude Code | Codex |
|---|---|---|
| Built-in tools | None, with `--tools ""` | Read-only sandbox, with its shell, image viewer, browser, web search, sub-agents, apps, and plugins turned off |
| MCP servers | Only Sling's, with `--strict-mcp-config` | Only Sling's |
| Sling's tools | Allowed without asking. Everything else is denied, with `--permission-mode dontAsk`. | Approved up front |
| Your settings | Still loaded, for example `~/.claude/CLAUDE.md` and hooks. Slash commands and skills are off. | `~/.codex/config.toml` is skipped, so a provider, profile, or MCP server set there doesn't apply to chat |
| Sling's instructions | Appended to the system prompt | Developer instructions |

Codex has a gap. Its read-only sandbox stops writes, not reads, so a Codex tool may still read any file you can read and run commands that don't write. Codex 0.166 has no such tool left once the Runner turns the shell and image viewer off. A later Codex could add a tool the Runner doesn't know to turn off, and through it the assistant could read files on this machine. Claude Code starts with no built-in tools at all, so it doesn't have this gap.

## Running it

| Command | What it does |
|---|---|
| `sling-runner run` | Run in the foreground. |
| `sling-runner service install` | launchd on macOS, a systemd user unit on Linux, a logon task on Windows. |
| `sling-runner service status` / `uninstall` | |
| `sling-runner gc` | Remove worktrees of finished tasks older than 7 days. Also runs daily on its own. |
| `sling-runner doctor` | Check git, the agents, and gh, show which repos match across machines, and count the found repos Sling can offer. |
| `sling-runner sandbox` | The entrypoint of the sandbox image. You don't run it yourself; see below. |

On Linux, `loginctl enable-linger $USER` keeps the service running while you're logged out. On Windows the logon task only runs while you're logged in.

## Files

| Path (macOS and Linux) | Contents |
|---|---|
| `~/.config/sling/runner.toml` | Settings and repos |
| `~/.config/sling/runner.key` | The machine's private key, readable only by you |
| `~/.local/share/sling/spool/` | Task events not yet acknowledged by the server |
| `~/.local/share/sling/worktrees/` | One git worktree per task |
| `~/.local/share/sling/chat/` | One empty directory per running chat turn, deleted when the turn ends |
| `~/.local/share/sling/runner.log` | Log when running as a service |

On Windows these live under `%APPDATA%\Sling` and `%LOCALAPPDATA%\Sling`. `SLING_RUNNER_HOME` puts everything in one directory, which lets you run two Runners on one machine.

## Sandboxes

`sling-runner sandbox` is what runs inside a sandbox, the fresh environment an execution provider such as Docker or Railway creates for one task. It reads its settings from `SLING_*` environment variables, clones the repos it's given, logs the agents in with the API keys it's given, pairs itself with a one-time code, and runs that one task. The control plane revokes it when the task is delivered, and it exits. It also exits after `SLING_IDLE_EXIT_SECONDS` without a task.

A sandbox Runner is disposable. Agents can't start their own sandboxes inside a container, so there they run without one, and the container is the isolation boundary. Read-only tasks still never commit or push. See `docs/sandbox-image.md` for the image and its environment variables.

## Revoking

Revoke a machine on the **Machines** page. It disconnects within seconds and exits. To use it again, pair it with a new code.
