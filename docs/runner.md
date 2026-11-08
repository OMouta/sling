# Sling Runner

`sling-runner` runs on each machine that Sling may work on. It connects out to the control plane, runs a coding agent (Codex or Claude Code) in a fresh git worktree per task, commits the result, and pushes or opens a PR when the permission mode allows it. It also runs Sling's chat assistant on those agents, with your own login. See [Chat](#chat).

## Install

Copy the install command from **Machines > Add machine** in Sling. It looks like this:

```sh
curl -fsSL https://sling.example.com/install.sh | SLING_CODE=<code> sh
```

The script downloads `sling-runner` from Sling, pairs it with the code, and installs the background service, so the machine only needs to reach Sling. Sling hands out the build of its own version: the first time a machine asks for one, Sling gets it from the matching GitHub release, checks its checksum, and keeps it. On Windows, run the PowerShell command from the same page, which does the same with `install.ps1`:

```powershell
$env:SLING_CODE = "<code>"; irm https://sling.example.com/install.ps1 | iex
```

You can also run the script from a GitHub release, which downloads straight from GitHub. Set `SLING_REPO` to the repo that publishes Sling, and add `SLING_URL` and `SLING_CODE` to pair in the same step:

```sh
curl -fsSL https://github.com/$SLING_REPO/releases/latest/download/install.sh | SLING_REPO=$SLING_REPO sh
```

With neither `SLING_URL` nor `SLING_REPO`, the script uses the `sling-runner` already on your PATH. From source: `cargo build --release -p sling-runner`.

You also need, on the same machine and as the same user:

- `git`
- At least one coding agent, installed and logged in:
  - Codex: `codex login`
  - Claude Code: `claude auth login`, or `ANTHROPIC_API_KEY` set in the Runner's environment. On Linux, Supervised and Auto tasks also need `bubblewrap` and `socat` for Claude Code's sandbox. Without them Claude Code refuses to start those tasks rather than run commands unsandboxed.
- Optional: GitHub CLI logged in (`gh auth login`), so Sling can open and merge pull requests. Without it Sling gives you a compare link instead, and merges with git.

The Runner checks each agent with its own CLI (`codex login status`, `claude auth status`) and never reads their credential files. A task for an agent that isn't installed and logged in is refused.

## Set up

After the one-line install the machine is paired and running. Without it:

```sh
sling-runner pair <SLING_PUBLIC_URL> <code> # code from Machines > Add machine
sling-runner service install                # run in the background
sling-runner doctor                         # check everything
```

Once the machine connects, the **Add machine** dialog lists the repos it found. Pick the ones Sling may use there, or later under **Machines**.

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
sling-runner config set gh-bin /opt/homebrew/bin/gh
sling-runner config set remote-repos off         # on | off
sling-runner config set commands off             # on | off
sling-runner config set deploys off              # on | off
sling-runner config set files off                # on | off
sling-runner config set channels off             # on | off
sling-runner config set scan-roots ~/code,~/work # "" means your home directory
sling-runner config set server-url https://sling.tail1234.ts.net
```

`server-url` is for when Sling moves to a new address, for example onto a tunnel. The machine keeps its pairing and connects to the new address after you restart the Runner. Only you can change it, here on the machine. To pair with a different Sling, use `sling-runner pair` instead.

`max-mode` is the highest permission mode this machine accepts. A task above it is refused here, whatever the control plane says. Below Full access, the assistant's commands also stay in the read-only sandbox, and at Read-only the machine doesn't merge or deploy. `commands` decides whether the assistant may run commands here at all. See [Commands](#commands). `deploys` decides whether Sling may merge and deploy here. See [Merges and deploys](#merges-and-deploys). `files` decides whether the assistant may search and read the shared folders. See [Folders](#folders). `channels` turns every messaging channel here on or off. See [Channels](#channels).

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

Each message to the assistant is one turn. Sling sends the turn to a machine, and the Runner runs one turn of the agent's CLI in a new, empty directory under `~/.local/share/sling/chat/`, outside every repo. The reply and the agent's thinking stream back to Sling as they come, and the Runner deletes the directory when the turn ends. Sling saves the thinking, each tool call it served with its arguments and result, and anything the agent wrote before a tool call, with the reply. The chat shows that work in order above the answer, and keeps it in the history. None of it goes to a model again. Up to four turns run at once. They run alongside tasks and don't count toward `max-concurrent-tasks`. If the connection to Sling drops, the Runner stops its running turns, and Sling shows them as failed.

The assistant's only tools are Sling's own: running a command, starting a task, listing machines, and getting or cancelling a task. The agent's CLI starts `sling-runner mcp`, a small MCP server that sends each tool call to Sling with a token Sling made for that one turn. The token never appears on a command line. Claude Code reads it from an MCP config file in the turn's directory that only you can read. Codex gets it in its environment and passes it to the MCP server through `env_vars`.

A turn's model and effort follow the same rules as a task's. The agent keeps its own session, in `~/.claude/projects` or `~/.codex/sessions`, and the next turn on the same machine resumes it. When the session isn't on this machine, for example because the last turn ran on another one, the Runner starts a new session and gives it the conversation so far.

### What the assistant can reach

| | Claude Code | Codex |
|---|---|---|
| Built-in tools | None, with `--tools ""` | Read-only sandbox, with its shell, image viewer, browser, web search, sub-agents, apps, and plugins turned off |
| MCP servers | Only Sling's, with `--strict-mcp-config` | Only Sling's |
| Sling's tools | Allowed without asking. Everything else is denied, with `--permission-mode dontAsk`. | Approved up front |
| Your settings | Still loaded, for example `~/.claude/CLAUDE.md` and hooks. Slash commands and skills are off. | `~/.codex/config.toml` is skipped, so a provider, profile, or MCP server set there doesn't apply to chat |
| Sling's instructions | The whole system prompt, in place of Claude Code's own | Developer instructions, after Codex's own prompt |
| Thinking | Summarized, with `--thinking-display summarized` | Reasoning summaries, with `model_reasoning_summary="auto"` |

Codex has a gap. Its read-only sandbox stops writes, not reads, so a Codex tool may still read any file you can read and run commands that don't write. Codex 0.166 has no such tool left once the Runner turns the shell and image viewer off. A later Codex could add a tool the Runner doesn't know to turn off, and through it the assistant could read files on this machine. Claude Code starts with no built-in tools at all, so it doesn't have this gap.

## Commands

The assistant's `run_command` tool runs one shell command on a machine, as you, and returns its output. Any assistant can use it, whether it runs on a machine's CLI or on an API key. The Runner starts your shell (zsh, bash, or sh) with `-c`, in your home directory or the directory the assistant names. stdin is empty, `NO_COLOR` and `TERM=dumb` are set, and `SLING_*` variables and GitHub tokens are removed from its environment, as for agents. A command stops after 60 seconds unless the assistant asks for up to 5 minutes, and anything it leaves running is stopped when it ends. The first 48 KB and last 16 KB of output go back to Sling. Up to 8 commands run at once.

Commands run in a read-only sandbox unless the conversation's mode lets them out:

- On macOS, `sandbox-exec` with a profile that allows everything except writing files, the network, Apple Events, signals to other processes, and the services that would write for it: preferences, the pasteboard, Launch Services, file coordination, and the keychain.
- On Linux, bubblewrap with the whole filesystem read-only, empty `/tmp` and `/run`, and no network, IPC, or other processes. Without bubblewrap there's no sandbox, and the inventory says so.

A command leaves the sandbox only when the machine's `max-mode` is Full access and the conversation isn't Read-only. Sling asks you in the chat first outside Full access. [modes.md](modes.md#commands) has the table. `sling-runner config set commands off` refuses every command, and the Machines page shows it.

## Folders

Share a folder, and the assistant can search and read the text files in it with `search_files` and `read_file`. "What did I write about the boiler?" searches your notes and quotes the one it finds. Only this machine can share a folder. Sling can't add one.

```sh
sling-runner folder add ~/Notes                 # named after the folder
sling-runner folder add ~/Documents/Recipes --name Recipes
sling-runner folder list
sling-runner folder remove Notes
sling-runner config set files off               # refuse every search and read
```

Sling sees each folder's name only, on the Machines page and in the assistant's tools. Paths stay on the machine, and nothing is uploaded or indexed: each search and read runs here, when the assistant asks. A removed folder, and everything after `files off`, is refused from the next request on. The Machines page catches up within a minute.

A search looks for the text as written, ignoring case, and skips hidden files and folders, `.git`, `node_modules`, what `.gitignore` and `.ignore` leave out, files over 2 MB, binary files, and symlinks. It returns at most 50 lines, at most 5 from one file, each with its path, line number, and up to 200 characters of the line, and stops after 2 seconds with what it has. A read returns up to 256 KB of a text file, and says when it's cut. A path that's a folder lists what's in it.

### What the Runner refuses

- A path that leaves the folder once `..` and symlinks are resolved, and an absolute path
- A folder that wasn't shared, or was removed
- Hidden files and folders, whose names start with `.`
- The Runner's own files, such as `runner.key`, even inside a shared folder
- Binary files
- Everything, with `files off`

Sharing refuses the whole disk, a folder inside the Runner's own directory, a folder already shared, and a folder inside or around one that is.

## Merges and deploys

A task delivered with a deploy ends with a merge and, for a deploy target that runs a command, a deploy. Sling sends each one to a machine that has the repo. Any such machine can merge, not only the one that ran the task. Only a machine with a deploy command for the repo deploys.

### Deploy commands

The command lives on the machine, and only you set it:

```sh
sling-runner repo set site deploy-command "fly deploy"
sling-runner repo set site deploy-timeout 1800   # seconds, 900 by default
sling-runner repo unset site deploy-command      # or deploy-timeout, back to 900
sling-runner repo list                           # shows each repo's command
```

Sling picks which machine deploys, but never what runs there. The Runner reports each repo's command and time limit to Sling, with anything that looks like a token masked, so the check's dialog can show it. A command is at most 4 KB. Put anything longer in a script and run that.

### How a merge runs

With a GitHub PR and `gh` logged in, the Runner merges through `gh`:

1. It runs `gh pr view <url>` and checks that the PR is in this repo's origin, that its head is the task's branch, and that its base is the default branch.
2. For a PR that's already merged, it returns the merge commit, so asking twice is safe.
3. It runs `gh pr merge <url>` with the target's method: `--squash`, `--merge`, or `--rebase`. When the task ran on this machine, it adds `--match-head-commit` with the commit Sling made, so GitHub refuses the merge if anyone pushed to the PR since.

`gh` runs from an empty directory outside the repo, so it never touches your checkout. GitHub's branch protection still applies. A PR that waits for checks or a merge queue fails the step.

Otherwise the Runner merges with git:

1. It fetches, then makes a temporary detached worktree at `origin/<default branch>`.
2. It squash-merges the task branch, or merges it with a merge commit when the target says `merge`. Rebasing needs `gh`, so `rebase` squash-merges instead, and the step's message says so.
3. The commit has the task's title and body and a `Sling-Task: <task id>` trailer. Commit hooks don't run.
4. It pushes the commit to the default branch, never forced. Pre-push hooks don't run either, because they'd run in a fresh checkout without the repo's dependencies.
5. If origin refuses the push because someone else pushed meanwhile, it fetches and merges again on top, once.

A conflict aborts the merge, and the step fails with the files that conflict. Before merging, the Runner looks for the trailer on the default branch. A branch that's already there counts as merged too, so asking twice is safe here as well. The Runner removes the temporary worktree afterwards and leaves your own checkout and branches alone. Your local default branch doesn't move. The next `git pull` brings the merge in.

### How a deploy runs

1. The Runner fetches and checks that the commit is on `origin/<default branch>`.
2. It makes a temporary detached worktree at that commit.
3. It runs the command there through your login shell, outside the command sandbox. That's `$SHELL -lc` when your shell is zsh, bash, sh, dash, or ksh, and `/bin/sh -lc` otherwise. stdin is empty, and stderr joins stdout so the two stay in order.
4. The environment is yours without `SLING_*` variables. The Runner adds `SLING_DEPLOY_COMMIT`, the full SHA, and `SLING_DEPLOY_REPO`, the repo's name on this machine, plus `NO_COLOR=1` and `GIT_TERMINAL_PROMPT=0`.
5. Output streams to Sling about every 100 ms, whole lines at a time, with secrets masked as in task output. Sling gets the first 256 KB, then a note that the rest was cut.
6. Exit code 0 is success. Any other code fails the step, and the message ends with the last lines of output.
7. At the time limit the Runner sends SIGTERM to the command's process group, then SIGKILL 5 seconds later.
8. It removes the worktree.

Because the worktree goes away, the command should build and ship, not serve from its own directory. Processes it leaves running keep running, but the Runner stops reading their output half a second after the command exits. One deploy per repo runs on a machine at a time. A second deploy of the same repo fails while the first runs.

### What the Runner refuses

Whatever Sling asks, the Runner refuses:

- any merge or deploy while `deploys` is off
- any merge or deploy while `max-mode` is Read-only
- a repo it doesn't have
- merging a branch outside `sling/`, or into anything but the repo's default branch on this machine
- merging a PR that isn't in the repo's origin, or whose head or base doesn't match
- deploying a commit that isn't on `origin/<default branch>`
- deploying a repo with no deploy command

It never force-pushes. The task shows each refusal's reason.

To keep Sling from merging or deploying from this machine at all:

```sh
sling-runner config set deploys off
```

The Runner reads this from disk for every merge and deploy, so it takes effect at once. `sling-runner config show` and `sling-runner doctor` show the setting and which repos have a deploy command. It's on by default, and always off in a sandbox. Sling merges a sandbox's PR itself through GitHub, after the sandbox is gone.

### Results

The Runner keeps each merge's and deploy's result in memory until Sling acknowledges it, and sends it again after a reconnect. Sling may send the same request again, for example after a reconnect. A request that's running or finished never runs twice. The Runner answers with the result it has. If the Runner itself restarts, results it hadn't delivered are lost, and Sling marks the step "interrupted, outcome unknown".

## Channels

A machine can relay messaging apps that have no API Sling can call, so you can message Sling there: iMessage on a Mac, and Signal through signal-cli. Only the machine adds a channel or chooses whose messages it forwards. Sling can't.

```sh
sling-runner channel add imessage                          # macOS only
sling-runner channel add signal --account +351900000000    # signal-cli linked to that account
sling-runner channel allow imessage +351912345678          # a number with its country code, or an email
sling-runner channel disallow imessage +351912345678
sling-runner channel list
sling-runner channel remove imessage
```

`--name` gives a channel another name, for a second Signal account. Setup, and what each one needs, is in [iMessage](connectors/imessage.md) and [Signal](connectors/signal.md).

What the Runner holds to whatever Sling asks:

- A channel forwards only messages from the senders you allowed, and nothing while there are none. Messages from before `channel add` never go.
- It sends only to the senders you allowed, and to groups they wrote in.
- iMessage reads the Messages database read-only. It sends through `osascript`, with the recipient and the text passed as arguments to a fixed script, never written into it.

Each channel keeps its place in `~/.local/share/sling/channels/`. A message stays there until Sling says it stored it, so one that arrives while the Runner or Sling is down goes to Sling once, after they're back. With `sling-runner config set channels off`, every channel stops, and what arrives meanwhile is skipped rather than answered later.

**Machines** and `sling-runner doctor` show each channel, how many senders it allows, and what it still needs, such as Full Disk Access or linking signal-cli.

## Running it

| Command | What it does |
|---|---|
| `sling-runner run` | Run in the foreground. |
| `sling-runner service install` | launchd on macOS, a systemd user unit on Linux, a logon task on Windows. |
| `sling-runner service status` / `uninstall` | |
| `sling-runner gc` | Remove worktrees of finished tasks older than 7 days. Also runs daily on its own. |
| `sling-runner doctor` | Check git, the agents, and gh, show which repos match across machines, count the found repos Sling can offer, say whether this machine merges and deploys, and check each channel. |
| `sling-runner sandbox` | The entrypoint of the sandbox image. You don't run it yourself; see below. |

On Linux, `loginctl enable-linger $USER` keeps the service running while you're logged out. On Windows the logon task only runs while you're logged in.

## Files

| Path (macOS and Linux) | Contents |
|---|---|
| `~/.config/sling/runner.toml` | Settings, repos, and shared folders |
| `~/.config/sling/runner.key` | The machine's private key, readable only by you |
| `~/.local/share/sling/spool/` | Task events not yet acknowledged by the server |
| `~/.local/share/sling/worktrees/` | One git worktree per task |
| `~/.local/share/sling/chat/` | One empty directory per running chat turn, deleted when the turn ends |
| `~/.local/share/sling/actions/` | Temporary worktrees for merges and deploys, deleted when each one ends |
| `~/.local/share/sling/channels/` | Each channel's place, and Signal messages Sling hasn't stored yet |
| `~/.local/share/sling/runner.log` | Log when running as a service |

On Windows these live under `%APPDATA%\Sling` and `%LOCALAPPDATA%\Sling`. `SLING_RUNNER_HOME` puts everything in one directory, which lets you run two Runners on one machine.

## Sandboxes

`sling-runner sandbox` is what runs inside a sandbox, the fresh environment an execution provider such as Docker or Railway creates for one task. It reads its settings from `SLING_*` environment variables, clones the repos it's given, logs the agents in with the API keys it's given, pairs itself with a one-time code, and runs that one task. The control plane revokes it when the task is delivered, and it exits. It also exits after `SLING_IDLE_EXIT_SECONDS` without a task.

A sandbox Runner is disposable. Agents can't start their own sandboxes inside a container, so there they run without one, and the container is the isolation boundary. Read-only tasks still never commit or push. See `docs/sandbox-image.md` for the image and its environment variables.

## Revoking

Revoke a machine on the **Machines** page. It disconnects within seconds and exits. To use it again, pair it with a new code.
