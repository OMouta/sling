# Sandbox image

A sandbox is a fresh environment an execution provider creates for one task and destroys afterwards. The provider starts an image whose entrypoint is `sling-runner sandbox`. That command clones the repos, logs the agents in, pairs with the control plane using a one-time code, and runs the task like any other Runner. The control plane revokes it once the task is delivered, and it exits.

`deploy/sandbox/Dockerfile` builds the default image, `sling-sandbox`. A provider can name a custom image instead.

## Image contract

An image works as a sandbox when:

- `sling-runner`, `git`, and the agents tasks will ask for (`codex`, `claude`) are on `PATH`.
- The entrypoint is `sling-runner sandbox`, with no arguments.
- It runs as a user other than root. Claude Code won't skip permission checks as root, and Supervised, Auto, and Full access tasks need that in a sandbox.
- `ps` is installed. The Runner uses it to check a leftover agent process before stopping it.

The Runner dials out to the control plane, so the sandbox needs no open ports. It does need outbound access to `SLING_URL` and to the git host.

`sling-runner` runs as process 1 and doesn't reap processes that agents leave behind. Start the container with an init process: `docker run --init`, or `HostConfig.Init: true` through the Engine API.

## Environment

| Variable | Required | Holds |
|---|---|---|
| `SLING_URL` | yes | Control plane URL as the sandbox reaches it |
| `SLING_PAIR_CODE` | yes | One-time pairing code bound to this sandbox |
| `SLING_SANDBOX_ID` | yes | Sandbox ID. Letters, digits, `-`, and `_`. The Runner pairs as `sandbox-<id>` |
| `SLING_REPOS` | yes | JSON: `[{ "name", "cloneUrl", "defaultBranch", "network" }]` |
| `SLING_HARNESSES` | no | Agents to set up, comma-separated, for example `codex,claude-code`. Default: all of them. Unknown names are skipped |
| `SLING_MAX_MODE` | no | Highest permission mode. Default `full-access` |
| `SLING_IDLE_EXIT_SECONDS` | no | Exit after this long with no task or action running. Default 900. `0` turns it off |
| `OPENAI_API_KEY` | no | Codex logs in with it |
| `ANTHROPIC_API_KEY` | no | Claude Code reads it at run time |
| `SLING_GIT_TOKEN` | no | Used by the Runner for HTTPS git and `gh`. Never given to an agent |
| `SLING_RUNNER_HOME` | no | The Runner's config, spool, and worktrees. Default: a new directory in the temp directory, removed on exit |
| `SLING_CODEX_BIN`, `SLING_CLAUDE_BIN` | no | Agent binaries to use instead of `codex` and `claude` on `PATH`. For tests |

`cloneUrl` can be HTTPS, HTTP, SSH, `file://`, or an absolute path. It can't carry credentials: `https://token@host/...` is refused, because the token comes from `SLING_GIT_TOKEN`. Repo names use letters, digits, `-`, `_`, and `.`, and can't start with `.`.

## What it does at boot

1. Reads and checks the environment.
2. Sets up git credentials, if `SLING_GIT_TOKEN` is set. git gets a credential helper, `sling-runner git-credential`, that reads the token from the environment and answers only HTTPS requests to the hosts in `SLING_REPOS`. The helper is passed to the Runner's own git commands in `GIT_CONFIG_*` variables, so the token never goes into `.git/config` or a remote URL. `gh` gets it as `GH_TOKEN`, again for the Runner's own commands only.
3. Clones each repo into `/workspace/<name>`, or `$SLING_RUNNER_HOME/workspace/<name>` when `/workspace` isn't writable. It clones only the default branch, and over HTTP or HTTPS without file contents until they're needed (`--filter=blob:none`). Every commit is there, so `git log` and pushes work.
4. Sets up each agent in `SLING_HARNESSES`:
   - **Codex.** With `OPENAI_API_KEY`, it runs `codex login --with-api-key` with the key on stdin, in a Codex home of its own under `$HOME` that's removed on exit. The image's `~/.codex/config.toml` is copied in. Without the key, Codex needs a login baked into the image.
   - **Claude Code.** It reads `ANTHROPIC_API_KEY` itself, so there's no login step. Without the key, Claude Code needs a login baked into the image.
5. Pairs with the code and connects.

The Runner then has one task slot, the repos with their `network` flags, and `max_mode` from `SLING_MAX_MODE`. Its only labels are the automatic `os:` and `arch:` ones.

Agents get the Runner's environment without `SLING_*` variables, `GH_TOKEN`, or `GITHUB_TOKEN`. Codex also loses `OPENAI_API_KEY` once it's logged in with it, and `ANTHROPIC_API_KEY`. Claude Code keeps `ANTHROPIC_API_KEY`, which it needs, and loses `OPENAI_API_KEY`.

### Agents run without their own sandbox

Codex's and Claude Code's sandboxes need unprivileged user namespaces, which a default Docker container doesn't allow, so neither can start in one. A sandbox Runner therefore runs agents without their own sandbox, and the container is the isolation boundary:

| Mode | Codex | Claude Code |
|---|---|---|
| Read-only | `danger-full-access` | plan mode |
| Supervised, Auto, Full access | `danger-full-access` | permissions skipped |

Read-only tasks still never commit or push, because the Runner refuses both. The permission mode still decides which pushes and PRs need approval.

The repo's `network` flag can't be enforced inside a sandbox. The agent reaches whatever the container's network reaches.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Revoked by the control plane, idle for `SLING_IDLE_EXIT_SECONDS`, or stopped by SIGTERM or SIGINT. Running tasks are cancelled first |
| 1 | Anything else |
| 2 | A variable is missing or invalid |
| 3 | A repo couldn't be cloned |
| 4 | Pairing failed, for example an expired code or an unreachable `SLING_URL` |

Logs go to stdout, one line per event, with the reason for a failed boot on the last line. They include how long the clones, pairing, and the whole boot took.

## The default image

| | |
|---|---|
| Base | `debian:trixie-slim` |
| Tools | git, gh, curl, openssh-client, procps, Python 3 with pip and venv, build-essential |
| Node | 24, copied from `node:24-trixie-slim` |
| Codex | `@openai/codex` 0.166.0 |
| Claude Code | `@anthropic-ai/claude-code` 2.1.318 |
| User | `sling`, UID 1000, home `/home/sling` |
| Working directory | `/workspace`, owned by `sling` |
| Size | about 2 GB unpacked. The agents' npm packages are 750 MB of it |

Build it from the repo root:

```sh
docker build -f deploy/sandbox/Dockerfile -t sling-sandbox:dev .
```

Build arguments: `CODEX_VERSION`, `CLAUDE_CODE_VERSION`, `RUST_VERSION`, and `NODE_MAJOR`.

Check it:

```sh
docker run --rm --entrypoint sh sling-sandbox:dev -c 'sling-runner --version; codex --version; claude --version'
SLING_SANDBOX_IMAGE=sling-sandbox:dev cargo test -p sling-runner --test sandbox
```

The second command runs the sandbox boot tests inside the image against a stub control plane on the host. It needs Docker to reach the host as `host.docker.internal`, which Docker Desktop and OrbStack provide.

## A custom image

Start from the default image to add tools:

```dockerfile
FROM sling-sandbox:dev
USER root
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
USER sling
```

Or copy the Runner into an image of your own:

```dockerfile
FROM your-base
COPY --from=sling-sandbox:dev /usr/local/bin/sling-runner /usr/local/bin/sling-runner
# git, procps, and the agents you need, then a non-root user
USER builder
WORKDIR /workspace
ENTRYPOINT ["sling-runner", "sandbox"]
```

The Runner binary in the default image is built for Linux on the image's architecture and links against glibc, so the base needs a compatible glibc.

A custom image can carry its own agent logins, for example a Codex login in `~/.codex` or a Claude Code login in `~/.claude`, and Sling then injects only the secrets that are actually stored. Anyone who can pull the image can read those logins, so keep such an image in a private registry.
