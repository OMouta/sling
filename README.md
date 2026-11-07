<p align="center"><img src="assets/icons/sling-icon-currentcolor.svg" width="72" alt="Sling"></p>

# Sling

Your agents. Your machines. Your workflows.

Sling is a self-hosted assistant that hands real work to coding agents on your own computers. You ask for a change from the web app, from your phone if you like, and Sling delegates it to Codex or Claude Code on a machine you paired, or in a fresh sandbox when that machine is offline. The agent works in a fresh git worktree, and Sling commits, pushes, and opens the pull request, asking first when your permission mode says so.

Sling coordinates. The coding agent writes the code. The control plane never edits source itself.

Around that sits a workflow engine with a visual editor. Workflows react to email, Discord messages, schedules, webhooks, and Sling's own events, and they can summarize with a model, ask for approval, or hand work to a coding agent. The chat assistant is itself a workflow, so the web app and Discord talk to the same one.

This repo is at **Stage 5** of the plan in [`plan/`](plan/): fixes that Sling merges, deploys, and checks once you approve, a calendar the assistant reads and adds to, and the web app on your phone's home screen with push notifications. Stage 4 brought extensions that other people write and you install, as signed packages that run in their own restricted processes. Stage 3 brought routing across machines, Docker and Railway sandboxes, and Claude Code next to Codex. Workflows, the editor, and the Discord and email connectors came in Stage 2.

## How it fits together

```text
 browser / phone ──HTTPS──▶  control plane (Docker)  ◀──WSS──  sling-runner on your machine
                            Fastify, Postgres, agent              │
                                                                  ├─ git worktree per task
                                                                  └─ codex exec --json
```

- **Control plane** (`apps/server`, `apps/web`): the API, the master agent, task state, approvals, and the web app. Runs in Docker next to Postgres.
- **Sling Runner** (`apps/runner`, Rust): a small daemon on each machine. It dials out to the control plane, so no ports open on your computer. Repos and the highest allowed permission mode are set on the machine, and the control plane can't change them.
- **Agent adapters** (`crates/harness-codex`, `crates/harness-claude-code`): run `codex exec --json` or `claude -p` with the sandbox that matches the permission mode, and stream their events back.
- **Sandboxes** (`integrations/docker`, `integrations/railway`): start the `sling-sandbox` image for one task. Inside it, `sling-runner sandbox` clones the repo from its remote, pairs itself, and connects back like any machine.
- **Extensions** (`packages/connector-sdk`, `packages/extension-*`, `extensions/`): connectors, sandbox providers, and workflow templates as signed `.slx` packages. Each one with code runs in its own Node process that can't touch files, the environment, or the network except the hosts it declared, through Sling.

## Quick start

You need Docker on the server, and Codex or Claude Code installed and logged in on the machine that has your code.

```sh
git clone <this repo> sling && cd sling/deploy
./setup.sh
```

The script asks how you'll reach Sling: this computer, your local network, or from anywhere through Tailscale or Cloudflare Tunnel. Then it writes `deploy/.env`, generates its secrets, and starts it. Open the address it prints and create the account. Under **Machines**, choose **Add machine** and run the command it shows on the computer with your repos. It installs `sling-runner`, pairs it, and starts it:

```sh
curl -fsSL https://sling.example.com/install.sh | SLING_CODE=K7QM-2XVD-HP4R sh
```

Once it connects, the dialog lists the repos the machine found. Pick the ones Sling may use, and change them later under **Machines**. Start a conversation: "The footer year in site is hardcoded. Make it dynamic and add a test."

The assistant chats through that machine's Codex or Claude Code, on your own login, so it runs on your subscription with no API key. It picks the coding agent and model for each task itself, unless you name one. API keys under **Settings** are optional, for chatting when no machine is on or through another provider such as Ollama.

To use Discord, Telegram, or email, add them under **Connectors**, then install a template under **Workflows**, for example **Important email to Discord**, **Discord assistant**, or **Telegram assistant**.

## Deploys

Add your site under **Checks**: a URL that says it works, and, if Sling should deploy it, its repo and how it deploys (your host deploys on merge, a command on one of your machines, or a deploy hook). Sling checks it every minute and sends a push when it goes down. Then "the site is down, fix it" goes all the way: the assistant checks the site, a coding agent fixes it, and once the PR is open Sling asks "Approve deployment?" in the chat and on your phone. After you approve, it merges, deploys, and checks the site until it passes, and tells you what it saw. The machine's own config decides what a deploy command runs, and it only deploys merged commits. Checks also watch a command on one of your machines, such as whether last night's backup is there, and an email you're waiting for by a deadline, and a delivered PR shows its CI. [docs/checks.md](docs/checks.md) has the details.

## Your calendar and apps

Add your calendar under **Connectors**: iCloud, Fastmail, Nextcloud, or any CalDAV account, Google Calendar through your own OAuth client, or the private iCal link of an Outlook calendar. The assistant then answers "what's on tomorrow?" and adds events, and the **Morning briefing** template writes you a briefing each morning. It can also search and read your email, send email, Discord, and Telegram messages, and run your workflows from chat. Reading never asks; anything that goes out asks you in the chat first, except in Full access.

## Setting Sling up from chat

The assistant can change Sling's own setup for you: "add a deploy target for my site", "connect my Fastmail", "make a workflow from the Site down alert template", "set my time zone to Lisbon". Each change shows in the chat with **Apply** and **Cancel**, except in Full access, and a password or token goes in a field on that card, never in the chat. See [docs/modes.md](docs/modes.md#changing-slings-setup).

## On your phone

Open Sling on your phone and add it to the home screen. Under **Settings → Notifications**, turn on notifications for that device: approvals, finished tasks, and replies then reach you with Sling closed, and a tap opens the right page. Push needs an HTTPS address, which the Tailscale and Cloudflare Tunnel setups give you. See [docs/notifications.md](docs/notifications.md).

## Extensions

Under **Extensions**, install connectors, sandbox providers, and workflow templates that aren't built in. Sling ships a catalog with three: [ntfy](extensions/ntfy) push notifications, a [Fly Machines](extensions/fly-machines) sandbox provider, and [Task alerts](extensions/task-alerts), a template that pings your phone when a task finishes. Add other catalogs by URL, or upload a `.slx` file.

Before anything installs you see what it adds and every permission it asks for, and you trust its publisher's key by fingerprint. Updates wait for you and show the permissions they add. To write one, `pnpm sling-ext init my-extension`; [docs/extensions](docs/extensions/README.md) covers the rest.

## Permission modes

| Mode | Codex | Claude Code | Asks before |
|---|---|---|---|
| Read-only | `read-only` sandbox | plan mode | nothing gets written |
| Supervised | `workspace-write` sandbox | accept edits, sandboxed | push, PR, merge, deploy |
| Auto (default) | `workspace-write` sandbox | accept edits, sandboxed | merge, deploy |
| Full access | `danger-full-access` | permissions skipped | nothing |

Each conversation has a mode, and each machine can cap the mode it accepts. Details in [`docs/modes.md`](docs/modes.md).

## Docs

- [Install the control plane](docs/install.md)
- [Run Sling Runner on a machine](docs/runner.md)
- [Reach Sling from your phone, at home or away](docs/remote-access.md)
- [Permission modes and what enforces them](docs/modes.md)
- [Personalities: who answers, and what it may use](docs/personalities.md)
- [Checks: watch sites, commands, and replies, and deploy a fix](docs/checks.md)
- [Notifications and the phone app](docs/notifications.md)
- [Workflows, nodes, and templates](docs/workflows.md)
- [Routing and sandboxes](docs/sandboxes.md), and [the sandbox image](docs/sandbox-image.md)
- Connectors: [Discord](docs/connectors/discord.md), [Telegram](docs/connectors/telegram.md), [Email](docs/connectors/email.md), [Calendar](docs/connectors/calendar.md), [iMessage](docs/connectors/imessage.md), [Signal](docs/connectors/signal.md), [Docker](docs/connectors/docker.md), [Railway](docs/connectors/railway.md)
- [Extensions](docs/extensions/README.md): installing them, and writing [connectors](docs/extensions/connectors.md), [sandbox providers](docs/extensions/providers.md), and [workflow packages](docs/extensions/workflow-packages.md), with [signing and catalogs](docs/extensions/signing.md) and [the CLI](docs/extensions/cli.md)
- [Threat model](docs/threat-model.md)
- [Development](docs/development.md)
- Product spec, decisions, and plan: [`plan/`](plan/)

## License

Apache-2.0. See [LICENSE](LICENSE).
