# Threat model

What Sling protects, what it trusts, and where the known gaps are.

## What's worth stealing

- Shell-level access to your paired machines, through Codex
- Source code in the allowed repos, and the git credentials that push them
- Model API keys and connector credentials (Discord bot token, mailbox password) stored in the control plane
- Sandbox secrets (OpenAI and Anthropic keys, a GitHub token) and execution provider credentials (access to a Docker host, a Railway token)
- Your login to the web app, which can start all of the above
- The Discord account of anyone on an installation's approver list, which can approve pushes and PRs

## Trust boundaries

| Component | Trusted for | Not trusted for |
|---|---|---|
| Your browser session | Everything in your workspace | |
| Control plane | Deciding what to run and when | Widening a Runner's limits |
| Runner | Enforcing local limits | |
| Master agent (LLM) | Choosing tools within the limits | Picking the mode, reaching other workspaces, running commands |
| Chat turns on a Runner | Running one assistant turn on the machine's own Codex or Claude Code login | Calling tools outside that turn's conversation, or reaching any server but the paired one |
| Codex, Claude Code | Editing files in its worktree. On your machines, inside the agent's own sandbox. In a sandbox container, inside the container | Committing or pushing |
| Sandbox | Running one task on a fresh clone of one allowed repo, with that task's secrets | Reaching your machines, other repos, or other tasks' secrets |
| Execution provider (Docker, Railway) | Starting and removing sandboxes | Seeing anything but the sandbox it was asked to start |
| Workflows | Whatever their nodes do. You write them | |
| Discord users on the allowed list | Chatting with the assistant, as you would | Approving anything, unless also on the approver list |
| Discord users on the approver list | Approving and rejecting pending approvals | Anything else |
| Webhook callers | Starting the one workflow whose URL they hold | |
| Repo content, task output, emails, Discord messages, HTTP responses, logs | Nothing. Treated as data | Instructions of any kind |

## Controls

**Login.** Email and password with optional TOTP and passkeys (Better Auth). Sessions are HttpOnly cookies. State-changing requests with a cookie must come from `SLING_PUBLIC_URL`'s origin, and the browser WebSocket checks the origin too. There's exactly one account: the setup page refuses a second signup.

**Runner identity.** Each Runner makes an Ed25519 key at pairing and keeps the private key on the machine. Pairing codes are single-use, stored hashed, and expire after 10 minutes, and the pairing endpoint is rate-limited on failed attempts. Every connection signs a fresh server nonce with a timestamp. Revoking a Runner closes its socket and refuses later handshakes.

**Sandboxes.** Only repos on the workspace's sandbox list go to a sandbox, and a sandbox clones only from that entry's HTTPS URL. Clone URLs with credentials in them are refused. Each sandbox gets its own pairing code, stored hashed, valid for 15 minutes and only while that sandbox is starting, and its Runner is marked as that sandbox's. When the task is delivered, or the sandbox fails, times out, or passes its lifetime, Sling revokes its Runner and has the provider destroy it. Every minute, Sling also destroys anything the provider still runs with Sling's label that isn't a live sandbox. A sandbox gets the GitHub token and only the API key for the agent its task runs. The Runner uses the token itself and strips it, and every `SLING_` variable, from the agent's environment. Running a task in a sandbox because no machine could take it always waits for your approval.

**Local limits.** The mode cap and labels live only in the Runner's config. Repos live there too. Sling can ask a Runner to add a repo, but the Runner only adds a git repo it found on the machine itself, checks that the path still resolves to the same place, and refuses while `remote-repos` is off. Every repo change is audited. See [modes.md](modes.md#what-enforces-what).

**Secrets at rest.** Model API keys, connector credentials, and sandbox secrets are encrypted with AES-256-GCM under a key derived from `SLING_SECRET_KEY`. Connector credentials and sandbox secrets are write-only in the API. Connector credential values are scrubbed from stored node inputs and outputs, and from sandbox provider errors. Audit entries name which sandbox variables a sandbox got, never their values. Logs redact cookies and auth headers.

**Sign-in security.** Turning two-factor on or off needs the password, or a sign-in in the last 10 minutes. A passkey sign-in counts, so the dialog offers one in place of the password.

**Secrets in task output.** The Runner masks values of its own secret-looking environment variables and common token shapes (GitHub, OpenAI-style, Slack, AWS key IDs) before events leave the machine. This is best effort.

**Discord.** Messages from users outside an installation's allowed list are dropped before any workflow sees them. Approval buttons are accepted only from user IDs on the approver list, only for pending approvals in the same workspace. Accepted and refused clicks are both audited with the Discord user ID. Clicks arrive over the bot's authenticated gateway connection, so there's no public interactions endpoint.

**Webhooks.** Each `core.webhook` trigger gets a token derived with HMAC from the server secret, and only its hash is stored. A disabled workflow's webhook answers 404.

**Expressions.** JSONata runs no arbitrary code. Each evaluation is capped at 1 second, a recursion depth of 300, and a million items.

**Chat on your machines.** When the assistant runs on a machine's Codex or Claude Code, the Runner runs the CLI in an empty directory outside every repo, with Sling's tools as its only MCP server. Each turn gets a random token that lets its tool calls act for that conversation only. The token expires when the turn ends, plus 30 seconds for calls already in flight, and lives only in the server's memory. The Runner sends tool calls only to the server it paired with, and refuses a turn whose tools URL points anywhere else. See [runner.md](runner.md#what-the-assistant-can-reach).

**Prompt injection.** Codex summaries, emails, and Discord messages reach models as data inside the user turn. AI nodes (`ai.prompt`, `ai.extract`, `ai.classify`) have no tools at all. The assistant has no shell, file, or web tools of its own, so the worst a manipulated assistant can do is start or cancel tasks inside the conversation's mode, on machines and repos you allowed. Codex chat turns are the exception below.

**Audit.** Task creation (with mode and routing), mode changes, approvals (with where they were decided), refused approval clicks, push and PR results, pairing, revokes, installation changes, every sandbox state change, orphans removed, sandbox list changes, and which sandbox secrets were set or cleared go to an append-only audit table.

## Known gaps

- **Reads aren't sandboxed.** On macOS, Codex's `workspace-write` blocks writes outside the worktree and blocks network, but it can read anything the user can, `~/.ssh` included. With network off it can't send that anywhere. With `--network` on a repo, or in Full access, it could.
- **Linux and Windows sandboxes are untested.** The sandbox probe covered macOS only. Linux uses Landlock and seccomp, and Windows support in Codex has been weaker.
- **Sling can switch on repos a machine found.** With `remote-repos` on (the default), whoever controls the control plane can allow any git repo the Runner found under its scan roots, though not other paths. Turn it off on machines where that matters, or narrow `scan-roots`.
- **A recent sign-in is enough to change two-factor.** For 10 minutes after signing in, a session can turn two-factor on or off without the password. Someone who steals a fresh session cookie can do that, along with everything else a session can do.
- **Codex chat turns can read files.** Codex's read-only sandbox blocks writes, not reads. The Runner turns off every Codex tool it knows of, but a later Codex could add one it doesn't, and a manipulated assistant could use it to read files on that machine and put them in its reply. Claude Code chat turns start with no built-in tools, so they don't have this gap.
- **The Runner runs as you.** There's no separate OS user on your machines. Sandboxes give a task its own container, but only for repos you allow there.
- **Inside a sandbox container, the agent has no sandbox of its own.** Codex's and Claude Code's sandboxes need unprivileged user namespaces, which a normal Docker container doesn't allow. So in a sandbox, agents run with their own checks off in every mode except Read-only (Codex with `danger-full-access`, Claude Code skipping permissions), and the container is the only boundary. Read-only tasks still never commit or push, and Supervised and Auto still gate pushes and PRs.
- **Sandbox secrets share the container with the agent.** The agent's environment doesn't carry the GitHub token, and Codex's API key is removed once Codex has logged in with it. But the agent runs as the same user as the Runner in that container, so it could read the token from the Runner's process. Scope the GitHub token to the repos you allow, with contents and pull requests only.
- **A repo's network setting isn't enforced in sandboxes.** The agent can reach whatever the container's network reaches. Use the Docker provider's `network` setting, or a host firewall, to limit that. On your machines, the setting does apply: Codex gets the network, and Claude Code gets a list of package registries and code hosts.
- **The Docker socket is root on its host.** Mounting it into the control plane, as `deploy/docker-compose.sandbox.yml` does, means anyone who takes over the control plane controls that host. A separate Docker host over TLS keeps that away from the machine running Sling.
- **Railway Sandboxes are in beta.** Railway's API can change between releases, and the Railway provider hasn't been run against a live account yet.
- **A sandbox's limits come from the control plane.** Its repo list and mode cap are set when Sling starts it, unlike a machine's local config. A compromised control plane can run anything in a sandbox, though not on your machines.
- **Providers shared between Sling servers.** Each server's orphan sweep removes sandboxes it doesn't know, including another server's. Give each server its own Docker host or Railway environment.
- **Discord approvers hold an approval key.** Anyone who takes over an approver's Discord account can approve pushes and PRs. Keep the approver list short, and turn on 2FA in Discord.
- **`http.request` can reach your internal network.** It doesn't block private or loopback addresses, so a workflow that builds a URL from email or Discord content could be steered at internal services. Don't build URLs from untrusted text.
- **Webhook URLs are bearer secrets.** Anyone holding one can start that workflow with any body. Rotating a URL means changing the trigger node's ID.
- **Node runs keep content.** Email bodies, Discord messages, and model replies are stored in node-run inputs and outputs for 30 days, truncated at 64 KB each.
- **Lost Discord messages.** If the server can't take a Discord message when it arrives, it's logged and dropped. Discord doesn't replay it.
- **Redaction is pattern-based.** A secret that doesn't look like one gets through.
- **One account.** No roles yet, though every record carries a workspace and owner.
- **Unsigned binaries.** macOS notarization and Windows code signing aren't set up yet.
