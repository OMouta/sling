<p align="center"><img src="assets/icons/sling-icon-currentcolor.svg" width="72" alt="Sling"></p>

# Sling

Your agents. Your machines. Your workflows.

Sling is a self-hosted assistant that hands real work to coding agents on your own computers. You ask for a change from the web app, from your phone if you like, and Sling delegates it to Codex on a machine you paired. Codex works in a fresh git worktree, and Sling commits, pushes, and opens the pull request, asking first when your permission mode says so.

Sling coordinates. Codex writes the code. The control plane never edits source itself.

This repo is at **Stage 1** of the plan in [`plan/stage1.md`](plan/stage1.md): one assistant, one kind of Runner, one specialist (Codex). Workflows, Discord, and cloud sandboxes come in later stages.

## How it fits together

```text
 browser / phone ──HTTPS──▶  control plane (Docker)  ◀──WSS──  sling-runner on your machine
                            Fastify, Postgres, agent              │
                                                                  ├─ git worktree per task
                                                                  └─ codex exec --json
```

- **Control plane** (`apps/server`, `apps/web`): the API, the master agent, task state, approvals, and the web app. Runs in Docker next to Postgres.
- **Sling Runner** (`apps/runner`, Rust): a small daemon on each machine. It dials out to the control plane, so no ports open on your computer. Repos and the highest allowed permission mode are set on the machine, and the control plane can't change them.
- **Codex adapter** (`crates/harness-codex`): runs `codex exec --json` with the sandbox that matches the permission mode and streams its events back.

## Quick start

You need Docker on the server, and Codex installed and logged in on the machine that has your code.

```sh
git clone <this repo> sling && cd sling/deploy
cp .env.example .env    # set SLING_PUBLIC_URL, SLING_SECRET_KEY, POSTGRES_PASSWORD
docker compose up -d
```

Open `SLING_PUBLIC_URL`, create the account, and add a model under **Settings** (OpenAI, Anthropic, or any OpenAI-compatible endpoint such as Ollama).

On the machine with your repos:

```sh
sling-runner repo add ~/code/site
sling-runner pair https://sling.example.com K7QM-2XVD-HP4R   # code from the Machines page
sling-runner service install
```

Then start a conversation: "The footer year in site is hardcoded. Make it dynamic and add a test."

## Permission modes

| Mode | Codex sandbox | Asks before |
|---|---|---|
| Read-only | `read-only` | nothing gets written |
| Supervised | `workspace-write` | push, PR, merge, deploy |
| Auto (default) | `workspace-write` | merge, deploy |
| Full access | `danger-full-access` | nothing |

Each conversation has a mode, and each machine can cap the mode it accepts. Details in [`docs/modes.md`](docs/modes.md).

## Docs

- [Install the control plane](docs/install.md)
- [Run Sling Runner on a machine](docs/runner.md)
- [Reach Sling from outside your network](docs/remote-access.md)
- [Permission modes and what enforces them](docs/modes.md)
- [Threat model](docs/threat-model.md)
- [Development](docs/development.md)
- Product spec, decisions, and plan: [`plan/`](plan/)

## License

Apache-2.0. See [LICENSE](LICENSE).
