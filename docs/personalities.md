# Personalities

A personality is who answers in a chat: its own instructions, the Sling tools it may use, a color, and a moving glyph. Make and edit them under **Personalities** in the sidebar.

A new workspace has one, Sling: the default, with every tool. **From template** adds ready-made ones in a click, and each can be changed after:

| Group | Personality | Tools | For |
|---|---|---|---|
| Your machines | Sling | Commands, coding tasks | Your machines, repos, and coding agents |
| | Ops | Commands | Disk, memory, processes, services, and logs, without touching code |
| | Incident | Commands, coding tasks | Finding why something broke, then handing the fix to a coding agent |
| Thinking | Research | None | Explaining a topic and comparing options |
| | Planner | None | Turning a goal into steps and a schedule |
| Words | Writer | None | Drafting and editing emails, posts, and docs |
| | Tutor | None | Teaching a subject step by step |
| Everyday | Finance | None | Budgets, spending, and money questions |
| | Travel | None | Trips around your dates and budget |
| | Chef | None | Recipes from what's in your kitchen |
| | Language coach | None | Practice in a language you're learning |

With only one personality there's nothing to pick, so the new chat screen shows no row until you add another.

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
