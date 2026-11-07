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
The process runs under Node's permission model. It may read its own unpacked package and Sling's child runtime, and nothing else. It can't write files, open sockets, resolve names, start processes or workers, or load addons. Its environment is empty and its heap is capped. Its only way out is its stdin and stdout, which carry framed messages to and from the server. Node 24 can't deny network to a process, so the server refuses to start extension code on a Node without `--allow-net`, and the project moves to Node 26 LTS. Measured before deciding: 33 ms to the first answer and 14 µs per round trip. This rules out running third-party code in the server process, a QuickJS isolate, and a container per extension. Asked 2026-11-05.

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

## Assistant

### D70. Personalities: a prompt, a set of tools, and a look, fixed for each chat
A personality is a named assistant in the workspace. It has its own instructions, the Sling tools it may use (commands, coding tasks, both, or none), a color, and an animated glyph. It's the "named assistants or profiles" of spec section 4.1 and the "Agent Profile" in section 14's data model.
- A chat picks its personality when it starts and keeps it. Codex and Claude Code both keep the system prompt a session started with, and a task reports back into the chat that started it, so a switch mid-chat would leave either the prompt or the tools wrong. This rules out switching personality inside a chat.
- The server enforces the tool list, for turns on an API key and for the CLI's MCP calls alike. A personality can only take tools away. The conversation's mode still sets the sandbox and the approvals.
- Sling keeps a fixed part of every prompt: that the chat renders Markdown, that it can't browse, the rules for each tool it has, the mode, and the date. The personality's instructions replace everything else.
- Claude Code chat turns use `--system-prompt-file`, which replaces Claude Code's own coding-agent prompt instead of adding to it. Codex keeps its base prompt and gets Sling's as developer instructions. Its `model_instructions_file` could replace the base prompt, but that's unverified.
- Personalities have their own page, not a section of Settings. The new chat screen picks one from a single row at the top, which scrolls sideways when there are many, with a swipe on touch screens and the arrow keys while the composer is empty. A side rail plus a menu was tried first and dropped: two controls for one choice. A workspace starts with Sling only (every tool, the default). Ten more are templates under **From template** on the Personalities page: Ops, Incident, Research, Planner, Writer, Tutor, Finance, Travel, Chef, and Language coach. A template added twice gives back the one already there. Conversations from before personalities, and conversations a workflow creates, get the default.
- An edit bumps the personality's revision, and each reply records the personality and revision that wrote it. Deleting a personality archives it, so its chats keep working.
- Not built yet: pinning a personality in an `agent.assistant` node, which would make **Export as package** turn its ID into a binding like an installation's, and connector actions as assistant tools. Those need an approval before outgoing messages, idempotency keys for side effects, and a manifest flag for nodes the assistant may call, shown in the install dialog. This rules out a separate workflow per personality, since every enabled workflow with a chat trigger answers every chat message. Asked 2026-11-06.

## Self-hosting

### D71. One address, picked by `deploy/setup.sh`, with Tailscale and Cloudflare Tunnel built into Compose
Sling keeps a single `SLING_PUBLIC_URL`. Sign-in, cookies, passkeys, the origin checks, and the tools URL a Runner accepts all depend on it, and a second address would mean a second set of each. The setup script asks how Sling should be reached and writes `deploy/.env` for it:
- **This computer:** `http://localhost:8080`, published on loopback only.
- **Local network:** `http://<LAN address>:8080`, published on every interface. Plain HTTP, so the password crosses the LAN unencrypted and passkeys don't work, since browsers allow them only over HTTPS.
- **Tailscale:** a `tailscale` container serves `https://<name>.<tailnet>.ts.net` to the tailnet. Phones and Runners join the tailnet, and the address works at home and away.
- **Cloudflare Tunnel:** a `cloudflared` container connects a public hostname you set up in Cloudflare. Nothing to install on the phone, and anyone can reach the sign-in page.

With a tunnel, Sling is published on loopback only, so the tunnel is the way in. The tunnel's secrets go in `deploy/tunnel.env`, which only the tunnel container reads, never the Sling container. This builds on D9: still no relay of Sling's own, but the two tunnels it documented now come as Compose profiles. The self-hosting Compose project is named `sling`, so it never collides with the development Postgres in project `deploy`. When the address changes, `sling-runner config set server-url` points a paired machine at the new one without pairing again. This rules out serving a LAN address and a tunnel address at once. Asked 2026-11-06.

## Stage 5

### D72. Deploys are delivery steps after the PR, gated by the mode
`deliver` gains `deploy`: push, then PR, then merge, then deploy, then verify, each a row in `actions`. A target whose host deploys on merge skips the deploy step. The mode decides what asks, as for push and PR: Supervised asks before every step, Auto before merge and deploy, Full access never, and Read-only can't deliver a deploy. Merge and deploy wait as `queued` and get their approvals only once the steps reach merge, so "Approve deployment?" always comes after the PR exists and links to it. Only the merged commit on the default branch deploys. This rules out deploying a task branch, deploying without a merge, and one approval that covers both the PR and the deploy in Supervised.

### D73. One deploy target per repo, with three methods, and the command stays on the machine
A target lives in the control plane, keyed by the repo's normalized remote. The host deploys on merge, or a machine runs a command, or Sling calls a deploy hook. The command is set only in the Runner's config (`sling-runner repo set <name> deploy-command`), so the control plane picks the machine but never what runs. Hook URLs and headers are stored encrypted and are write-only. Health checks and the version URL are set by you, never by the model. That's why they may reach private addresses, and why the assistant names a target instead of a URL. This rules out deploy commands sent from the control plane, deploys as Sling workflows, and more than one target per repo. Asked 2026-11-06.

### D74. A machine merges with `gh` or plain git, and refuses what isn't a Sling change
With a GitHub PR and `gh` logged in, the Runner runs `gh pr merge` after checking the PR's head and base. Otherwise it merges in a temporary worktree and pushes the default branch, never forced, with a `Sling-Task` trailer so a repeat finds the earlier merge. A sandbox's PR is merged by the control plane through GitHub's API, with the workspace's GitHub token, since sandboxes are gone by then. The Runner refuses with `deploys off` or a Read-only `max-mode`. It also refuses to merge a branch that isn't a Sling task branch, and to deploy a commit that isn't on the remote's default branch. Merges and deploys go through a `RepoAction` message that isn't tied to the task's spool, so another machine with the repo can merge when the one that ran the task is offline. This builds on D14, which already let a merge approval push the default branch. It rules out force pushes, and merging or deploying anything else.

### D75. Verify until the site passes, and go back with a revert task
After the deploy, a pg-boss job checks every 10 seconds until every check passes and the version URL, if set, shows the merged commit, for up to 10 minutes by default. Without a version URL, the result says Sling can't tell which version answered. A failed verify fails the task's delivery and tells the conversation, and the assistant offers a revert task delivered with `deploy`, which asks like any other. A server that restarts during a hook call marks it "interrupted, outcome unknown" and doesn't call it again. This rules out automatic rollback, and a task that counts as fixed before the site says so.

### D76. Watching a site is a workflow, and an alert opens a chat you send
`deploys.check` checks targets and outputs the ones whose state changed: down after two failures in a row, up after one pass. The **Site down alert** template runs it every minute and sends a push notification. Tapping it opens a new chat with the Incident personality and a draft saying what failed. Sling never starts an investigation or a fix on its own. This rules out a monitor built into deploy targets apart from workflows.

### D77. Calendar: CalDAV and iCal links, built in
A built-in connector reads and writes CalDAV calendars (iCloud, Fastmail, Nextcloud, and others) with an app password. It reads Google and Outlook through their private iCal address, which is stored as a credential. It runs in the server process like email, because it's first party and in-process calls are faster. It uses ical.js for events and recurrences and fast-xml-parser for CalDAV, with no CalDAV client library. Creating an event takes its UID from the idempotency key, so a repeat doesn't duplicate it. This rules out Google's OAuth API and a Google Cloud project. Asked 2026-11-06.

### D78. Flagged nodes become the assistant's tools, and sends ask in every mode but Full access
A node opts in with `assistant: { sends, summary }` in its spec, which is SDK 1.1.0 and an addition. Each flagged node with an installation becomes a tool named after its type. The workflows with a manual trigger are reachable through `run_workflow`, which counts as sending when any node in the workflow isn't idempotent. Reads never ask. Sends are refused in Read-only, ask inline in Supervised and Auto, and run in Full access. The approval works like command approvals: in memory, for one conversation, 5 minutes, showing the summary. Values from the model are passed literally and never evaluated as expressions. Extension nodes carry the flag through what the extension adds, and the install dialog lists them. This finishes the connector actions D70 left for later. It rules out a generic "run any node" tool and automatic sends outside Full access. Asked 2026-11-06.

### D79. The phone app is the installed web app, with Web Push
Sling ships a manifest and a service worker. The service worker caches built assets and the shell, and never the API. Push uses Web Push, with a VAPID key derived from `SLING_SECRET_KEY` and payloads encrypted in-house per RFC 8291 and 8292 with `node:crypto`, so there's no `web-push` dependency. Subscriptions are accepted only for the known push services. Notifications open the right screen and have no buttons, so nothing gets approved from a lock screen. Replies aren't pushed while a visible window shows that chat. Push needs HTTPS, which the Tailscale and Cloudflare setups give, or localhost. This rules out a native app, a push relay of Sling's own, and approving from a notification. Asked 2026-11-06 ("mobile support via web app").

### D80. The workspace has a time zone
`workspaces.time_zone` is set from the browser the first time the web app finds it empty, and can be changed in Settings. "Today" in the calendar, schedules with no zone, and the assistant's date line use it. Until it's set, UTC applies.

### D81. Two more personality tool groups: apps and deploys
`apps` covers the flagged connector actions and `run_workflow`. `deploys` covers `check_deploy_target`, `deploy_task`, and `deliver: "deploy"`. The server enforces both, as it does the others. The default personality gains both when it has every older group. The Incident template gets `deploys`, and Planner gets `apps`. No other personality gains a group it didn't have, since a personality's tools only ever narrow.

## Stage 6

### D82. Memory: facts the assistant saves on its own, with Undo, on a Memory page
The assistant saves a lasting fact about you with `remember` and the chat shows "Remembered: …" with **Undo**. Every memory is on **Memory**, with the chat it came from, and can be edited or deleted. A memory is for every personality unless pinned to one. The prompt holds the most recently used memories that fit 6 KB, and `recall` searches the rest with Postgres full-text search. The server refuses text that looks like a secret, whatever the model asks. This rules out embeddings, a vector database, and memories stored anywhere but the workspace's Postgres. Asked 2026-11-07 ("saves on its own, tells you").

### D83. Shared folders are chosen on the machine and searched there
`sling-runner folder add` shares a folder, and the inventory reports its name only. Search and reads run on the machine with ripgrep's crates, text files only, and the Runner refuses any path that leaves the folder, including through a symlink. Nothing is uploaded or indexed in the control plane. This follows D17: the machine, not the control plane, decides what Sling may use. It rules out a central index and reading PDFs or Office files for now.

### D84. The assistant writes workflow graphs, and you apply them on a card
`create_workflow` takes a full `sling.workflow/v1` definition, which the server validates before the card shows. The card lists the steps in plain words and marks the ones that send. `change_workflow` can replace a graph. `workflow_nodes` serves the catalog, so it stays out of the fixed prompt. `core.schedule` gains a one-time `at`. This rules out workflows the assistant applies without a card outside Full access, and a separate reminders feature.

### D85. Rules: standing answers that skip a question or start work, never for merges or deploys
An allow rule matches an action, an optional installation, and pinned argument values that the node lists in `ruleFields`. It applies in Supervised and Auto, never in Read-only. A start rule opens a chat and runs a turn when a check changes, in at most Auto, at most once per rule and check every 30 minutes. Merges, deploys, commands outside the sandbox, setup changes, and saving a rule never match. A rule made from chat always shows a card, Full access included, because it outlives the chat. Five approvals in a row with no denial earn a suggestion on the card. This supersedes D76's "nothing starts on its own" for start rules. Asked 2026-11-07 ("rules can start work").

### D86. Checks replace Deploys, and every action that changes something outside Sling checks itself
A check is something Sling watches on a schedule: a site (with an optional deploy), a command in the read-only sandbox on a machine, or an email reply due by a deadline. A deploy target becomes a site check that also deploys, and the migration moves each target over. The scheduler runs due checks itself, and workflows react through `checks.changed`, which replaces polling with `deploys.check`. Actions check themselves through `verify` on their node: read the event back, fetch the message, watch for a bounce, wait for the PR's CI. A node without `verify` claims no check. This supersedes D76's "watching is a workflow" and finishes the PR CI checks deferred after Stage 5. Asked 2026-11-07 ("Checks replaces Deploys").

### D87. Email search and reading from chat, over IMAP
`email.search` and `email.read` are flagged for the assistant and never ask. They also back `reply` checks and the bounce check. This finishes "reading email from chat", left out of Stage 5.

### D88. Google Calendar through your own OAuth client
The calendar connector gains a `google` kind, with an OAuth client you create and paste in, PKCE, and an encrypted refresh token. The OAuth routes and token store are a server module the next OAuth connector reuses. This supersedes D77's "no Google OAuth", and rules out a Sling-owned OAuth client.

### D89. Telegram is built in, with long polling
A bot token, your chat picked after you message the bot, and long polling, so no public address is needed. Only allowed chats are answered. The **Telegram assistant** template works like **Discord assistant**. Asked 2026-11-07.

### D90. Signal and iMessage run on a paired machine that allows the senders
Neither has an API Sling can call, so the Runner does it: iMessage by reading `chat.db` and sending with `osascript` on a Mac, Signal through `signal-cli` as a linked device. Channels and their allowed senders are set only on the machine, which forwards nothing until a sender is allowed. Cursors on disk mean a message that arrived while the Runner was down is forwarded once. Asked 2026-11-07. This rules out WhatsApp for now.

### D91. Voice is the browser's speech recognition in the composer
A mic button, hold to talk or tap twice, fills the composer and never sends on its own. It shows only where the browser has speech recognition. This rules out transcription on Sling's server or your machines for now, and reading replies aloud.

### D92. Some approvals can be answered from the notification
Sends and push-and-PR steps get **Allow** and **Deny** on their push, answered by the service worker with a single-use token bound to the approval, the user, and its expiry. Merges, deploys, commands, setup changes, and rules still open Sling. This supersedes D79's "no buttons" for those approvals only.

### D93. Two more personality tool groups: memory and files
`memory` covers `remember`, `forget`, and `recall`, and every personality gets it, since it reads and writes only Sling's own data. `files` covers `search_files` and `read_file`, and only the default personality gets it. The setup group gains `create_workflow`, `workflow_nodes`, `save_rule`, and `save_check`, and `check_deploy_target` becomes `run_check`.

## Stage 7

### D94. Web search is the model's own, and replies cite numbered sources
A new personality tool group, `web`, turns on the search the model already has: Claude Code's `WebSearch` and `WebFetch`, Codex's `web_search`, and the Anthropic and OpenAI API's web search tools. CLI turns stay on the user's subscription, and Sling stores no search API key. OpenAI-compatible models get no search, and the prompt says so. The reply cites a claim with a Markdown link whose text is its number, `[1](https://…)`, and ends with the sources it cited. Searches show as steps in the reply's trace. This supersedes the fixed prompt's "you can't browse" for personalities with `web`, and rules out a search provider run or paid for by Sling. Asked 2026-11-07.

### D95. Sources are files and links on a personality, searched in Postgres
A personality's editor takes PDFs, Word files, text, Markdown, and links. The server extracts the text once, by page for a PDF, stores the file and the text in the workspace's Postgres, and searches chunks with full-text search. A personality with sources gets `search_sources` and `read_source`, and its prompt lists them by name. A citation links to the file at its page. Only that personality uses them. This keeps D82's "no embeddings", and rules out OCR, a shared library, and syncing a link after it's added. Asked 2026-11-07 ("on each personality").

### D96. Files in chat: documents become the chat's sources, and images go to the model
The composer takes files by paperclip, drag, or paste. A document is extracted like a source but belongs to the chat: short ones go to the model whole, and longer ones through `search_sources` and `read_source`. An image is shrunk in the browser and sent to the model as an image, through the API, Claude Code's stream-json input, or Codex's `--image`. This supersedes D83's "no PDFs or Office files" for files you upload, not for shared folders.

### D97. Deep research is a switch on one message
For a personality with `web` on a model that searches, the composer's **+** menu has **Deep research**. That turn gets the research instructions, up to 60 model steps on an API and 30 minutes on a CLI, and writes a report with its sources. It asks up to three questions first when the request is too broad. This rules out a separate research agent or queue.

### D98. A personality has a model, which a chat starts with and can change
The personality editor uses the chat's own model picker. Picking a personality on the new chat screen sets the picker to its model, and the chat can change it, as now. A chat with no choice of its own, such as one a workflow starts, uses the personality's model, then the workspace default. Asked 2026-11-07 ("no lock").

### D99. An @mention hands one turn to another personality
Typing `@` in the composer lists the personalities. A message that mentions one is answered by it, with its instructions, tools, and model, under its glyph. The chat keeps its own personality for the next message. A CLI session isn't resumed across personalities. Asked 2026-11-07.

### D100. Personalities export and import as one file
**Export** saves a `sling.personality/v1` JSON file with the fields, the model, and the sources' files. **New personality → From a file** adds one. Memories, feedback, and chats stay behind.

### D101. Retry and edit replace the last exchange, when it did nothing outside the chat
Retry runs the last reply again, and editing your last message runs it from there. Both delete the messages they replace and start a new CLI session. Neither is offered when what they'd replace started a task, sent something, changed setup, or ran a command outside the sandbox, because running it again would do it twice. This rules out keeping replaced replies as versions.

### D102. Follow-up suggestions come from the reply itself
The reply ends with up to three follow-ups in a `<follow-ups>` block, which the server removes and stores on the trace. The latest reply shows them as buttons that send. No second model call. Channels such as Telegram never see the block.

### D103. Read aloud is the browser's speech synthesis
A speaker button on a reply reads it, without code blocks, in the browser's voice. It shows only where the browser has `speechSynthesis`. This supersedes D91's "no reading replies aloud".

### D104. Feedback on replies suggests changes to the instructions
Thumbs up or down on a reply, with an optional reason on down, is stored against the personality's revision. The personality's page shows the counts for its current revision and the recent downvotes, and **Suggest changes** asks the personality's model for new instructions from them. You see the change before **Apply**, which bumps the revision.

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
- Stage 5:
  - The new page is **Deploys**, in the sidebar after Sandboxes. Each target goes by the name you give it, and the docs call it a deploy target.
  - Targets merge with squash by default.
  - Verify checks every 10 seconds, for up to 10 minutes, waiting 60 seconds first when the host deploys on merge.
  - A hook call times out after 30 seconds, and a deploy command after 15 minutes.
  - Up to 5 health checks per target, each a GET with a 10-second timeout, passing on 200 to 399 unless a status is set.
  - Command deploys get `SLING_DEPLOY_COMMIT` and `SLING_DEPLOY_REPO`, and run through the user's login shell.
  - Push categories are approvals, tasks, and replies, all on, per user. `app.notify` always delivers.
  - Push TTLs: 24 hours for approvals, 1 hour for tasks, 10 minutes for replies.
  - A push subscription is dropped after 10 failures in a row, or at once on 404 or 410.
  - The assistant gets at most 30 connector-action tools per turn, and `run_workflow` waits up to 60 seconds.
  - iCal feeds are cached for 5 minutes by ETag, and capped at 5 MB and 2,000 events per query.
  - The Morning briefing runs at 07:30 in the workspace's time zone and starts a new chat each day.
- Stage 6:
  - **Memory** sits in the sidebar after Personalities, and **Checks** takes Deploys' place.
  - The memory block in the prompt is at most 6 KB, and a memory at most 500 characters.
  - Site checks run every minute and command checks every 5 minutes. Reply checks look every 5 minutes until their deadline.
  - An email send watches for a bounce for 10 minutes, and a PR's CI is awaited for up to 30 minutes.
  - Five approvals in a row with no denial in 30 days earn a rule suggestion.
  - A start rule opens at most one chat per check every 30 minutes.
  - iMessage polls `chat.db` every 2 seconds. A send to an offline machine waits up to 5 minutes.
- Stage 7:
  - A source or attachment is at most 25 MB and 2 million characters of text. A personality has at most 50 sources, and a message at most 10 files.
  - Chunks are about 1,500 characters, split on paragraphs inside a page. `search_sources` returns at most 8, and `read_source` at most 30,000 characters.
  - A document in chat under 20,000 characters goes to the model whole.
  - Images are shrunk to 2,048 pixels on the long side, at most 4 per message and 3 MB in all.
  - The templates that get `web`: Sling, Ops, Incident, Research, Planner, Travel, and Finance. The migration gives it to personalities made from those.
  - **Suggest changes** reads the latest 20 downvotes on the current revision.

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
- Connector actions as assistant tools: Stage 5 (D78). Pinning a personality in an `agent.assistant` node: still later.
- PR CI checks before a deploy approval, GitHub deployment statuses, and automatic rollback: after Stage 5.
