# Personalities

A personality is who answers in a chat: its own instructions, the Sling tools it may use, the model it runs on, the files it answers from, a color, and a moving glyph. Make and edit them under **Personalities** in the sidebar.

A new workspace has one, Sling: the default, with every tool. **New personality** starts blank, from a template, or from a file someone exported, then asks for its name, its look, what it can use, and its instructions, one step each, filled in from the template. Each can be changed after. The templates:

| Group | Personality | Tools | For |
|---|---|---|---|
| Your machines | Sling | Every group | Your machines, repos, coding agents, apps, deploys, shared folders, and Sling's own setup |
| | Ops | Commands, memory, web search | Disk, memory, processes, services, and logs, without touching code |
| | Incident | Commands, coding tasks, deploys, memory, web search | Finding why something broke, then handing the fix to a coding agent |
| Thinking | Research | Memory, web search | Explaining a topic and comparing options |
| | Planner | Apps and workflows, memory, web search | Turning a goal into steps and a schedule |
| Words | Writer | Memory | Drafting and editing emails, posts, and docs |
| | Tutor | Memory | Teaching a subject step by step |
| Everyday | Finance | Memory, web search | Budgets, spending, and money questions |
| | Travel | Memory, web search | Trips around your dates and budget |
| | Chef | Memory | Recipes from what's in your kitchen |
| | Language coach | Memory | Practice in a language you're learning |

With only one personality there's nothing to pick, so the new chat screen shows no row until you add another.

## Picking one

The new chat screen has a row of personalities above the composer. Click one, swipe sideways on a phone, or press ← and → while the composer is empty. The chat keeps that personality for good: replies show its glyph, and the header shows its name.

To ask another personality something in the middle of a chat, type `@` in the composer and pick it from the list, with the arrow keys and Enter or by tapping. That one message is answered by the personality you mentioned, with its own instructions, tools, sources, and model, under its glyph and name. The next message without a mention goes back to the chat's own personality, which sees what the other one said.

Chats from before personalities, and chats a workflow starts (Discord, for example), get the default. **Make default** on a personality's menu changes that for new chats only.

## What it can use

| Tools | Gives the assistant |
|---|---|
| Commands on your machines | `list_machines` and `run_command` |
| Coding tasks | `list_machines`, `delegate_coding_task`, `get_task`, and `cancel_task` |
| Apps and workflows | `run_workflow`, and a tool for each connector action that's open to the assistant and has an enabled installation, such as `calendar_list_events`, `calendar_create_event`, `email_send`, and `discord_send_message`. At most 30 |
| Deploys | `list_machines`, `run_check`, and `deploy_task` |
| Change Sling's setup | `read_setup`, `save_deploy_target`, `save_app_account`, `add_workflow`, `change_workflow`, `create_workflow`, `workflow_nodes`, `save_personality`, `change_settings`, and `save_rule` |
| Memory | `remember`, `forget`, and `recall`, and what it knows about you in its prompt. See [memory.md](memory.md) |
| Files on your machines | `search_files` and `read_file`, in the folders your machines share. See [runner.md](runner.md#folders) |
| Web search | The model's own web search and page reading, with numbered citations. See [sources.md](sources.md#web-search) |

A personality with sources of its own, or a chat with files in it, also gets `search_sources` and `read_source`. That isn't a group to turn on: adding a source is the switch. See [sources.md](sources.md).

Memory and Files never ask, in any mode, Read-only included: memory reads and writes only Sling's own data, and files are only read.

With Apps and workflows, reading, such as the calendar, never asks. Anything that sends or creates something outside Sling, or a workflow that does, is refused in Read-only, asks you in the chat first in Supervised and Auto, and runs at once in Full access. If you decline, or don't answer within 5 minutes, nothing is sent. Every call is in the audit log as `assistant.action`. Values the assistant passes are used as they are, never as `={{ }}` expressions.

With Change Sling's setup, the assistant can add or change deploy targets, connect or change app accounts, add a workflow from a template, turn one on or off, rename it, or change a step's settings and publish it, add or edit personalities, and change workspace settings: the time zone, the mode new chats start in, the default chat model, push notifications, sandbox limits, and which repos may run in sandboxes. Reading what's set up never asks. Each change shows in the chat as a card that lists what would change, the old value next to the new one for an edit. Read-only refuses, Supervised and Auto wait for **Apply**, and Full access applies at once.

Passwords, app passwords, tokens, and deploy hook URLs go in a field on that card, never in the chat. The value goes from the card to the server with **Apply**, so the model only hears whether it worked. A change that needs one shows the card even in Full access. For a new app account, Sling runs the connector's setup lookup on what the assistant passed, such as finding the mail servers for an address, and runs the connection test when you apply. A failed test changes nothing and shows on the card. Every change is in the audit log as `assistant.change`, with which secret fields were filled but never their values.

`save_rule` makes a [rule](rules.md), such as "stop asking me before adding calendar events". Its card shows in every mode, Full access included, since a rule outlives the chat.

Sling enforces this on the server. A personality without a tool never gets it, on an API key or on a machine's Codex or Claude Code, whatever its instructions say. The conversation's [permission mode](modes.md) still limits what the tools do. A personality with no tools has no permission mode to pick.

## Instructions

The instructions say who it is and how it answers. Sling adds the rest: that the chat shows Markdown, whether it can search the web, the rules for each tool it has, its sources, how to suggest follow-ups, the permission mode, and the date and time in the workspace's time zone. On Claude Code they replace Claude Code's own system prompt. On Codex they go in as developer instructions, after Codex's own prompt.

Changing the name, instructions, or tools bumps the personality's revision, and each reply records the revision that wrote it. Deleting a personality hides it from new chats, and chats that already use it keep it.

## Its model

**Model** on a personality's page is the same picker the composer has, with **Workspace default** first. Picking that personality on the new chat screen sets the composer's picker to its model, and you can still change it there for that chat. A chat with no model of its own, such as one a workflow starts, runs on the personality's model, then the workspace default. Changing the model doesn't bump the revision, since the prompt stays the same.

## Replies

Under each reply are **Copy** (its Markdown), **Read aloud** (in the browser's voice, leaving out code blocks and citation numbers; it shows only where the browser can speak), thumbs up and down, and **Retry** on the latest one. Hover your latest message for a pencil to edit it and send it again. Retry and Edit replace what came after, and start the coding agent's session over. Neither is offered after a reply that started a task, sent something, changed Sling's setup, or ran a command outside the sandbox, because running it again would do it twice.

The latest reply can end with up to three follow-ups the assistant suggests, as buttons that send them. Channels such as Telegram don't see them.

## Feedback

A thumbs down asks what was wrong, which you can leave blank. Once a reply has been rated, the personality's page has a **Feedback** section: the counts for its current revision, and the latest downvotes with their reason and a link to the chat. **Suggest changes**, there when the current revision has downvotes, sends the instructions and the latest 20 downvotes to the personality's model, with no tools, and shows new instructions next to the old ones. **Apply** saves them, which bumps the revision, and the counts start over.

## Export and import

**Export**, in a personality's menu and on its page, downloads `<name>.sling-personality.json`: its name, description, instructions, tools, look, model, and its sources with their files. **New personality → From a file** adds one from such a file, last in the list, and reads its sources again. Its memories, feedback, and chats stay behind. A file over 100 MB, or one that isn't a personality file, is refused with the reason.
