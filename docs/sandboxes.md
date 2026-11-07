# Machines, sandboxes, and routing

A coding task runs in one of two places:

- **A machine**: one of your paired computers, using its own logins and tools.
- **A sandbox**: a fresh container that a provider such as Docker or Railway starts for one task and removes when the task is done.

You don't have to say which. Sling picks, and every task card says where it went and why.

## How Sling picks a machine

Sling treats a repo on two machines as the same repo when both clones have the same remote. `git@github.com:acme/site.git` and `https://github.com/acme/site` are both `github.com/acme/site`. A repo without a remote only matches by name, on that machine.

A machine can take a task when it's:

- online
- has the repo
- has the coding agent ready (Codex or Claude Code, installed and logged in)
- has every label the task needs, for example `ios`
- allows the conversation's permission mode (its `max-mode`)

When more than one can, Sling prefers, in order:

1. the machine you named
2. the one with the most free task slots
3. the one that ran this repo most recently, since its worktrees and caches are warm
4. the one you paired first

When every machine that can take it is busy, the task waits in the best one's queue.

The task card shows one line per machine, such as "Offline", "Doesn't have the label ios", or "Picked: it has the most free slots (2 of 2 slots free)".

### Asking for something specific

In chat, just say it:

- "Use Claude Code to…" picks the agent. Without it, tasks use the default agent from **Settings → Sandboxes**.
- "Run the iOS build" works when you've given a machine the `ios` label: `sling-runner config set labels ios`. Every machine also gets `os:` and `arch:` labels, such as `os:macos` and `arch:aarch64`.
- "On my laptop" makes that machine the first choice.
- "Run this in a fresh sandbox" uses a sandbox even when a machine is free.

If nothing can take a task, the assistant tells you why, machine by machine, and stops. It never edits code itself.

## Allowing a repo in sandboxes

A repo goes to a sandbox only if you allow it. On the **Machines** page, each allowed repo with a GitHub remote has a switch in the **Sandboxes** column. Turning it on adds the repo to your workspace's sandbox list:

- its remote, such as `github.com/acme/site`
- the HTTPS URL to clone it from
- its default branch
- whether the agent may use the network

A sandbox clones the repo from that URL and nothing else. Uncommitted changes, local branches, and other files on your machines never leave them. Turning the switch off doesn't change anything on your machines either: the list lives in Sling, not on the Runner.

## Providers

Add a provider on the **Connectors** page, the same way as Discord or email: Docker (a local or remote Docker Engine) or Railway (Railway Sandboxes on your own account). Each provider's connector page explains its setup.

Every provider has two settings worth knowing:

- **Image**: what the sandbox runs. The default is `sling-sandbox:latest`, or the server's `SLING_SANDBOX_IMAGE` when it's set. A custom image needs `sling-runner`, `git`, and the coding agents on `PATH`, and must start with `sling-runner sandbox`.
- **Sling's address for sandboxes**: how the sandbox reaches Sling. It defaults to `SLING_PUBLIC_URL`. A sandbox on another host or in the cloud needs an address it can actually reach.

Give each Sling server its own provider. Every minute Sling removes sandboxes the provider still runs that Sling no longer knows about, so two servers sharing one Docker host or Railway environment would remove each other's.

## When no machine can take it

If no machine can take a task, the repo is allowed in sandboxes, and a provider is set up, Sling asks first. The approval says exactly what will happen, for example:

> Run "Fix the footer" in a Docker sandbox?
> Clones github.com/acme/site into a sandbox on docker-host and runs the task there. No machine could take it: laptop: Offline.

Approve it in the web app, or with the buttons in Discord if you get approvals there. Then:

1. The provider starts a container.
2. Its Runner clones the repo, signs in to the coding agent, and connects to Sling.
3. The task runs and delivers its branch or pull request, just as on a machine.
4. The container is destroyed.

Rejecting the approval cancels the task. So does leaving it for 24 hours.

If you ask for a sandbox yourself, there's no approval step.

## Secrets

**Settings → Sandboxes** has three keys, each write-only. Sling shows whether one is stored, never its value. Saving an empty value removes it.

| Secret | Used for |
|---|---|
| OpenAI API key | Codex in a sandbox |
| Anthropic API key | Claude Code in a sandbox |
| GitHub token | Cloning, pushing, and opening pull requests |

A sandbox gets only what its task needs: the key for the agent it runs, and the GitHub token. They exist only in that sandbox, and they're gone when it's destroyed. The Runner uses the GitHub token for git and `gh` itself and keeps it, and every other Sling variable, out of the agent's environment.

For the GitHub token, use a fine-grained token limited to the repos you allow in sandboxes, with read and write access to contents and pull requests and nothing else.

A custom image can carry its own logins instead. Sling passes only the secrets you've stored.

## Limits and cost

| Setting | Default | What happens |
|---|---|---|
| Concurrent sandboxes | 2 | More requests wait, then start as sandboxes finish |
| Sandbox lifetime | 60 minutes | A sandbox past it is destroyed, and its task is marked interrupted |
| Monthly sandbox minutes | 600 | Past it, new sandboxes are refused, and Sling says so |
| Cost per hour, per provider | not set | When set, the Sandboxes page estimates this month's spend |

Minutes count from the moment a sandbox's Runner connects until it's destroyed. In Supervised mode, a sandbox stays up while a push or pull request waits for your approval, so approve or reject promptly.

Two more safety nets: a sandbox whose Runner hasn't connected within 10 minutes is destroyed and its task failed, and the Runner inside exits on its own after 15 minutes without a task.

## The Sandboxes page

It lists running and recent sandboxes with their provider, task, state, and run time, and this month's minutes against the budget. **Destroy** removes a sandbox right away and interrupts its task.

A sandbox moves through these states:

| State | Meaning |
|---|---|
| Requested | Waiting for a free slot |
| Provisioning | The provider is starting it, and its Runner hasn't connected yet |
| Ready | Its Runner connected with the repo cloned |
| Busy | Its task is running, or delivering |
| Releasing | Being destroyed after its task finished |
| Failed | Something went wrong: a provider error, the boot timeout, or the lifetime limit. It's destroyed next |
| Destroyed | Gone. If it failed, the reason stays on the page |

A sandbox's Runner never shows on the Machines page.

## For scripts

The same things are available over the API with your session cookie:

| Request | Does |
|---|---|
| `POST /api/tasks` | Starts a task. Accepts `repo` (a name or remote), `environment` (`auto`, `machine`, or `sandbox`), `machineId`, `providerInstallationId`, `harness` (`codex` or `claude-code`), and `labels` |
| `GET /api/sandboxes` | Running and recent sandboxes, with this month's usage |
| `POST /api/sandboxes/:id/destroy` | Destroys one |
| `GET /api/sandbox-repos` | The repos allowed in sandboxes |
| `PUT /api/sandbox-repos/:remote` | Allows one. The remote is URL-encoded, for example `github.com%2Facme%2Fsite`. Body: `{ cloneUrl?, defaultBranch?, network? }` |
| `DELETE /api/sandbox-repos/:remote` | Disallows one |
| `GET`, `PUT /api/settings/sandboxes` | Limits, cost per hour, and the default agent |
| `PUT /api/settings/sandboxes/secrets` | `{ openaiApiKey?, anthropicApiKey?, gitToken? }`. An empty string removes one |
