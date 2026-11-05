# Stage 3 build plan

More machines and environments. This is spec section 15, Stage 3, with the choices in `decisions.md` applied (D40 to D47 are new for this stage).

## Goal

A task goes to the right place without you naming it: the machine that has the repo and the coding agent, or, when that machine is offline, a fresh sandbox you approve. Claude Code joins Codex as a second coding agent.

## Done when

1. Pair two machines that both have `site`. A task for `site` goes to the one that's online with the right agent and the most free capacity, and the task card says why it picked that one.
2. Give one machine the label `ios`. "Run the iOS build" goes only to a machine with that label, and the agent explains when none is online.
3. Ask for Claude Code by name ("use Claude Code to…"), or set it as the default agent in Settings. The task runs with `claude -p` on a machine where Claude Code is installed and logged in. The timeline looks the same as a Codex task.
4. Turn on **Allow in sandboxes** for `site`, and add a Docker provider under Connectors, plus an OpenAI or Anthropic key and a GitHub token under Settings.
5. Turn the machine off and ask for a change in `site`. Sling says the machine is offline and asks to run the task in a Docker sandbox. Approve it in the web app or in Discord. A container starts, clones `site` from GitHub, runs the agent, pushes a branch, opens the PR, and is destroyed. The task card shows the sandbox, its provider, and how long it ran.
6. A repo without **Allow in sandboxes** never goes to a sandbox. The agent says it can't, and why.
7. The same task with a Railway provider runs in a Railway Sandbox on your own account.
8. "Run this in a fresh sandbox" gets a sandbox even when the machine is online.
9. **Limits:**
   - With the concurrent sandbox limit at 1, a second sandbox request waits.
   - With the monthly minutes used up, Sling refuses a new sandbox and says so.
   - A sandbox that outlives its time limit is destroyed, and its task is marked interrupted.
   - A sandbox the provider still lists after Sling destroyed it is removed on the next sweep.
10. The **Sandboxes** page lists running and recent sandboxes, with provider, task, state, run time, and minutes used this month against the budget, plus a **Destroy** button.

## Out of scope

- A public sandbox image registry. Releases publish `sling-sandbox` to the repo's container registry, and you can point a provider at your own image.
- Sandboxes that expose ports or previews. Railway Sandboxes can't, and Sling doesn't need them.
- Snapshots, forks, and checkpoint reuse across tasks. Every sandbox starts fresh.
- Fork and join in workflows. The assistant can still start several tasks at once on different machines.
- More than one user, OpenCode, and Gmail OAuth.

## Environments (D40)

A task runs in an **environment**:

- **Machine**: a paired Runner, long-lived, using your own logins. This is everything from Stage 1.
- **Sandbox**: a fresh environment an **execution provider** creates for one task, then destroys. Inside it runs `sling-runner sandbox`, which pairs itself with a one-time code bound to that sandbox and connects back like any other Runner. Everything downstream (dispatch, events, actions, approvals) is unchanged.

A sandbox Runner is **ephemeral**: it's marked as such on its `runners` row, linked to its sandbox, hidden from the Machines list, and revoked when the sandbox is destroyed.

### Sandbox boot contract

The control plane passes the provider a `SandboxSpec`, and the provider starts the image with these environment variables:

| Variable | Holds |
|---|---|
| `SLING_URL` | Control plane URL as the sandbox reaches it. The provider's `controlPlaneUrl` setting, or `SLING_PUBLIC_URL` |
| `SLING_PAIR_CODE` | One-time pairing code bound to this sandbox. Expires in 15 minutes |
| `SLING_SANDBOX_ID` | Sandbox ID |
| `SLING_REPOS` | JSON `[{ "name", "cloneUrl", "defaultBranch", "network" }]` |
| `SLING_HARNESSES` | Comma-separated agents to set up, for example `codex,claude-code` |
| `SLING_MAX_MODE` | `full-access`. The sandbox itself is the isolation boundary, and the conversation's mode still gates pushes and PRs |
| `SLING_IDLE_EXIT_SECONDS` | Exit after this long with no task, as a safety net. Default 900 |
| `OPENAI_API_KEY` | If stored and Codex is requested |
| `ANTHROPIC_API_KEY` | If stored and Claude Code is requested |
| `SLING_GIT_TOKEN` | If stored. Used by the Runner for clone, push, and `gh`, never passed to the agent |

`sling-runner sandbox`:
1. Configures a git credential helper that reads `SLING_GIT_TOKEN`, so the token never lands in `.git/config` or a URL.
2. Clones each repo shallowly, with full history for the default branch tip, into its workspace.
3. Logs each requested agent in with its API key (`codex login --with-api-key`; Claude Code reads `ANTHROPIC_API_KEY`).
4. Pairs with the code, and runs.

Child processes the Runner starts for the agent get an environment with `SLING_*`, `SLING_GIT_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` removed.

The **image contract**: `sling-runner`, `git`, and the requested agents on `PATH`, and an entrypoint of `sling-runner sandbox`. `deploy/sandbox/Dockerfile` builds the default image, `sling-sandbox`, from Debian slim with git, gh, Node 24, the Codex CLI, Claude Code, Python 3, and build-essential. A provider may name a custom image instead (D42).

### Lifecycle

```text
requested -> provisioning -> ready (Runner connected) -> busy (task running)
          -> releasing (task settled and delivered) -> destroyed
any state -> failed (provider error, boot timeout, lifetime exceeded) -> destroyed
```

- Provisioning has a boot timeout of 10 minutes for the Runner to connect.
- Once the task settles and its actions finish, or the task ends without actions, the sandbox is destroyed right away.
- A **sweep** every minute:
  - destroys sandboxes past their lifetime limit, which marks their task interrupted
  - fails sandboxes stuck in provisioning
  - asks each provider to `list()` and destroys anything labeled as Sling's that isn't live in the database
- Every transition is audited, and usage is recorded as the minutes from `ready` to `destroyed`.

## Routing (D41)

`delegate_coding_task` (the agent tool) and `agent.delegate_coding_task` (the workflow node) gain:

- `environment`: `"auto"` (default), `"machine"` with a `machineId`, or `"sandbox"`, with an optional `providerInstallationId`.
- `harness`: `"codex"` or `"claude-code"`. Defaults to the workspace's default agent.
- `labels`: labels the machine must have, for example `["ios"]`.

The router works out the candidates and returns a decision with reasons:

1. **Repo identity across machines.** Repos are matched by a normalized remote, `host/owner/name`, so `site` on two machines is the same repo. A name with no remote matches by name on that machine only.
2. **Eligible machines:**
   - online and not revoked
   - has the repo
   - the requested agent is ready
   - has every required label
   - the conversation's mode is within its cap
3. **Ranking among eligible machines:**
   - the named machine first
   - then the most free task slots
   - then the machine that ran this repo most recently, which keeps worktrees and caches warm
   - then the oldest pairing
4. **If none is eligible:**
   - Repo allowed in sandboxes, and a provider configured: create a `sandbox_fallback` approval with the reasons. Approving it provisions the sandbox, and rejecting it cancels the task.
   - Otherwise: refuse with the reasons. The agent reports them, as in Stage 1.
5. **Eligible machines are all busy:** the task queues on the best one, as today.

`TaskView` gains `environment` (kind, machine or sandbox, provider, sandbox state) and `routing` (the chosen target and a one-line reason for each machine considered).

## Cloud data boundary (D43)

- A repo goes to a sandbox only if it's in the workspace's **sandbox repo list**: a normalized remote, a clone URL (HTTPS), the default branch, and network on or off.
- On the Machines page, a repo row with a GitHub remote has an **Allow in sandboxes** switch that adds it to or removes it from that list. The list lives in the control plane: sandboxes are disposable and never touch your machines, so this doesn't widen anything a Runner allows.
- A sandbox only ever clones from the remote. Uncommitted work, local branches, and files on your machines never move.
- The fallback approval says exactly what will happen: "clone `github.com/a/site` into a Docker sandbox on `docker-host`".

## Execution providers (D44)

A provider is a connector with an `executionProvider` section in `connector-sdk`, so it reuses installations, encrypted credentials, connection tests, and the Connectors page.

```ts
interface ExecutionProvider<Credentials, Config> {
  create(ctx, spec: SandboxSpec): Promise<{ externalId: string; detail?: string }>;
  destroy(ctx, externalId: string): Promise<void>;
  /** IDs of environments this provider runs that carry Sling's label. */
  list(ctx): Promise<string[]>;
}
```

- **Docker** (`integrations/docker`):
  - Talks to the Docker Engine API over a Unix socket or TCP with TLS (dockerode).
  - Credentials: host, plus TLS certificates when needed.
  - Config: image, CPUs, memory, extra environment, `controlPlaneUrl`, and network mode (default `bridge`).
  - Containers are labeled `sling.sandbox=<id>` and `sling.workspace=<id>`. Images are pulled when missing.
  - Running the control plane in Docker with this provider means mounting the Docker socket, which is root-equivalent on that host. `deploy/docker-compose.sandbox.yml` does that, and the docs say what it means. A remote Docker host over TLS avoids it.
- **Railway** (`integrations/railway`):
  - Uses Railway Sandboxes (beta) through the `railway` TypeScript SDK on your own account.
  - Credentials: an API token and the environment ID. Config: image, idle timeout up to Railway's maximum, and `controlPlaneUrl`, which must be public.
  - Docker ships in every Railway Sandbox, so the provider runs the same `sling-sandbox` image inside it with `docker run`. That keeps the boot contract identical.
  - Railway Sandboxes can't expose ports. That's fine, because the Runner dials out.
  - Railway marks this API as changing between releases. The connector pins the SDK version, and its connection test creates and destroys a tiny sandbox.

## Secrets for sandboxes (D42)

**Settings → Sandboxes** holds three write-only secrets, encrypted like everything else: an OpenAI API key (for Codex), an Anthropic API key (for Claude Code), and a GitHub token. A fine-grained token limited to the repos you allow and to contents and pull requests is the recommended scope, and the page says so. They're injected only into the sandbox running the task, and they're gone when it's destroyed.

A provider can instead name a **custom image** with its own credentials or logins baked in. With a custom image, Sling injects only the secrets that are actually stored. The image contract is the only requirement.

## Limits and cost (D45)

Workspace settings, with these defaults:

| Setting | Default |
|---|---|
| Concurrent sandboxes | 2 (more requests wait) |
| Sandbox lifetime | 60 minutes |
| Monthly sandbox minutes | 600 (requests over budget are refused) |
| Estimated cost per hour, per provider | unset. When set, the Sandboxes page shows estimated spend |

## Claude Code (D46)

A Rust crate, `crates/harness-claude-code`, mirrors `harness-codex`:
- detection: version, and whether it's logged in
- spawn, parse, cancel, and a fake binary (`fake-claude`) for tests

Spike S4 settles the details and lands in `plan/spikes/s4-claude-code.md`:
- headless flags (`-p`, `--output-format stream-json`, `--verbose`)
- how each permission mode maps to Claude Code permission modes and its sandbox settings
- how to detect login state without reading credential files
- the stream event shapes

The starting mapping:

| Sling mode | Claude Code |
|---|---|
| Read-only | `--permission-mode plan` |
| Supervised, Auto | `--permission-mode acceptEdits`, with Claude Code's sandbox on and network off unless the repo allows it |
| Full access | `--dangerously-skip-permissions` |

The Runner's task code moves behind a `Harness` trait, so Codex and Claude Code share everything else: worktrees, commits, spools, cancel, and actions. The commit policy from D25 applies to both: tracked changes plus files the agent reports creating.

## Machine labels (D47)

`sling-runner config set labels ios,gpu`. Labels go in the Runner's `Inventory` (new protobuf field) and on the Machines page. The control plane can't set them, the same way it can't set repos. The OS and architecture are automatic labels (`os:macos`, `arch:aarch64`).

## Data model additions

| Change | Holds |
|---|---|
| `sandboxes` (new) | Workspace, owner, provider installation, task, state, external ID, image, boot code hash, `requested_at`, `ready_at`, `destroyed_at`, failure, minutes |
| `sandbox_repos` (new) | Workspace, normalized remote, clone URL, default branch, network |
| `runners` | `ephemeral`, `sandbox_id`, `labels` |
| `repos` | `remote_key` (normalized remote, indexed) |
| `tasks` | `runner_id` and `repo_id` become nullable until bound. New: `environment` (`machine` or `sandbox`), `sandbox_id`, `routing` (JSON), and `harness` can now be `claude-code` |
| `runner_enrollments` | `sandbox_id` |
| `workspaces` | `default_harness`, `sandbox_settings` (JSON) |
| `credentials.kind` | Adds `harness_openai`, `harness_anthropic`, and `git_token` |
| `approvals.kind` | Adds `sandbox_fallback` |

## API

```text
GET    /api/sandboxes                       recent and running, plus usage this month
POST   /api/sandboxes/:id/destroy
GET    /api/sandbox-repos                   the workspace's sandbox repo list
PUT    /api/sandbox-repos/:remoteKey        { cloneUrl, defaultBranch, network } (allow)
DELETE /api/sandbox-repos/:remoteKey        (disallow)
GET    /api/settings/sandboxes              limits, default harness, which secrets are stored
PUT    /api/settings/sandboxes              limits and default harness
PUT    /api/settings/sandboxes/secrets      { openaiApiKey?, anthropicApiKey?, gitToken? } (write-only; "" clears)
POST   /api/tasks                           gains environment, machineId, providerInstallationId, harness, labels
```

New realtime event: `sandbox.updated`. Plus `runner.updated` for ephemeral Runners, which the Machines page hides.

## Workstreams

The contracts land on `main` first. Four workstreams then run in parallel, each in its own worktree.

### W0. Contracts (on main, first)

- Protobuf: `Inventory.labels`, and the documented harness and capability names.
- `@sling/core`: `TaskView.environment` and `routing`, `SandboxView`, `SandboxRepoView`, `SandboxSettingsView`, `RunnerView.labels` and `ephemeral`, `ApprovalView.kind`, and the realtime events.
- `connector-sdk`: `ExecutionProvider` and `SandboxSpec`.
- `packages/db`: the tables and columns above, as migration `0002`.

### W1. Runner: Claude Code, labels, sandbox mode

- Spike S4, then `crates/harness-claude-code` with `fake-claude`.
- The `Harness` trait refactor, and labels in config and `Inventory`.
- `sling-runner sandbox`, which follows the boot contract.
- Child environment scrubbing, and the sandbox image.
- Tests: Rust unit tests for the parser and the trait, policy tests for both agents, and a test of sandbox boot against a local bare repo and a stub control plane.

### W2. Control plane: routing and sandbox orchestration

- The router and its reasons, repo identity by remote, the tool and node parameters, the default agent, and the mode cap for sandboxes.
- The sandbox service: lifecycle, codes bound to a sandbox, binding a task when its Runner connects, teardown after delivery, sweeps and orphan cleanup, limits and budget, and fallback approvals.
- The sandbox repo list, the settings and secrets API, and the views and events.
- Tests:
  - router unit tests
  - Postgres end-to-end tests with a `process` test provider that starts the real `sling-runner sandbox` as a local child process, which clones from a local bare repo and runs `fake-codex`
  - fallback approve and reject, limits, lifetime expiry, and orphan sweeps

### W3. Providers: Docker and Railway

- `integrations/docker` and `integrations/railway` against `ExecutionProvider`.
- Docker tests run against the real local daemon with a tiny image: create, list, destroy, labels, limits, and a missing image.
- Railway tests use a fake SDK client. A live test runs only when `RAILWAY_API_TOKEN` and `RAILWAY_ENVIRONMENT_ID` are set.
- Setup docs for both.

### W4. Web

- **Sandboxes page:** list, state, provider, task, run time, usage against the budget, and **Destroy**.
- **Settings → Sandboxes:** limits, the default agent, and the three write-only secrets with scope guidance.
- **Machines:** labels, and **Allow in sandboxes** per repo, with ephemeral Runners hidden.
- **Task card:** the environment badge and the routing explanation.
- **Approvals:** the fallback approval card, in the web app and as Discord approval text.
- Provider connectors on the Connectors page.

### W5. Integration (after merge)

- Register the providers.
- Build the `sling-sandbox` image, and run a real sandbox task end to end in Docker with `fake-codex` inside.
- Run the "Done when" list.
- Add the release step that publishes the sandbox image.
- Docs, threat model, and plan status.

## Testing

- **Unit:** router ranking and reasons, remote normalization, limits, the Claude Code stream parser, and environment scrubbing.
- **End to end, with the process provider:**
  - auto-route between two machines
  - labels
  - a Claude Code task with `fake-claude`
  - offline to fallback approval, to sandbox, to push, to destroyed
  - rejecting the fallback
  - a repo that isn't allowed
  - the concurrency limit, the budget, the lifetime limit, and orphan cleanup
- **Docker:** the real `sling-sandbox` image on the local daemon, cloning from a bare repo served over HTTP, with `fake-codex` doing the work.

## Budgets

| Measure | Budget |
|---|---|
| Docker sandbox, request to Runner connected (image cached) | under 15 s |
| Routing decision | under 20 ms |
| Sandbox destroyed after its task delivers | under 30 s |
