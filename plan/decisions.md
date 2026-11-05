# Sling decisions log

Decisions made against `spec.md`. Each entry says what was picked and what it rules out. Where a decision answers one of the spec's open questions (section 19), the entry cites it.

## Project-wide priorities

- Speed and performance matter a lot. When two options are otherwise close, pick the faster one. This came up while choosing the Runner language.

## Decided

### D1. License: Apache-2.0
Answers open question 12. Permissive, with an explicit patent grant. Add `LICENSE` and a `NOTICE` file at the repo root. Bundled third-party connectors and tools still need their own license check before redistribution (spec section 17).

### D2. Stage 1 coding harness: Codex
The Stage 1 adapter targets Codex (`codex exec --json` and/or the Codex TypeScript SDK). Claude Code and other adapters come in Stage 3. The `DelegatedTask` contract should still be reviewed against Claude Code's headless interface before it's frozen, so it doesn't end up Codex-shaped.

### D3. Control plane runtime: Node.js LTS + pnpm workspaces
Matches spec section 14. Monorepo uses pnpm workspaces with the `apps/`, `packages/`, `integrations/` layout from the spec.

### D4. Runner language: Rust
Chosen for speed and a small footprint. The Runner is a separate Cargo workspace member under `apps/runner/` (or `runner/`). Two consequences:
- Protocol types can't be shared as TypeScript. They need a language-neutral schema with codegen for both sides (see the open item on runner protocol format).
- It lines up with a future Tauri desktop app, which is also Rust.

### D5. Model providers: Vercel AI SDK behind Sling's `ModelProvider` interface
The AI SDK handles OpenAI, Anthropic, Google, OpenRouter, and Ollama, and normalizes their streaming, tool calls, and structured output. Sling code depends only on its own `ModelProvider` interface (spec section 11), so a provider the SDK doesn't cover can get a hand-written adapter. Stage 1 ships with API-key providers only. Subscription sign-in flows wait until a provider documents that they're allowed (open question 6).

### D6. Deployment: Docker Compose
The supported self-host path is `docker compose up`, with the control plane, web UI, and Postgres as services. The Runner does not run in that compose file. It installs natively on each machine, because it needs the machine's own tools, repos, and harness logins.

### D7. Persistence: Postgres, Drizzle ORM, pg-boss
Answers open question 5. This replaces the SQLite suggestion in spec section 14. SQLite's advantage was skipping a database server, and Docker Compose already removes that cost. Postgres also gives:
- concurrent writers (API, workflow engine, and Runner log ingestion all write at once; SQLite allows one writer at a time)
- `SELECT ... FOR UPDATE SKIP LOCKED` for claiming jobs
- `LISTEN/NOTIFY` to wake workers without polling
- a path to more than one control-plane process later

pg-boss handles dispatch, retries, cron schedules, and singleton keys. Sling's own tables hold workflow execution state and task status (the state machine), so durability never depends on queue internals. Use one database dialect only. Local dev runs Postgres from the same compose file.

### D8. Runner protocol: Protobuf over WebSocket
`.proto` files in `packages/runner-protocol/` are the source of truth. Codegen: prost for Rust, protobuf-es for TypeScript, with buf for linting and breaking-change checks. Runners dial out to the control plane over WSS and exchange binary protobuf frames. WebSocket was chosen over gRPC because it passes reliably through reverse proxies and tunnels (see D9).

### D9. Runner networking: direct connection, documented tunnels
Answers open question 4. Runners connect straight to the control plane URL. Docs cover Tailscale and Cloudflare Tunnel for reaching a home control plane remotely. No relay service is planned.

### D10. Users: single user in Stage 1, schema ready for more
Answers open question 11. Stage 1 has one admin account. Every owned record carries `workspaceId` and `ownerId` from the first migration, and every query filters by them. Roles, invites, and sharing come later without a data migration.

### D11. Stage 1 isolation: git worktree + Codex sandbox
Partly answers open question 3. For each task the Runner creates a fresh git worktree inside an allowlisted repo, and Codex runs there in its workspace-write sandbox mode as the Runner's OS user. The permission mode decides what needs approval (see D14). Docker-per-task isolation is a Stage 3 execution provider. Before Stage 1 ships, verify how strong Codex's sandbox is on Windows, and document the gap if it's weaker than on macOS and Linux.

### D12. Stage 1 interface: web app only
Responsive layout so it's usable from a phone. Discord arrives in Stage 2 as a connector plus a workflow template, not as a special-cased backend (spec section 10).

### D13. Web UI auth: Better Auth
Email and password, passkeys, and TOTP 2FA, with sessions in Postgres through the Drizzle adapter. Runner pairing uses its own device credentials (spec section 7), not user sessions.

### D14. Permission modes, picked per conversation
Answers open question 9. These replace a fixed list of approval gates, and they work like Claude Code's and T3 Code's modes. Each mode sets Sling's approval gates and Codex's sandbox level together:

| Mode | Codex sandbox | Sling asks before |
|---|---|---|
| Read-only | `read-only` | nothing gets written, so nothing to approve |
| Supervised | `workspace-write` | push, PR, merge, deploy |
| Auto (default) | `workspace-write` | merge, deploy |
| Full access | `danger-full-access` | nothing |

- Auto is the default for new conversations. Change it in workspace settings.
- The mode belongs to the conversation and can change at any time. A change applies to tasks started after it. A running task keeps the mode it started with.
- Auto and Supervised never push to the default branch and never force-push. Those need Full access or a merge approval.
- Full access shows a persistent warning badge in the UI for that conversation.
- Runner cap: each Runner has a `max_mode` in its local config file. The Runner rejects any task above the cap and reports it as a policy rejection. The control plane can't raise this setting. Default: Full access allowed.
- Every task records its mode in the audit log.

### D15. No eligible specialist: stop and report
If no online Runner has Codex available, the master agent says which machines are offline or missing Codex and suggests next steps. It never falls back to editing code itself. A configurable fallback (queue until online, or a cloud sandbox) can come in Stage 3.

### D16. Runner identity: Ed25519 key pair
The Runner generates the key pair at pairing time and sends only the public key, together with a one-time code that expires in 10 minutes and is stored hashed. Every connection starts with the server sending a nonce for the Runner to sign. Revoking a Runner closes its socket, and every handshake after that fails. Details in `stage1.md` M2.

### D17. Repo allowlist lives on the Runner
Repos are added with `sling-runner repo add` and stored only in the Runner's local config. The control plane learns about them when the Runner connects and has no way to add one. This mirrors the `max_mode` cap in D14.

### D18. Codex never commits or pushes
Codex runs with approval policy `never` and is told to leave its changes uncommitted. The Runner commits them, then pushes only after the conversation's mode allows it. Sling's modes are the only approval layer.

### D19. Coding tasks deliver a PR by default
`deliver` is `pr` by default and can be set to `local` or `push`. The Runner opens PRs with `gh` when it's installed and logged in. Otherwise it falls back to a compare URL.

### D20. The Runner runs as a user-level service
It uses launchd on macOS and a systemd user unit on Linux. Windows gets settled in spike S3. Running as the logged-in user lets the Runner use that user's Codex login and git credentials, consistent with D11.

### D21. Codex interface: `codex exec --json`
From spike S1. `codex app-server` is still marked experimental in codex-cli 0.166.0. The Runner spawns `codex exec --json -s <sandbox> -C <worktree>` with stdin closed and reads JSONL events from stdout. Cancel is SIGINT, then SIGKILL after 10 seconds.

### D22. Codex network: off, with a per-repo opt-in on the Runner
From spike S2. On macOS, `workspace-write` blocks writes outside the worktree and blocks network, but reads are unrestricted. Network stays off in Read-only, Supervised, and Auto. A repo entry in the Runner's local config can set `network = true`. The control plane can't change it.

### D23. Agent turns run in-process, one at a time per conversation
Not pg-boss. A turn that died halfway can't be retried safely, because it may already have started a task, and a retry would start it again. Each conversation has an in-memory queue instead. On startup the server answers any conversation from the last hour whose last message (from the user or a task update) never got a reply.

### D24. The server runs TypeScript source with Node's type stripping
There's no build step for the server or the shared packages. That rules out TS enums and parameter properties (`erasableSyntaxOnly` enforces it), and it's why protobuf codegen emits `.js` plus `.d.ts`. Node won't strip types inside `node_modules`, so the Docker image keeps the monorepo layout with workspace packages symlinked from `/app/packages`.

### D25. The Runner commits tracked changes plus files Codex reports
Found in the first real Codex run: Codex ran the tests, Python wrote `__pycache__`, and `git add -A` committed it. Now the Runner stages changes to tracked files, plus new files that Codex reported in a `file_change` event. Other untracked files stay out of the commit, and the task log lists them.

### D26. One approval per action, decided together per task
Push and PR each get an approval record, so the audit log shows exactly what was approved. The web app's **Approve** button approves every pending step of a task at once, since asking twice for one change is noise.

### D27. Tests use a fake Codex and a scripted model
`fake-codex` (in `crates/harness-codex`) speaks the same JSONL as `codex exec --json`, with scenarios for success, failure, hanging, and crashing. The end-to-end suite runs real Postgres, the server, and the real Runner binary against it, with the AI SDK's mock model playing the agent. Real Codex stays out of CI because it needs a login.

## Stage 2

### D28. Email: IMAP and SMTP
Works with any mailbox, Gmail and Fastmail included through app passwords, and needs no Google Cloud project. imapflow handles IMAP with IDLE and falls back to polling. nodemailer sends, and mailparser parses. Gmail OAuth can come later as its own connector.

### D29. Expressions: JSONata, with limits
Config fields marked `expression` take JSONata written as `={{ … }}`. JSONata runs no arbitrary code. Evaluation is capped at 1 second and a recursion depth of 300. There's no JavaScript code node.

### D30. Chat runs through the workflow engine
The web chat is the installed **Sling Assistant** workflow: `app.chat_message` to `state.conversation` to `agent.assistant`. The Discord assistant template reuses the same nodes. Each conversation records the workflow that owns it, so follow-ups after a task settles go back where the conversation started. Turns for one conversation run in order through a concurrency key.

### D31. Discord approvals use buttons, for allowlisted users only
Approval DMs carry Approve and Reject buttons. The connector accepts a click only from a Discord user ID in the installation's `approverUserIds`, and only for a pending approval in the same workspace. Accepted and refused clicks are both audited with `via: "discord"`. This makes an approver's Discord account an approval key, which is a choice you made knowingly. The threat model says so.

### D32. Workflow format: `sling.workflow/v1` JSON
Nodes with typed data ports and named exec ports. Exec edges and data edges are separate. Drafts are mutable, versions immutable, and runs record their version. Templates are the same JSON, kept in `workflows/`.

### D33. Retries are opt-in, and never automatic for side effects
The engine retries a failed node only when the error is retryable and the node spec says it's idempotent. Sending a message, sending email, and starting a task are not retried after an ambiguous failure. Every node run gets an idempotency key that connectors pass along where the service supports one.

### D34. Discord: discord.js gateway bot with a token you provide
You create the bot in the Discord developer portal and paste its token into the installation. It needs the Message Content intent. Messages from users outside the installation's allowed list are dropped before any trigger fires.

### D35. One durable job per run, persisted after every node
A pg-boss job runs a workflow run's nodes in a loop and saves the cursor after each one. Waiting runs hold no job. A node that was running when the process died is re-run only if it's idempotent; otherwise it fails as "interrupted, outcome unknown".

## Defaults I picked (override any of these)

- Web client is React + TypeScript as a Vite SPA, served by the control plane. There's no SSR need, so no Next.js. TanStack Router (code-based routes) and TanStack Query, styled with Tailwind 4. Chat replies render through react-markdown, which never renders raw HTML.
- HTTP and WebSocket API run on Fastify, with Zod schemas (spec section 14) through `fastify-type-provider-zod`.
- Tooling is Vitest for TS tests, Biome for TS lint and format, and rustfmt plus clippy for Rust. Turborepo gets added only if builds get slow.
- Runner crates are tokio, tokio-tungstenite with rustls, and prost.
- Secrets at rest use AES-256-GCM with a master key supplied as an env var or Docker secret.
- In Stage 1, git credentials come from the Runner machine's existing setup (SSH keys or credential helper). Sling doesn't store or inject git tokens yet.
- The Runner reports Codex's login state through Codex's own CLI. It never reads Codex's credential files.
- Pending approvals expire after 24 hours.
- Deterministic workflows run with no LLM configured (open question 1).

## To verify before building Stage 1

These became spikes S1 to S3. Notes are in `plan/spikes/`. S1 and S3 are settled. S2 still needs a Linux and a Windows run.

- Which Codex interface to wrap (open question 2). The Runner is Rust, so the Codex TypeScript SDK would mean shipping Node to every Runner machine. That points to `codex exec --json` or `codex app-server` (JSON-RPC over stdio). Check which one gives structured progress, cancellation, and resumable sessions.
- How strong Codex's sandbox is on Windows compared with macOS and Linux.
- Codex's `workspace-write` sandbox blocks network by default. Decide whether Supervised and Auto turn network on so tests can install dependencies.
- How to run the Runner as a user-level service on Windows.

## Deferred to later stages

- Docker and Railway execution providers, cloud cost controls (open question 10), and delivering secrets to isolated tasks (open question 7): Stage 3.
- Desktop app (Tauri): after Stage 2.
- Extension signing and a marketplace: Stage 4.
