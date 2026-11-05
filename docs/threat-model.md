# Threat model (Stage 1)

What Sling protects, what it trusts, and where the known gaps are.

## What's worth stealing

- Shell-level access to your paired machines, through Codex
- Source code in the allowed repos, and the git credentials that push them
- Model API keys stored in the control plane
- Your login to the web app, which can start all of the above

## Trust boundaries

| Component | Trusted for | Not trusted for |
|---|---|---|
| Your browser session | Everything in your workspace | |
| Control plane | Deciding what to run and when | Widening a Runner's limits |
| Runner | Enforcing local limits | |
| Master agent (LLM) | Choosing tools within the limits | Picking the mode, reaching other workspaces, running commands |
| Codex | Editing files in its worktree, within its sandbox | Committing or pushing |
| Repo content, task output, emails, logs | Nothing. Treated as data. | Instructions of any kind |

## Controls

**Login.** Email and password with optional TOTP and passkeys (Better Auth). Sessions are HttpOnly cookies. State-changing requests with a cookie must come from `SLING_PUBLIC_URL`'s origin, and the browser WebSocket checks the origin too. Stage 1 allows exactly one account: the setup page refuses a second signup.

**Runner identity.** Each Runner makes an Ed25519 key at pairing and keeps the private key on the machine. Pairing codes are single-use, stored hashed, and expire after 10 minutes, and the pairing endpoint is rate-limited. Every connection signs a fresh server nonce with a timestamp. Revoking a Runner closes its socket and refuses later handshakes.

**Local limits.** Repos and the mode cap live only in the Runner's config. See [modes.md](modes.md#what-enforces-what).

**Secrets at rest.** Model API keys are encrypted with AES-256-GCM under a key derived from `SLING_SECRET_KEY`. Logs redact cookies and auth headers.

**Secrets in task output.** The Runner masks values of its own secret-looking environment variables and common token shapes (GitHub, OpenAI-style, Slack, AWS key IDs) before events leave the machine. This is best effort.

**Prompt injection.** Codex summaries reach the agent marked as data. The agent has no shell, file, or web tools on the control plane, so the worst a manipulated agent can do is start or cancel tasks inside the conversation's mode, on machines and repos you allowed.

**Audit.** Task creation (with mode), mode changes, approvals, push and PR results, pairing, and revokes go to an append-only audit table.

## Known gaps

- **Reads aren't sandboxed.** On macOS, Codex's `workspace-write` blocks writes outside the worktree and blocks network, but it can read anything the user can, `~/.ssh` included. With network off it can't send that anywhere. With `--network` on a repo, or in Full access, it could.
- **Linux and Windows sandboxes are untested.** Spike S2 covered macOS only. Linux uses Landlock and seccomp, and Windows support in Codex has been weaker.
- **The Runner runs as you.** There's no separate OS user. Docker-per-task isolation is planned for Stage 3.
- **Approvals only show in the web app.** There are no push notifications yet, so a Supervised task waits until you look.
- **Redaction is pattern-based.** A secret that doesn't look like one gets through.
- **One account.** No roles yet, though every record carries a workspace and owner.
- **Unsigned binaries.** macOS notarization and Windows code signing aren't set up yet.
