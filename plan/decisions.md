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

### D36. Node-run writes commit asynchronously, except before side effects
Writing each node run with `synchronous_commit = on` put the engine's overhead at about 6 ms per node at p95, over the 5 ms budget. Node-run writes now use `synchronous_commit = off`, except the write right before a node with side effects, which waits for the WAL flush. If Postgres itself crashes, the worst case is an idempotent node running again, or a side-effect node reported as "interrupted, outcome unknown". Measured after the change: about 1.7 to 1.95 ms at p95.

### D37. One server process per database, for now
On startup the server clears run jobs left active, retrying, or failed by the last process, because a failed job on a per-key queue would block that key forever. Cancel also only reaches runs in the current process. Running two control-plane processes against one database needs a lease or heartbeat on runs first.

### D38. Webhook tokens are derived, not random
A webhook token is an HMAC of the server secret, the workflow ID, and the trigger node ID, and only its hash is stored. The URL stays the same across republishing. Rotating it means giving the trigger node a new ID. Changing `SLING_SECRET_KEY` changes every webhook URL.

### D39. Template wiring follows the port rules
A data input takes one edge, so in the Discord assistant both triggers rejoin at **Conversation**, which works out the key with an expression, rather than each feeding the assistant directly. Where a node's text comes from config rather than an input port (for example a Discord message built from an email's subject and an AI summary), the template stores the value with **Set variable** and reads it as `vars.<name>` in the expression.

## Stage 3

### D40. A sandbox is a Runner that pairs itself
An execution provider starts an image that runs `sling-runner sandbox`, which pairs with a one-time code bound to that sandbox and connects back like any machine. Dispatch, events, actions, and approvals stay exactly as they are. The sandbox's Runner is ephemeral: hidden from Machines, and revoked when the sandbox is destroyed.

### D41. Routing picks the machine, and explains itself
Repos are matched across machines by their normalized remote. A machine is eligible when it's online, has the repo, has the requested agent ready, has the required labels, and allows the conversation's mode. Among those, the named machine wins, then the most free slots, then the one that ran the repo last. Every decision records a one-line reason per machine, shown on the task.

### D42. Sandbox credentials: stored keys by default, custom images allowed
An OpenAI key, an Anthropic key, and a GitHub token are stored encrypted under Settings and injected only into the sandbox running the task. The Runner uses the git token itself and strips it, and every `SLING_*` variable, from the agent's environment. A provider can name a custom image with its own credentials instead.

### D43. Only repos you allow go to sandboxes, and only from their remote
The workspace keeps a list of repos allowed in sandboxes, keyed by normalized remote. A sandbox clones from that remote and nothing else, so local files and uncommitted work never leave your machines. The list lives in the control plane, because sandboxes are disposable and don't touch your machines.

### D44. Providers: Docker and Railway Sandboxes, as connectors
Execution providers are connectors with an `executionProvider` section, so they reuse installations, encrypted credentials, and connection tests. Docker uses the Engine API. Railway uses Railway Sandboxes (beta) through its TypeScript SDK, running the same `sling-sandbox` image with the Docker that ships in every sandbox. Both label what they create, so a sweep can find and remove orphans.

### D45. Sandbox limits are on by default
2 concurrent sandboxes, a 60-minute lifetime, and 600 minutes a month, all changeable in Settings. Requests over the concurrent limit wait. Requests over the budget are refused with a reason. A sandbox past its lifetime is destroyed and its task interrupted.

### D46. Claude Code is the second agent
It runs headless with `claude -p --output-format stream-json --verbose`. Read-only maps to plan mode, Supervised and Auto to accept-edits with Claude Code's sandbox on, and Full access to skipping permissions. Spike S4 confirms the details. The Runner's task code moves behind a `Harness` trait shared by Codex and Claude Code.

### D47. Machine labels are set on the machine
`sling-runner config set labels …` adds labels to the Runner's inventory, alongside automatic `os:` and `arch:` labels. Tasks can require labels. The control plane can't change a machine's labels.

### D48. Inside a sandbox container, the container is the agent's only sandbox
Found in spike S4: Codex's and Claude Code's sandboxes both need unprivileged user namespaces, which a default Docker container doesn't allow, so neither starts. `sling-runner sandbox` marks its Runner disposable, and a disposable Runner runs agents without their own sandbox: Codex with `danger-full-access`, and Claude Code skipping permissions in every mode except Read-only, which stays in plan mode. Read-only tasks still never commit or push, and the conversation's mode still gates pushes and PRs.

### D49. Claude Code's network opt-in is an allowlist
Claude Code's sandbox refuses `*` in `allowedDomains`, so a repo with `network = true` gives Claude Code a fixed list of package registries and code hosts, while Codex gets the whole network. In Supervised and Auto, Claude Code runs with `failIfUnavailable`, so on a machine where its sandbox can't start it refuses to run rather than run commands unsandboxed.

### D50. The Docker provider talks to the Engine API directly, and locks containers down
A small client over `node:http` instead of dockerode, which would have brought grpc-js, protobufjs, and ssh2 into the server. Containers run with every capability dropped, `no-new-privileges`, an init process, a PID limit, swap equal to memory, no published ports, and labels Sling's sweep can find. Mounting the Docker socket into the control plane is opt-in through `deploy/docker-compose.sandbox.yml`, because it's root-equivalent on that host.

### D51. Railway runs the same image, through Docker inside the sandbox
The Railway provider creates a Railway Sandbox and runs `sling-sandbox` in it with `docker run`, passing secrets as exec environment variables, never on a command line or in a file. Railway's `Sandbox` type has no name or label field, so `create` writes a marker file inside the sandbox and `list` reads it. A detached keepalive exec stops Railway's idle timeout from ending a task early.

### D52. One Sling server per provider target
The orphan sweep destroys anything carrying Sling's label that isn't a live sandbox in this server's database. Two servers sharing a Docker host or a Railway environment would destroy each other's sandboxes, so each server gets its own.

### D53. A named machine is a preference, unless the environment is `machine`
`machineId` on its own tells the router which machine to try first. If that machine can't take the task, the router falls back the usual way. `environment: "machine"` (or the older `runnerId`) restricts the task to that machine and refuses otherwise.

### D54. The chat picks the assistant's model and the coding agent's
The composer has one picker for both, like T3 Code. The assistant's models come from each provider's model list, with effort levels and the fast tier. The agent's models come from what each machine's Codex or Claude Code reports. Choices are stored per conversation, with workspace defaults for new chats, and each provider keeps its own key. Asked 2026-11-05.

### D55. Repos can be allowed from the web app
The Runner scans for git repos and reports the ones not yet allowed. Sling can ask it to add one or remove one. The Runner adds only paths from its own scan, and `remote-repos off` restores the local-only list. This widens what a compromised control plane can do, from nothing to "allow a repo the machine found". Pairing is one install command that pairs and starts the Runner. Asked 2026-11-05.

### D56. Two-factor changes skip the password right after sign-in
Within 10 minutes of signing in, turning two-factor on or off needs no password. Otherwise the dialog asks for the password or a passkey sign-in. A small Better Auth plugin stores the secret exactly as the two-factor plugin does. Asked 2026-11-05.

### D57. Chat runs on the CLIs, and the assistant picks the coding model
The assistant's turns run on a paired machine's Codex or Claude Code, on its existing login, so chat uses the user's subscription. The Runner runs each turn with only Sling's tools, through `sling-runner mcp` and a per-turn token, and calls only its paired server. API keys become optional, for chatting when no machine is on. The composer has one model picker, for the assistant. The assistant chooses the coding agent, model, and effort for each task, and uses the one the user names. This replaces the two pickers in D54. Asked 2026-11-05.

## Stage 4

### D58. Extensions are signed `.slx` packages, from catalogs, uploads, and the catalog that ships with Sling
An extension is one file: a gzipped tar with a `sling-extension.json` manifest, at most one prebuilt ES module with its dependencies bundled in, workflow templates, a README, and an icon. There are no install scripts and no `node_modules`. Sling gets packages from catalogs (a `sling.catalog/v1` JSON file at any HTTPS URL you add), from a file you upload, and from the catalog included with the server, which lists the example extensions. This rules out installing from npm, building from git on the server, and a hosted marketplace (spec section 16). Asked 2026-11-05.

### D59. Each extension runs in its own Node process with no ambient access, and Sling moves to Node 26 LTS
The process runs under Node's permission model. It may read its own unpacked package and Sling's child runtime, and nothing else. It can't write files, open sockets, resolve names, start processes or workers, or load addons. Its environment is empty and its heap is capped. Its only way out is the IPC channel to the server. Node 24 can't deny network to a process, so the server refuses to start extension code on a Node without `--allow-net`, and the project moves to Node 26 LTS. Measured before deciding: 33 ms to the first answer and 14 µs per round trip. This rules out running third-party code in the server process, a QuickJS isolate, and a container per extension. Asked 2026-11-05.

### D60. Trust is an Ed25519 publisher key, pinned per extension
Publishers sign the package digest with `sling-ext`. You trust a key once, after seeing its fingerprint. An installed extension stays pinned to the key that signed it, so an update signed by any other key is refused. Catalogs pin each version's digest and can revoke versions. Unsigned packages install only when the server runs with `SLING_ALLOW_UNSIGNED_EXTENSIONS=1`, which the web app can't set. Packages from the catalog included with the server are trusted because they ship with it, like the server's own code, and still run isolated. This rules out Sigstore and trust by digest alone. Asked 2026-11-05.

### D61. Updates are manual, and show the permission diff
An **Update** button appears when a catalog has a newer version. The dialog lists permissions added and removed before you approve. Nothing updates on its own. Asked 2026-11-05.

### D62. Extensions reach the network only through Sling, and only the hosts they declare
The child runtime's `fetch` and `WebSocket` ask the server, which allows a request only to a host in the manifest, or to the host in an installation config field the manifest names. The server allows only HTTPS and WSS, except to private addresses with the `localNetwork` permission. It resolves names itself, refuses private addresses without `localNetwork`, connects to the address it checked, and checks every redirect. This rules out raw TCP, UDP, and DNS for extensions, so connectors that need them (IMAP, SMTP, Discord's gateway library) stay built in.

### D63. The manifest declares permissions, and the server checks each one on every call
There are three: network (D62), `approvals` (decide approvals for people an installation allows), and `sandboxes` (provide sandboxes, which means seeing each sandbox's secrets). Everything else an extension can do is fixed and narrow. It reads only installations of its own connectors, emits only its own trigger events, and adds only names that start with its ID. The install dialog lists exactly the declared permissions, and the server stores what you granted. This rules out undeclared capabilities and permission prompts while an extension runs.

### D64. Extensions are installed per server, and installations stay per workspace
The node registry is one per server process, and extension code is server software, like the built-in connectors. Extension, package, publisher, and catalog rows have no workspace. Installations, credentials, workflows, and audit entries still do. Only the workspace owner can install or change extensions. This rules out per-workspace extension sets until there are roles.

### D65. The digest covers file contents, and the server checks it on every load
The digest is a SHA-256 over sorted `path NUL sha256(contents)` lines, leaving out `SIGNATURE.json`. So signing doesn't change it, and repacking the same files gives the same digest. The signed message binds the format, ID, version, and digest. Packages are stored in Postgres, which needs no new volume, and unpacked into a fresh directory each time the server loads them, checking the digest. A package changed in the database is refused. Archives are capped at 20 MB, 50 MB unpacked, and 2,000 regular files with no links or `..`.

### D66. The SDK is `@sling/connector-sdk` 1.0, and the server owns the child runtime
An extension's bundle default-exports `defineExtension({ connectors })`. Every export from the SDK's entry is the stable API, recorded in an API report that fails the tests when it changes. A manifest's `sdk` range must include the server's SDK version. The code that loads the bundle in the child process and speaks the protocol belongs to the server, so the protocol can change without extensions being rebuilt. Node contexts given to extensions have no `services`. The built-in connectors keep running in the server process and import only the SDK.

### D67. A workflow package is an extension with templates and no code
It gets no process and no permissions. `requires` names the extensions and built-in connectors its templates need, and the preview says what's missing. **Export as package** turns a workflow into one: installation IDs become bindings and credentials can't be included. This answers open question 8: the portable format is a `sling.workflow/v1` definition, a template file with bindings, and a package manifest with requirements.

### D68. Extension processes start on demand and stop when idle
What each package adds is stored at install, so the server registers extension nodes at startup without starting any process. A process starts on its first call and stops after 5 minutes idle with no event source running. Every call has a deadline, and a heartbeat every 5 seconds kills a process that stops answering. Five crashes in 10 minutes leave the extension in error until you turn it back on. This rules out a process per extension running all the time.

### D69. Extensions stay on the control plane
No Runner extensions, coding-agent adapters, model providers, or web UI code. The Runner never runs code that came from the control plane, and that doesn't change. Extension forms come from their schemas, as connector forms do today.

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
- Extension signing: Stage 4 (D60). A hosted marketplace: not planned (D58).
