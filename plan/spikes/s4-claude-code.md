# S4. Claude Code

Tested with Claude Code 2.1.318 on macOS arm64, 2026-11-05, logged in with a Claude subscription. The container checks ran in Debian trixie under OrbStack's Docker. Sanitized transcripts of the runs are in `crates/harness-claude-code/tests/transcripts/`.

## Result

```sh
claude -p --output-format stream-json --verbose <mode flags> --settings '<json>'
```

The prompt goes on stdin, and the Runner closes stdin right after writing it. JSONL events arrive on stdout. The working directory is the task worktree.

| Need | How |
|---|---|
| Structured progress | stream-json events, one per line |
| Version | `claude --version` prints `2.1.318 (Claude Code)` |
| Login state | `claude auth status --json`, exit 0 when logged in and 1 when not |
| Cancel | SIGINT to the process group, SIGKILL after 10 s |
| Final summary | `result` on the last event |
| Usage | `usage` on the last event |
| Session | `session_id` on `system/init`, for `--resume` later |

## Event shapes

Trimmed to the fields Sling reads:

```text
{"type":"system","subtype":"init","cwd":"...","session_id":"2aae...","model":"...","permissionMode":"acceptEdits","claude_code_version":"2.1.318","tools":[...]}
{"type":"assistant","message":{"id":"msg_...","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"python3 -c ...","description":"..."}}]}}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"2","is_error":false}]},"tool_use_result":{"stdout":"2","stderr":"",...}}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_2","type":"tool_result","content":"Exit code 1\n(eval):1: operation not permitted: ...","is_error":true}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_3","name":"Write","input":{"file_path":"/abs/hello.txt","content":"hi"}}]}}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_3","type":"tool_result","content":"File created successfully at: ..."}]},"tool_use_result":{"type":"create","filePath":"/abs/hello.txt","originalFile":null,...}}
{"type":"system","subtype":"permission_denied","tool_name":"Write","decision_reason":"Path is outside allowed working directories",...}
{"type":"result","subtype":"success","is_error":false,"result":"...","session_id":"...","num_turns":9,"permission_denials":[...],"usage":{"input_tokens":14,"cache_creation_input_tokens":36160,"cache_read_input_tokens":211678,"output_tokens":1606}}
```

Also seen and ignored: `rate_limit_event`, `system/thinking_tokens`, `system/task_started` and `system/task_notification` for Bash commands, and thinking blocks.

How the parser maps them:

| Claude Code | Sling |
|---|---|
| `assistant` text, top level only | `AgentMessage`. Subagent text has a `parent_tool_use_id` and is left out |
| `tool_use` Bash, then its `tool_result` | `CommandRun` started, then completed or failed. A failed result starts with `Exit code N` |
| `tool_result` for Write, Edit, MultiEdit, NotebookEdit | `FileChange`. Write with `tool_use_result.type` `create` is an add, everything else a modify. Subagent edits count too |
| `tool_use` TodoWrite | `PlanUpdate` |
| WebFetch, WebSearch, Task, `mcp__*` | log lines |
| `system/permission_denied`, `result.permission_denials` | log lines |
| `result` | `Usage`, plus the summary or the failure |

Input tokens are `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, and cached tokens are `cache_read_input_tokens`. That matches Codex, where `input_tokens` already includes cached input.

2.1.318 has no TodoWrite tool, and no MultiEdit either, so Claude Code tasks show no plan in the timeline. The parser still handles both for older versions.

## Failures

The `is_error` flag is what counts. `subtype` can say `success` on a failed run:

```text
{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"result":"Invalid API key · Fix external API key"}
```

That run exited 1. A run that ends without any `result` event, such as a crash, is a failure too.

## Login and API keys

`claude auth status --json` prints `loggedIn`, `authMethod` (`claude.ai`, `api_key`, or `none`), and for a key, `apiKeySource`. It also prints the account's email and organization, which the Runner leaves out of the capability detail. Nothing reads Claude Code's credential files.

With `ANTHROPIC_API_KEY` set and an empty config directory, `auth status` reports `api_key` from `ANTHROPIC_API_KEY`, and `-p` runs need no login or onboarding step. Claude Code reads the key at run time, so unlike Codex there's nothing to log in with first, and the key has to stay in Claude Code's environment. `auth status` doesn't check that the key works; the first real run fails with the 401 above.

## Permission modes

| Sling mode | Flags | `--settings` |
|---|---|---|
| Read-only | `--permission-mode plan` | sandbox on, `autoAllowBashIfSandboxed: false`, no network |
| Supervised, Auto | `--permission-mode acceptEdits` | sandbox on, `autoAllowBashIfSandboxed: true`, `allowUnsandboxedCommands: false`, `failIfUnavailable: true`, `network.strictAllowlist: true`, and `allowedDomains` empty or the registry list below |
| Full access | `--dangerously-skip-permissions` | sandbox off |

The Runner passes `--settings` on every run, so the user's own sandbox settings don't change what a mode means. Claude Code silently ignores a `--settings` value that fails validation in `-p` mode. The live test in the crate checks that it accepts these.

What each one did on macOS:

- **Read-only.** `git log` ran. Claude Code declined `touch` and the Write tool on its own, saying plan mode allows only read-only actions. In `-p` mode nothing can approve a prompt, so anything plan mode doesn't allow is denied anyway.
- **Accept edits with the sandbox.** Write and Edit worked inside the worktree. Sandboxed Bash ran without prompts. `echo x > $HOME/...` failed with "operation not permitted". The Write tool on a path outside the worktree was denied with "Path is outside allowed working directories" and listed in `permission_denials`. `curl https://example.com` failed with a 403 from the sandbox proxy and `deny network-outbound example.com:443`. Reading `~/.gitconfig` worked, so reads aren't limited, same as Codex on macOS.
- **Full access.** Bash wrote to `$HOME` and reached the network.

### Where this differs from the plan

**Network on is a list of hosts, not the whole network.** Claude Code's sandbox only takes `allowedDomains`, and rejects `*` and one-label wildcards like `*.com` "for security reasons". So a repo with `network = true` lets Bash reach package registries and code hosts: GitHub, GitLab, Bitbucket, npm, Yarn, JSR, Deno, PyPI, crates.io and the Rust static host, the Go module proxy, RubyGems, Maven, Gradle, Packagist, NuGet, pub.dev, and Hex. The list is `NETWORK_DOMAINS` in the crate. With `strictAllowlist` the answer is deterministic: "host is not on the allow list". Codex with network on reaches every host, so the two agents differ here.

**Read-only also gets the sandbox, without auto-allow.** Commands plan mode lets through still run sandboxed, with no network.

**`failIfUnavailable` makes Supervised and Auto fail closed.** Without bubblewrap and socat, Claude Code refuses to start: "sandbox required but unavailable: ... bubblewrap (bwrap) not installed, socat not installed". Without that setting it would warn and run commands unsandboxed.

## Sandboxes in containers

Neither agent's own sandbox starts in a default Docker container, because both need unprivileged user namespaces:

- `codex sandbox -- sh -c ...` in the image: "bwrap: No permissions to create a new namespace".
- Claude Code needs bubblewrap and socat on Linux. Installing them wouldn't help for the same reason.

So the plan's mapping can't hold inside a Sling sandbox. `sling-runner sandbox` marks its Runner disposable, and a disposable Runner runs agents without their own sandbox. The container is the boundary, as the boot contract already says for `SLING_MAX_MODE`.

| Sling mode, disposable Runner | Codex | Claude Code |
|---|---|---|
| Read-only | `danger-full-access` | plan mode. It warns that the sandbox is off, and the permission mode still applies |
| Supervised, Auto | `danger-full-access` | `--dangerously-skip-permissions` |
| Full access | `danger-full-access` | `--dangerously-skip-permissions` |

Read-only tasks still never commit or push there, because the Runner refuses both. The repo's `network` flag can't be enforced inside a sandbox: the agent reaches whatever the container's network reaches. Turning the container's network off isn't an option, because the Runner has to dial out to the control plane.

`--dangerously-skip-permissions` works as the image's non-root `sling` user. Claude Code refuses it as root.

## Cancel

SIGINT to the process group stopped a run in 0.6 s. A running `python3 -c "time.sleep(40)"` it had started died with it. Claude Code then **exits 0**, after printing a result with `is_error: true`, `subtype: error_during_execution`, and `terminal_reason: aborted_tools` or `aborted_streaming`. The Runner has to remember that it cancelled, rather than trust the exit code.

## stdin

When stdin isn't a TTY, Claude Code reads it. With a prompt as an argument and stdin left open, it waited 3 s and printed "Warning: no stdin data received in 3s, proceeding without it". The Runner writes the prompt to stdin and closes it, which also keeps the prompt out of `ps`.

## Gotchas

- Like Codex, Claude Code loads the user's settings, `CLAUDE.md`, hooks, plugins, and MCP servers. On a machine that's the point, since the Runner uses the user's own setup. It also means two machines can behave differently for the same task.
- New files only reach the commit when Claude Code reports creating them with Write. A file made with `cat > file` in Bash stays out, like a file Codex makes from a shell command. The prompt asks Claude Code to use its file tools for that reason.
- Claude Code blocks long `sleep` commands and suggests its Monitor tool instead.
- In plan mode, Claude Code may say it couldn't call ExitPlanMode. That's expected in `-p` mode, and the task still succeeds.
- Sessions are saved under `~/.claude/projects`, so a user can resume one by its session ID, which the task log shows.
