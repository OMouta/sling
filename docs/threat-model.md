# Threat model

What Sling protects, what it trusts, and where the known gaps are.

## What's worth stealing

- Shell-level access to your paired machines, through Codex
- Source code in the allowed repos, and the git credentials that push them
- Model API keys and connector credentials (Discord bot token, mailbox password) stored in the control plane
- Your login to the web app, which can start all of the above
- The Discord account of anyone on an installation's approver list, which can approve pushes and PRs

## Trust boundaries

| Component | Trusted for | Not trusted for |
|---|---|---|
| Your browser session | Everything in your workspace | |
| Control plane | Deciding what to run and when | Widening a Runner's limits |
| Runner | Enforcing local limits | |
| Master agent (LLM) | Choosing tools within the limits | Picking the mode, reaching other workspaces, running commands |
| Codex | Editing files in its worktree, within its sandbox | Committing or pushing |
| Workflows | Whatever their nodes do. You write them | |
| Discord users on the allowed list | Chatting with the assistant, as you would | Approving anything, unless also on the approver list |
| Discord users on the approver list | Approving and rejecting pending approvals | Anything else |
| Webhook callers | Starting the one workflow whose URL they hold | |
| Repo content, task output, emails, Discord messages, HTTP responses, logs | Nothing. Treated as data | Instructions of any kind |

## Controls

**Login.** Email and password with optional TOTP and passkeys (Better Auth). Sessions are HttpOnly cookies. State-changing requests with a cookie must come from `SLING_PUBLIC_URL`'s origin, and the browser WebSocket checks the origin too. There's exactly one account: the setup page refuses a second signup.

**Runner identity.** Each Runner makes an Ed25519 key at pairing and keeps the private key on the machine. Pairing codes are single-use, stored hashed, and expire after 10 minutes, and the pairing endpoint is rate-limited. Every connection signs a fresh server nonce with a timestamp. Revoking a Runner closes its socket and refuses later handshakes.

**Local limits.** Repos and the mode cap live only in the Runner's config. See [modes.md](modes.md#what-enforces-what).

**Secrets at rest.** Model API keys and connector credentials are encrypted with AES-256-GCM under a key derived from `SLING_SECRET_KEY`. Connector credentials are write-only in the API, and their values are scrubbed from stored node inputs and outputs. Logs redact cookies and auth headers.

**Secrets in task output.** The Runner masks values of its own secret-looking environment variables and common token shapes (GitHub, OpenAI-style, Slack, AWS key IDs) before events leave the machine. This is best effort.

**Discord.** Messages from users outside an installation's allowed list are dropped before any workflow sees them. Approval buttons are accepted only from user IDs on the approver list, only for pending approvals in the same workspace. Accepted and refused clicks are both audited with the Discord user ID. Clicks arrive over the bot's authenticated gateway connection, so there's no public interactions endpoint.

**Webhooks.** Each `core.webhook` trigger gets a token derived with HMAC from the server secret, and only its hash is stored. A disabled workflow's webhook answers 404.

**Expressions.** JSONata runs no arbitrary code. Each evaluation is capped at 1 second, a recursion depth of 300, and a million items.

**Prompt injection.** Codex summaries, emails, and Discord messages reach models as data inside the user turn. AI nodes (`ai.prompt`, `ai.extract`, `ai.classify`) have no tools at all. The assistant has no shell, file, or web tools on the control plane, so the worst a manipulated assistant can do is start or cancel tasks inside the conversation's mode, on machines and repos you allowed.

**Audit.** Task creation (with mode), mode changes, approvals (with where they were decided), refused approval clicks, push and PR results, pairing, revokes, and installation changes go to an append-only audit table.

## Known gaps

- **Reads aren't sandboxed.** On macOS, Codex's `workspace-write` blocks writes outside the worktree and blocks network, but it can read anything the user can, `~/.ssh` included. With network off it can't send that anywhere. With `--network` on a repo, or in Full access, it could.
- **Linux and Windows sandboxes are untested.** The sandbox probe covered macOS only. Linux uses Landlock and seccomp, and Windows support in Codex has been weaker.
- **The Runner runs as you.** There's no separate OS user. Docker-per-task isolation is planned for a later stage.
- **Discord approvers hold an approval key.** Anyone who takes over an approver's Discord account can approve pushes and PRs. Keep the approver list short, and turn on 2FA in Discord.
- **`http.request` can reach your internal network.** It doesn't block private or loopback addresses, so a workflow that builds a URL from email or Discord content could be steered at internal services. Don't build URLs from untrusted text.
- **Webhook URLs are bearer secrets.** Anyone holding one can start that workflow with any body. Rotating a URL means changing the trigger node's ID.
- **Node runs keep content.** Email bodies, Discord messages, and model replies are stored in node-run inputs and outputs for 30 days, truncated at 64 KB each.
- **Lost Discord messages.** If the server can't take a Discord message when it arrives, it's logged and dropped. Discord doesn't replay it.
- **Redaction is pattern-based.** A secret that doesn't look like one gets through.
- **One account.** No roles yet, though every record carries a workspace and owner.
- **Unsigned binaries.** macOS notarization and Windows code signing aren't set up yet.
