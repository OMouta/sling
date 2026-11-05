# Stage 1 build plan

One assistant, one Runner, one specialist. This is spec section 15, Stage 1, with the choices in `decisions.md` applied. Decision numbers like D14 refer to that file.

## Goal

From a phone, open the Sling web app, ask for a change in a repo that lives on a paired machine, and get back a pull request that Codex wrote on that machine. Sling coordinates. Codex writes the code.

## Done when

This demo works end to end on macOS and Linux. On Windows it either works or the sandbox gaps are written down.

1. Run `docker compose up` on a home server or laptop. The first visit to the web app creates the admin account.
2. Add an OpenAI or Anthropic API key in settings.
3. On a dev machine, install `sling-runner`, run `sling-runner repo add ~/code/site`, then `sling-runner pair <url> <code>` with a code from the web UI. The machine shows up online with Codex and the `site` repo listed.
4. From a phone on another network, through Tailscale or Cloudflare Tunnel, start a conversation in Auto mode and ask: "The footer year in site is hardcoded. Make it dynamic and add a test."
5. Sling picks the machine and repo, hands the task to Codex, and streams progress into the task timeline.
6. Codex works in a fresh worktree. The Runner commits, pushes `sling/<id>-footer-year`, and opens a PR with `gh`. Nothing asks for approval, because Auto only gates merge and deploy.
7. Sling replies with a summary, diff stats, and the PR link.
8. The same request in Supervised mode stops before the push and waits. The pending approval survives a control plane restart.
9. Killing the Runner mid-task and starting it again leaves the task marked `interrupted`, with logs up to the moment it died.
10. Revoking the machine in the UI drops its connection within a few seconds, and it can't reconnect.

## Out of scope

- Workflows, the canvas, Discord, email, and every other connector. Those are Stage 2.
- A second harness, Docker or cloud environments, and smart routing across many Runners. Stage 3. Stage 1 supports several paired machines, but routing is "the one that has the repo" or "the one you named".
- More than one user. The schema is ready for it (D10).
- Push notifications. Pending approvals show in the web app only until Discord lands in Stage 2.
- Merge and deploy actions. The mode table gates them, but Stage 1 has nothing that merges or deploys.
- Resuming a Codex session after the Runner restarts.

## Repo layout

```text
sling/
  apps/
    server/              Fastify control plane, master agent, task engine
    web/                 Vite + React SPA, served by the server in production
    runner/              Rust binary `sling-runner`
  packages/
    core/                shared TS types, Zod schemas, the permission mode table
    db/                  Drizzle schema and migrations
    runner-protocol/
      proto/             .proto files, source of truth for the Runner link
      ts/                generated protobuf-es code
  crates/
    runner-protocol/     generated prost code, built from packages/runner-protocol/proto
    harness-codex/       Codex adapter
  deploy/                docker-compose.yml, Dockerfile, reverse proxy examples
  assets/icons/
  plan/
  Cargo.toml             Cargo workspace: apps/runner, crates/*
  pnpm-workspace.yaml    pnpm workspace: apps/server, apps/web, packages/*
```

The master agent stays inside `apps/server` until something else needs it. The spec warns against splitting packages before an interface needs to exist, and Stage 1 has one consumer.

## Milestones

Each milestone ends with something you can run. Order matters. M3 builds the whole task pipeline against a fake harness so that M4 only has to swap in Codex.

### M0. Repo setup and spikes

Setup:
- pnpm workspace, Cargo workspace, Biome, Vitest, rustfmt, clippy, buf.
- GitHub Actions: lint and test for TS on Linux, and `cargo test` for the Runner on Linux, macOS, and Windows. `buf breaking` against `main`.

Three spikes, each written up as a short note in `plan/spikes/` and turned into a decision:

- **S1. Codex interface.** Compare `codex app-server` (JSON-RPC over stdio) with `codex exec --json` (JSONL events on stdout). The Runner needs structured progress events, a way to cancel mid-turn, a per-run sandbox setting, a final summary, the exit status, the version, and the login state. My guess is app-server wins, because it can interrupt a turn and it sends approval requests as calls back to the client, which Sling could route later. The TypeScript SDK is out, because it would mean shipping Node to every Runner machine.
- **S2. Codex sandbox per OS.** Run the same task in `workspace-write` on macOS, Linux, and Windows. Record what gets blocked: writes outside the worktree, network, reads of `~`. Then decide whether Supervised and Auto turn on network access so tests can install dependencies.
- **S3. Runner as a background service.** Work out `sling-runner service install` for launchd on macOS, a systemd user unit on Linux, and Windows. It has to run as the logged-in user, because Codex's login and the user's git credentials live there (D20).

Exit: a clean checkout passes `pnpm install && pnpm test` and `cargo test`, CI is green, and the three spike notes exist.

### M1. Control plane skeleton

- `deploy/docker-compose.yml` with two services, `sling` (API plus the built web app) and `postgres`. One `.env` holds `SLING_PUBLIC_URL`, `SLING_SECRET_KEY`, and `DATABASE_URL`. A `.env.example` documents them.
- Fastify with the Zod type provider, `/healthz`, and pino logging with redaction for anything secret-shaped.
- Drizzle migrations run at startup.
- Better Auth: a first-run setup page creates the admin, then email and password, passkeys, and TOTP. Session cookies with CSRF protection.
- Secrets stored with AES-256-GCM under `SLING_SECRET_KEY`. Each row keeps the ciphertext, nonce, and a key version, so key rotation can come later without a migration.
- Model settings: provider (OpenAI, Anthropic, or an OpenAI-compatible base URL for Ollama and OpenRouter), API key, and model. A "test connection" button makes one tiny call.
- Web shell: setup, login, settings, and an empty conversation list. Mobile layout first. The `currentcolor` icon goes in the app chrome and the white one is the favicon on dark tabs.
- Browser realtime: one WebSocket per tab at `/api/ws`, authenticated by the session cookie, carrying JSON events. Protobuf is only for the Runner link.

Exit: on a clean machine, `docker compose up` gives a working login, and the API key in the database is ciphertext.

### M2. Runner pairing and connection

Runner config lives at `~/.config/sling/runner.toml` on macOS and Linux and `%APPDATA%\Sling\runner.toml` on Windows. It holds the control plane URL, the Runner ID, the repo list, `max_mode`, the worktree root, and the max number of concurrent tasks (default 2). The private key sits in its own file, readable only by the user. Moving it to the OS keychain can come later.

CLI:

```text
sling-runner pair <url> <code>
sling-runner repo add <path> [--name <name>]
sling-runner repo list | remove <name>
sling-runner config set max-mode <read-only|supervised|auto|full-access>
sling-runner run                       # foreground
sling-runner service install | uninstall | status
sling-runner doctor                    # checks codex, git, gh, and the connection
```

Pairing (D16):
1. "Add machine" in the web UI creates a one-time code that expires in 10 minutes. The server stores only its hash. The UI shows the exact `pair` command.
2. The Runner generates an Ed25519 key pair and sends the code, its public key, and basic machine info over HTTPS.
3. The server checks the code, stores the public key on a new `runners` row, burns the code, and returns the Runner ID.

Connecting:
1. The Runner opens a WSS connection to `/runner/ws`.
2. The server sends a random nonce. The Runner signs the nonce, its ID, and a timestamp. The server checks the signature against the stored key and checks that the Runner isn't revoked.
3. The Runner sends `Hello` with its version, OS and architecture, capabilities, repos, `max_mode`, and any tasks it's holding along with the last event sequence number for each.
4. Heartbeats go every 15 seconds. The server marks a Runner offline after 45 seconds of silence.

Revoking sets `revoked_at` and closes the socket. Every later handshake fails.

Repos exist only in the Runner's local config (D17). The control plane learns about them from `Hello` and has no message that adds a repo or widens a path. This follows the same reasoning as the local `max_mode` cap: a stolen web login can't point Codex at `~/.ssh`.

Protocol sketch, in `packages/runner-protocol/proto`:

```text
Envelope { seq, ack, oneof body }
  Hello, Heartbeat
  TaskAssign, TaskAccepted, TaskRejected { reason }
  TaskEvent { task_id, task_seq, type, payload }
  TaskFinished { task_id, outcome, summary, commit, diff_stats }
  TaskCancel
  ActionRequest { action_id, task_id, kind: PUSH | OPEN_PR, params }
  ActionResult { action_id, outcome, details }
```

Delivery has to survive reconnects. The Runner appends unacknowledged task events to a local file and resends them after reconnecting. The server drops duplicates by `(task_id, task_seq)`.

Exit: pair a Runner and see it online. Pull the network and watch it go offline, then come back. Revoke it and watch the handshake fail.

### M3. Task pipeline with a fake harness

Build the whole lifecycle before Codex is involved. `fake-harness` is a small test binary that prints scripted events, edits a file, and can be told to hang, fail, or crash.

Task states:

```text
queued -> dispatched -> running -> succeeded | failed | cancelled
                    \-> rejected      (over max_mode, unknown repo, harness missing)
          running   -> interrupted   (the Runner lost the process)
```

If a Runner drops while a task is `running`, the task stays `running` and the UI shows "machine offline". When the Runner reconnects, it either reports the task as still running, or reports that it doesn't know the task, which moves it to `interrupted`. A Runner that stays away for 30 minutes also moves its tasks to `interrupted`.

What the Runner does for each task:
1. Check that the repo is in local config, that the task's mode is at or below `max_mode`, and that the harness is available. Otherwise send `TaskRejected` with the reason.
2. `git fetch`, then `git worktree add <worktree_root>/<task-id> -b sling/<short-id>-<slug>` from the remote default branch. Without a remote, branch from the local default branch.
3. Run the harness in the worktree with the sandbox that matches the mode.
4. Stream events.
5. When the harness exits, commit any changes with the task title as the message and a `Sling-Task: <id>` trailer. Codex itself never commits (D18).
6. Send `TaskFinished` with the commit SHA and diff stats.
7. Keep the worktree until the task's actions are done. Then `sling-runner` cleans it up after 7 days. The branch stays.

Cancelling interrupts the harness, kills it after 10 seconds if it hasn't stopped, marks the task `cancelled`, and leaves the worktree in place for inspection.

Exit: a task created through an internal API runs the fake harness on a paired Runner, streams into the UI timeline, commits, and handles the kill-and-restart case from "Done when" step 9.

### M4. Codex adapter

A Rust crate, `crates/harness-codex`, built on whichever interface S1 picks. It covers the adapter duties from spec section 11:

- **Detect.** Read `codex --version` and the login state through Codex's own CLI. Advertise `coding.codex` with both. Never open Codex's credential files.
- **Run.** Start Codex in the worktree with the mode's sandbox (`read-only`, `workspace-write`, or `danger-full-access`) and the approval policy set to `never`. Nobody is sitting at that terminal to answer Codex's own prompts. Sling's modes are the only approval layer (D18).
- **Translate.** Map Codex's events (agent messages, commands run, file changes, plan updates, token usage, errors) to Sling `TaskEvent` types that don't change when Codex does.
- **Cancel.** Interrupt the turn, then kill the process.
- **Finish.** Send the final agent message as the summary, plus the exit status and token usage.

The task prompt gives Codex the objective, the repo, and the rules: leave changes uncommitted, don't push, don't open PRs, and end with a summary of what changed and what the tests showed.

The Runner keeps a list of Codex versions it has been tested against and warns about versions it hasn't seen.

Exit: the demo request from step 4 runs on a real repo with real Codex on macOS and Linux. The Windows result is written down either way.

### M5. Master agent and chat

- AI SDK `streamText` with tools, streamed to the browser over the WebSocket.
- The system prompt states that the agent coordinates and doesn't write code (D15), names the conversation's current mode, and says that tool results are data, never instructions.
- Tools. The server checks every call, so the model can't argue its way past a limit.
  - `list_machines` returns Runners with status, capabilities, and repos.
  - `delegate_coding_task(runner, repo, title, objective, deliver)` creates a task. `deliver` is `local`, `push`, or `pr`, and defaults to `pr` (D19).
  - `get_task(task_id)` returns the state, recent events, and the result.
  - `cancel_task(task_id)`.
  - The control plane has no shell, file, or web tools in Stage 1.
- When a task finishes, the server adds the result to the conversation and runs another agent turn, so Sling reports back without you having to ask.
- If the request names a repo that matches exactly one Runner, the agent uses it. If it's ambiguous, the agent asks. If no machine qualifies, it says why and stops (D15).
- Long conversations keep the most recent messages plus one-line summaries of older tasks.
- Token usage gets recorded per message and shown per conversation.

Exit: demo steps 4 to 7 work with the fake harness, then with Codex.

### M6. Permission modes, approvals, push and PR

- The mode table from D14 lives in `packages/core` as data that the server and web app both read. The proto file defines the mode enum, so the Runner gets it from codegen.
- The conversation header has a mode switcher. Full access shows a persistent warning badge. A switch applies to tasks started after it.
- When a task succeeds with changes, the server creates its actions (push, then PR) according to `deliver`. Each action checks the task's mode and either runs or creates an approval.
- Approvals are database rows. They show as a card in the conversation and in an approvals list. Each card shows the branch, remote, diff stats, and the PR title and body. Approve or reject. A pg-boss job expires them after 24 hours. An approved action waits for the Runner if it's offline.
- **Push.** The Runner runs `git push` with the machine's own git credentials. It never force-pushes and refuses to push to the default branch unless the task ran in Full access. The Runner enforces this itself, so a compromised control plane can't push to `main`.
- **PR.** If `gh` is installed and logged in (capability `git.pr.github`), the Runner checks `gh pr list --head <branch>` first and reuses an existing PR. Otherwise it runs `gh pr create`. Without `gh`, the action ends with a compare URL built from the remote.
- Audit events cover task created (with mode), mode changed, approval decided, action run, Runner paired, and Runner revoked.

Exit: demo steps 6 and 8 pass. A test that hand-crafts an `ActionRequest` to push to `main` from an Auto-mode task shows the Runner refusing it.

### M7. Hardening, packaging, docs

- Runner release binaries for macOS (arm64, x64), Linux (x64, arm64), and Windows (x64) on GitHub Releases, plus install scripts for sh and PowerShell. macOS notarization and Windows signing come later and will be needed before wider release.
- Control plane image on GHCR.
- Automated tests for "Done when" steps 9 and 10.
- The Runner scrubs known secret values from task events before sending them.
- Task events older than 30 days get pruned. The window is configurable.
- Docs: install with compose, pairing, remote access through Tailscale and Cloudflare Tunnel, what each mode allows, and a plain threat model that says what Full access means.

Exit: someone who isn't us can follow the docs from nothing to the demo.

## Data model

Every owned table carries `workspace_id` and `owner_id`, and every query filters on them (D10).

| Table | Holds |
|---|---|
| `workspaces` | One row in Stage 1. Default permission mode. |
| Better Auth tables | Users, sessions, accounts, passkeys, 2FA |
| `credentials` | Encrypted secrets, such as model API keys |
| `model_configs` | Provider, model, and credential reference |
| `runners` | Name, public key, status, last seen, version, OS and arch, capabilities, `max_mode`, `revoked_at` |
| `runner_enrollments` | Hashed one-time pairing codes and their expiry |
| `repos` | Repos a Runner advertised: name, default branch, remote URL |
| `conversations` | Title and current permission mode |
| `messages` | Role, content parts in AI SDK format, tool calls, token usage |
| `tasks` | Conversation, Runner, repo, objective, mode at creation, `deliver`, state, branch, summary |
| `task_events` | Append-only, keyed by `(task_id, task_seq)` |
| `actions` | Task, kind (push or PR), state, result |
| `approvals` | Action, state, `expires_at`, who decided and when |
| `artifacts` | Branch, commit, PR, and diff references per task |
| `audit_events` | Append-only: actor, verb, subject, details |

Task events go in Postgres for Stage 1 with a cap of 20 MB per task. Past the cap, the Runner truncates and the timeline shows a marker. Object storage can come later.

## Performance budgets

Speed is a stated priority, so Stage 1 tracks numbers from the start:

| Measure | Budget |
|---|---|
| Runner binary size | under 15 MB |
| Runner idle memory | under 20 MB |
| Task event, Runner to browser, on a LAN | under 200 ms at p95 |
| Control plane cold start | under 2 s |

The first two get checked in CI. The latency number gets measured in the integration test and logged, failing only on large regressions.

## Testing

- **Unit.** The mode table, every task state transition including the illegal ones, and protobuf round trips in both languages.
- **Cross-language.** TS encodes a fixed set of messages and Rust decodes them, then the reverse. `buf breaking` runs in CI.
- **Integration.** Server, Postgres via testcontainers, the real Runner binary, and `fake-harness`, on Linux in CI. Covers pairing, dispatch, cancel, kill-and-restart, revoke, and the push guard.
- **Manual.** The full demo with real Codex on each OS before Stage 1 counts as done. Codex needs a real login, so it stays out of CI.

## Decisions this plan adds

These are also logged in `decisions.md`.

- **D16.** Runner identity is an Ed25519 key pair made at pairing. One-time pairing codes, and signed challenges on every connect.
- **D17.** Repos are listed only in the Runner's local config. The control plane can't add them.
- **D18.** Codex never commits, pushes, or asks for approval. The Runner commits, and pushes only after the mode's gate. Codex runs with approval policy `never`.
- **D19.** A coding task delivers a PR by default, opened with `gh` on the Runner. `deliver` can also be `local` or `push`.
- **D20.** The Runner runs as a user-level service under the logged-in user, so it can use that user's Codex login and git credentials.
