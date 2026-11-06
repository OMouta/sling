# Personalities

A personality is who answers in a chat: its own instructions, the Sling tools it may use, a color, and a moving glyph. Make and edit them under **Personalities** in the sidebar.

A new workspace has two:

| Personality | Tools | For |
|---|---|---|
| Sling (the default) | Commands and coding tasks | Your machines, repos, and coding agents |
| Finance | None | Money questions. It can't see your machines |

## Picking one

The new chat screen has a row of personalities above the composer. Click one, swipe sideways on a phone, or press ← and → while the composer is empty. The chat keeps that personality for good: replies show its glyph, and the header shows its name. To talk to another one, start a new chat.

Chats from before personalities, and chats a workflow starts (Discord, for example), get the default. **Make default** on a personality's menu changes that for new chats only.

## What it can use

| Tools | Gives the assistant |
|---|---|
| Commands on your machines | `list_machines` and `run_command` |
| Coding tasks | `list_machines`, `delegate_coding_task`, `get_task`, and `cancel_task` |

Sling enforces this on the server. A personality without a tool never gets it, on an API key or on a machine's Codex or Claude Code, whatever its instructions say. The conversation's [permission mode](modes.md) still limits what the tools do. A personality with no tools has no permission mode to pick.

## Instructions

The instructions say who it is and how it answers. Sling adds the rest: that the chat shows Markdown, that it can't browse the web, the rules for each tool it has, the permission mode, and today's date. On Claude Code they replace Claude Code's own system prompt. On Codex they go in as developer instructions, after Codex's own prompt.

Changing the name, instructions, or tools bumps the personality's revision, and each reply records the revision that wrote it. Deleting a personality hides it from new chats, and chats that already use it keep it.
