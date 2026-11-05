# S1. Codex interface

Tested with codex-cli 0.166.0 on macOS arm64, 2026-11-05.

## Result

Use `codex exec --json`. `codex app-server` is still marked `[experimental]` in `codex --help`, and the Runner shouldn't depend on a protocol Codex says can change under it. The TypeScript SDK is out because the Runner is Rust.

## What `exec --json` gives us

One JSON object per line on stdout:

```text
{"type":"thread.started","thread_id":"01a1abed-..."}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"...","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","aggregated_output":"...","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{"input_tokens":34293,"cached_input_tokens":28416,"output_tokens":131,"reasoning_output_tokens":0}}
```

Item types seen or documented: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`. Failures arrive as `turn.failed` or `error`.

Needs from the Runner, and how each is met:

| Need | How |
|---|---|
| Structured progress | `item.*` events |
| Cancel mid-turn | SIGINT to the process group, SIGKILL after 10 s |
| Sandbox per run | `-s read-only \| workspace-write \| danger-full-access` |
| Working dir | `-C <worktree>` |
| Final summary | last `agent_message`, or `-o <file>` |
| Exit status | process exit code, plus `turn.completed` vs `turn.failed` |
| Version | `codex --version` |
| Login state | `codex login status` prints e.g. `Logged in using ChatGPT` |
| Resume later | `codex exec resume <thread_id>` (not used in Stage 1) |

## Gotchas

- Codex reads stdin when it isn't a TTY ("Reading additional input from stdin..."). The Runner must spawn it with stdin set to null.
- Codex loads the user's `~/.codex/config.toml`, skills, and rules. In the test run it read a skill file from `~/.agents/skills`. That's fine for Stage 1, since the Runner is meant to use the user's own Codex setup (D20), but it means two machines can behave differently for the same task.
- Pass `--skip-git-repo-check` only if the worktree check fails. Worktrees are git repos, so it shouldn't be needed.
