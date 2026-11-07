# Personalities

A personality is who answers in a chat: its own instructions, the Sling tools it may use, a color, and a moving glyph. Make and edit them under **Personalities** in the sidebar.

A new workspace has one, Sling: the default, with every tool. **New personality** starts blank or from a template, then asks for its name, its look, what it can use, and its instructions, one step each, filled in from the template. Each can be changed after. The templates:

| Group | Personality | Tools | For |
|---|---|---|---|
| Your machines | Sling | Every group | Your machines, repos, coding agents, apps, deploys, and Sling's own setup |
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
| Apps and workflows | `run_workflow`, and a tool for each connector action that's open to the assistant and has an enabled installation, such as `calendar_list_events`, `calendar_create_event`, `email_send`, and `discord_send_message`. At most 30 |
| Deploys | `list_machines`, `run_check`, and `deploy_task` |
| Change Sling's setup | `read_setup`, `save_deploy_target`, `save_app_account`, `add_workflow`, `change_workflow`, `save_personality`, `change_settings`, and `save_rule` |

With Apps and workflows, reading, such as the calendar, never asks. Anything that sends or creates something outside Sling, or a workflow that does, is refused in Read-only, asks you in the chat first in Supervised and Auto, and runs at once in Full access. If you decline, or don't answer within 5 minutes, nothing is sent. Every call is in the audit log as `assistant.action`. Values the assistant passes are used as they are, never as `={{ }}` expressions.

With Change Sling's setup, the assistant can add or change deploy targets, connect or change app accounts, add a workflow from a template, turn one on or off, rename it, or change a step's settings and publish it, add or edit personalities, and change workspace settings: the time zone, the mode new chats start in, the default chat model, push notifications, sandbox limits, and which repos may run in sandboxes. Reading what's set up never asks. Each change shows in the chat as a card that lists what would change, the old value next to the new one for an edit. Read-only refuses, Supervised and Auto wait for **Apply**, and Full access applies at once.

Passwords, app passwords, tokens, and deploy hook URLs go in a field on that card, never in the chat. The value goes from the card to the server with **Apply**, so the model only hears whether it worked. A change that needs one shows the card even in Full access. For a new app account, Sling runs the connector's setup lookup on what the assistant passed, such as finding the mail servers for an address, and runs the connection test when you apply. A failed test changes nothing and shows on the card. Every change is in the audit log as `assistant.change`, with which secret fields were filled but never their values.

`save_rule` makes a [rule](rules.md), such as "stop asking me before adding calendar events". Its card shows in every mode, Full access included, since a rule outlives the chat.

Sling enforces this on the server. A personality without a tool never gets it, on an API key or on a machine's Codex or Claude Code, whatever its instructions say. The conversation's [permission mode](modes.md) still limits what the tools do. A personality with no tools has no permission mode to pick.

## Instructions

The instructions say who it is and how it answers. Sling adds the rest: that the chat shows Markdown, that it can't browse the web, the rules for each tool it has, the permission mode, and the date and time in the workspace's time zone. On Claude Code they replace Claude Code's own system prompt. On Codex they go in as developer instructions, after Codex's own prompt.

Changing the name, instructions, or tools bumps the personality's revision, and each reply records the revision that wrote it. Deleting a personality hides it from new chats, and chats that already use it keep it.
