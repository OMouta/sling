# Stage 6 build plan

An assistant that knows you and acts under rules you set. This adds to the spec's stages, with the choices in `decisions.md` applied (D82 to D93 are new for this stage).

## Status (2026-11-07)

Planned. Nothing built yet.

## Goal

Three people use Sling.

The first tells it once that they're vegetarian and that Jo is their accountant. A week later, in a new chat with another personality, "book dinner with Jo" picks a vegetarian place and knows who Jo is. They can see both facts on **Memory**, with the chats they came from, and delete either one.

The second says "every Monday at 9, send me this week's calendar in Telegram". The assistant writes a workflow, shows its steps on a card, and after **Apply** it runs every Monday with no model involved except where one is needed. They approved adding calendar invites from email twelve times, so Sling offered "Always allow", and now it adds them without asking. When their site goes down, a rule starts an Incident chat that investigates before they've seen the alert. It still asks before it deploys.

The third mostly talks to Sling from iMessage on their phone, through their Mac at home, or holds the mic button in the installed app. When the assistant sends an email, the card says "Sent. No bounce after 10 minutes". When it adds an event, it reads it back from the calendar. **Checks**, where **Deploys** used to be, shows everything Sling watches: their site, a backup command on the home server, and "Jo replied", waiting until Friday.

## Done when

1. **Memory.** In a chat, "I'm vegetarian" saves a memory, and the chat shows "Remembered: …" with **Undo**. A new chat with another personality gets it in its prompt. **Memory** lists it with a link to the chat. Editing it changes what the next chat sees, and deleting it removes it everywhere. Undo deletes it. A password or card number is refused by the server, whatever the model asks.
2. **Recall.** With 2,000 memories, the prompt holds the most recently used that fit the budget, and `recall` finds an older one by its words.
3. **Files.** On a machine, `sling-runner folder add ~/Notes` shares a folder. "What did I write about the boiler?" runs `search_files` and `read_file` there and quotes the note. A path outside the folder, a symlink out of it, and a folder that wasn't added are refused by the Runner. With the machine offline, the tool says so.
4. **Workflows from chat.** "Every Monday at 9, send me this week's calendar on Discord" makes the assistant call `create_workflow`. The card lists the steps in plain words and which ones send. After **Apply** the workflow exists, is valid, opens in the editor, and a manual run sends the message. An invalid graph is refused with the validator's errors, and the assistant fixes it. "Change it to Tuesdays" edits the same workflow through `change_workflow`.
5. **One-time schedules.** "Remind me at 17:00 to call the bank" makes a workflow with a one-time schedule. It runs once at 17:00 in the workspace's time zone and turns itself off.
6. **Allow rules.** An email send's card offers **Always allow** with what the rule would cover ("Email to anyone at acme.com"). After that, matching sends run without asking in Supervised and Auto and are still refused in Read-only. A send that doesn't match still asks. After five approvals in a row of the same kind with no denial, the card says so and offers the rule. Revoking it on **Approvals → Rules** makes the next send ask again. Merges, deploys, and commands outside the sandbox never match a rule.
7. **Start rules.** A rule "When Website goes down, Incident investigates" starts a chat on its own when the check goes down, and runs a turn with the check's results, in at most Auto. The deploy it proposes still asks. The chat shows the rule that started it.
8. **Rules from chat.** "Stop asking me before adding calendar events" makes the assistant call `save_rule`. The card shows in every mode, Full access included, and nothing changes until **Apply**.
9. **Checks.** **Deploys** is gone from the sidebar, and **Checks** has every former deploy target with its health checks, history, and deploy method intact. `/deploys` redirects there. A new site check, a command check on a machine, and a reply check each run on their own and change state. A failing check sends a push, and tapping it opens the draft as today. The **Site down alert** template still works.
10. **Every action checked.** From chat:
    - an event added through CalDAV or Google is read back, and the card says which calendar it's in
    - a Discord message is fetched back by its ID
    - an email send watches the mailbox for a bounce for 10 minutes, and a bounce marks it failed and tells the conversation
    - a delivered PR waits for its CI, and the deploy approval shows the result
    
    A failed check tells the conversation, which tells you, and sends a push.
11. **Email from chat.** "Did Jo email me about the invoice?" runs `email_search` and `email_read` without asking, against GreenMail in tests and a real mailbox live.
12. **Google Calendar.** With your own Google OAuth client, connecting goes through Google's consent screen and back. Events list and create through Google's API, and an expired access token refreshes on its own.
13. **Telegram.** With a bot token, the setup finds your chat after you message the bot. The **Telegram assistant** template answers there, and messages from anyone else are ignored.
14. **Signal and iMessage.** `sling-runner channel add imessage` on a Mac and `sling-runner channel add signal` with signal-cli linked each make a channel. The **iMessage assistant** and **Signal assistant** templates answer messages from the senders the machine allows and ignore everyone else. Messages that arrive while the Runner is down are answered after it reconnects, once.
15. **Voice.** Holding the mic button in the composer fills it with what you said, and releasing stops. Where the browser has no speech recognition, there's no button.
16. **Approve from the notification.** On Android and desktop, a send or a push-and-PR approval shows **Allow** and **Deny** on the notification itself, and the answer works without opening Sling. Merges, deploys, and commands open Sling instead. A notification's answer works once.
17. **Checked in a browser**, at desktop and phone width, in dark and light: Memory, Checks and its dialog, Approvals → Rules, the workflow card, the memory line, an action's check on its card, the mic button, and the new connectors' setup.

## Out of scope

- Embeddings or a vector database. Memory search is Postgres full-text.
- Reading PDFs, images, or Office files in shared folders. Text files only.
- Allow rules for merges, deploys, or commands outside the sandbox.
- Start rules triggered by anything other than a check, such as an email. Workflows already start chats on other events.
- Checks inside workflow runs. Workflow nodes don't verify their sends yet.
- WhatsApp, SMS, and Gmail through OAuth.
- Voice replies read aloud, and transcription on your own machines.
- Answering approvals from an iPhone's notification, which shows no buttons.
- Automatic rollback, still. A failed deploy check still offers a revert task.

## Memory (D82)

A memory is one fact about you, in your words or the assistant's, at most 500 characters.

| Field | Holds |
|---|---|
| `text` | The fact, such as "Vegetarian" or "Jo Silva is their accountant, jo@silva.pt" |
| `personalityId` | Null for every personality, or one personality |
| `source` | `{ kind: "chat" \| "manual", conversationId?, messageId? }` |
| `createdAt`, `updatedAt`, `lastUsedAt` | `lastUsedAt` moves when a prompt includes it or `recall` returns it |

- **Who saves.** The assistant saves on its own with `remember`, and the chat shows "Remembered: Vegetarian" with **Undo**, as a step on the reply. You can add one on **Memory**, and the assistant's `forget` deletes one when you ask.
- **What it saves.** The fixed prompt says: lasting preferences, people and how to reach them, places, routines, and things you asked it to remember. Never secrets, never one-off details, never anything you said to forget.
- **The server refuses** a memory that looks like a secret: API key and token patterns, a card number that passes Luhn, and anything next to "password". The tool says why.
- **In the prompt.** A "What you know about the user" block holds the memories the chat's personality can see, most recently used first, up to 6 KB. Memories saved in the chat are already in its history. A Claude Code session keeps the prompt it started with, so a memory changed elsewhere reaches new chats.
- **`recall`** searches every memory the personality can see, with Postgres full-text search on `text`, at most 20 results.
- **Scope.** A memory is for every personality unless the model or you pin it to one. Deleting is a hard delete.
- **The page.** **Memory**, in the sidebar after Personalities: a search field, the list with each memory's source chat and personality, inline edit, delete, and **Add**.
- **The group.** `memory` is a new personality tool group. The migration gives it to every personality, since it reads and writes only Sling's own data.

## Files on your machines (D83)

- **The machine decides.** `sling-runner folder add <path> [--name <name>]`, `folder remove <name>`, and `folder list`. The inventory reports each folder's name only. The control plane can't add one.
- **Search.** `FileSearch` runs on the machine with ripgrep's crates (`ignore`, `grep-searcher`): case-insensitive, `.gitignore` respected, hidden files, `.git`, and `node_modules` skipped, files over 2 MB and binary files skipped. At most 50 hits, each with folder, relative path, line, and a 200-character snippet, in under 2 seconds or it returns what it has.
- **Read.** `FileRead` returns at most 256 KB of a text file, with a flag when it's cut.
- **What the Runner refuses:** a path that leaves the folder after resolving `..` and symlinks, a folder that wasn't added, binary files, and anything with `files off` (`sling-runner config set files off`).
- **Tools.** `search_files` (query, optional machine and folder) and `read_file` (machine, folder, path), in a new group `files`. Reading never asks, and Read-only allows it. The default personality gets `files`, other personalities don't.
- **Machines page.** Each machine lists its shared folders, with the `sling-runner folder add` line to copy when there are none.

## Workflows from chat (D84)

- **`create_workflow`** takes a name, a description, and a `sling.workflow/v1` definition (nodes and edges), and whether to turn it on. It's a setup change, so it shows a card and waits for **Apply** in Supervised and Auto, and applies at once in Full access.
  - The server validates it with `validateWorkflow` and the node registry before the card shows. Errors go back to the model, which fixes the graph and tries again.
  - Installation fields must name one of the user's installations. The card shows them by name.
  - The card lists the steps in order in plain words ("Every Monday at 09:00", "Read this week's calendar", "Send to Discord #general"), marks the ones that send, and links to the editor after it's applied.
- **`change_workflow`** gains `definition`, which replaces the graph and publishes a new version, on the same card.
- **`workflow_nodes`** returns the node catalog: each type, what it does, its config fields, and its ports. With `types` set it returns their full schemas. It keeps the catalog out of the fixed prompt.
- **What the prompt says.** Offer a workflow when a request repeats ("every", "whenever", "each time"). Prefer plain nodes, and use `ai.*` only where a step needs judgment. Expressions are allowed in the graph, because you review the card and the engine evaluates them at run time.
- **The chat menu** gains **Make this a workflow**, which sends "Turn what we did in this chat into a workflow" as your message.
- **One-time schedules.** `core.schedule` gains `at`, a local date and time. The workflow runs once then and turns itself off. A time in the past is refused.

## Rules (D85)

A rule is a standing answer you gave once. Rules live on **Approvals**, under a **Rules** tab next to the pending list.

**Allow rules** skip the question for an action that would ask:

| Field | Holds |
|---|---|
| `action` | A flagged node type (`email.send`), `run_workflow`, or a task step (`push`, `open_pr`) |
| `installationId` | Optional. One account |
| `match` | Pinned argument values, such as `{ to: "*@acme.com" }` or `{ calendar: "Work" }`, or `{ repo: "host/owner/name" }` for task steps |

- **What may be pinned.** A node's `assistant` spec gains `ruleFields` (SDK 1.2.0), the arguments a rule may pin, such as `to` for email and `channelId` for Discord. A string field matches exactly, or with one leading `*` as a suffix match. Fields that aren't pinned are free.
- **Where they apply.** Supervised and Auto, in chats and in turns a workflow starts. Read-only still refuses, and Full access never asks anyway.
- **What never matches:** merge, deploy, commands outside the sandbox, setup changes, and saving a rule.
- **Earned.** Each card offers **Always allow**, which shows the rule it would make before you confirm. After five approvals in a row of the same action and installation with no denial in 30 days, the card says "You've allowed this 5 times" above the same button.

**Start rules** start work when a check changes:

| Field | Holds |
|---|---|
| `checkId` | One check, or null for every check |
| `on` | `down`, `up`, `met`, or `missed` |
| `personalityId` | Who answers |
| `message` | The first message, with the check's name and results filled in |
| `mode` | Read-only, Supervised, or Auto. Never Full access |

- A start rule opens a new chat and runs its first turn at once. The chat's header says which rule started it. Deploys and merges inside it ask as in any chat in that mode.
- At most one chat per rule per check every 30 minutes, so a flapping site doesn't open twenty.
- The Site down alert's push still goes out. Its tap opens the chat the rule started, when there is one, instead of a draft.

**From chat.** `save_rule` makes either kind. Its card shows in every mode, Full access included, because a rule outlives the chat that made it.

**Audit.** `rule.created`, `rule.revoked`, and `rule.used` on every action a rule let through, with the rule's ID on the `assistant.action` row.

## Checks (D86)

**Checks** replaces **Deploys** in the sidebar, at the same place. A check is something Sling watches on its own.

| Kind | Passes when | Runs |
|---|---|---|
| `site` | Every URL answers as set (1 to 5, as health checks do today), and the version URL shows the deployed commit when there's a deploy | Every minute by default |
| `command` | A command you set exits 0, and its output contains the text when one is set. It runs in the Runner's read-only sandbox on the machine you pick | Every 5 minutes by default |
| `reply` | An email matching from, subject, or thread arrives before the deadline | Every 5 minutes until met or missed |

- **State.** `site` and `command` are `up` or `down`: down after two failures in a row, up after one pass. `reply` is `waiting`, then `met` or `missed`, and then stops.
- **Deploys live on a site check.** A deploy target becomes a site check that also deploys: the repo, the method, the machine or hook, and the merge method move with it. The migration makes one site check per target with the target's checks, version URL, and last check, and keeps the target's ID on it so tasks and actions still find it. Verify after a deploy runs that check.
- **Scheduler.** One pg-boss job every 30 seconds runs the checks that are due, at most eight at once. Each result is saved, and the last 100 results per check are kept.
- **On a change.** A push, as the Site down alert sends today, and the realtime event `check.changed`. The workflow trigger `checks.changed` replaces polling with `deploys.check`, and the template moves to it. Start rules listen to the same event.
- **From chat.** `save_check` makes or changes a check, as a setup change. `check_deploy_target` becomes `run_check`, which runs one now.
- **Command checks.** The command is set by you or on a setup card, never run outside the sandbox, and refused on a machine with `commands off`.

### Checking actions

An action that changes something outside Sling checks that it happened. The result is on the action's step in the chat as `check: { state, message, at }`, where state is `passed`, `failed`, `waiting`, or `unchecked`.

| Action | Check |
|---|---|
| `calendar.create_event` | Reads the event back by its UID, and says which calendar it's in |
| `discord.send_message` | Fetches the message back by its ID |
| `email.send` | Watches the mailbox for 10 minutes for a bounce that names the message ID |
| `telegram.send_message`, `signal.send_message`, `imessage.send_message`, `ntfy.publish` | The service's answer only, so `passed` means accepted |
| A task's PR | Waits up to 30 minutes for the PR's CI, through `gh pr checks` on the machine or GitHub's API for a sandbox. The deploy approval shows the result |
| A deploy | Verify, as today |

- **The SDK.** A node may export `verify(ctx, output)`, returning `{ state, message, retryAfterSeconds? }` (SDK 1.2.0). Sling runs it right after the node, and again later while it says `waiting`, as a pg-boss job, up to the node's limit.
- **On failure.** The conversation gets an update ("The email to jo@silva.pt bounced: mailbox not found"), the assistant tells you, and a push goes out.
- **Nodes with no `verify`** show nothing. The step never claims a check it didn't do.

## Email from chat (D87)

- **`email.search`** searches over IMAP with `from`, `to`, `subject`, `text`, `since`, `before`, `unread`, and `folder` (INBOX by default). It returns at most 50 messages, newest first: ID, from, to, subject, date, and a 200-character snippet.
- **`email.read`** returns one message's headers, its text body (from the HTML when there's no text part) up to 20 KB, and its attachments by name and size.
- Both are flagged for the assistant and don't send, so they never ask. `reply` checks and the bounce check use the same search.

## Google Calendar (D88)

- **A new kind, `google`,** in the calendar connector, next to `caldav` and `ics`. The same two nodes work on it.
- **Your own OAuth client.** You make a Google Cloud OAuth client (web application) and paste its ID and secret. The setup lookup shows the redirect URL to add, `<SLING_PUBLIC_URL>/api/oauth/google/callback`, which works on localhost too.
- **The flow.** **Connect** opens Google's consent screen with the `calendar.events` and `calendar.readonly` scopes, PKCE, and a state bound to the session. The callback stores the refresh token encrypted, and the access token is refreshed when it's within a minute of expiring.
- **The API.** Calendar API v3: `events.list` with `singleEvents=true` for recurrences, and `events.insert` with an ID from the idempotency key, so a repeat creates nothing.
- **Reuse.** The OAuth routes and token store are a small server module that the next OAuth connector can use. This rules out a Sling-owned OAuth client.

## Telegram (D89)

- **Built in**, in `integrations/telegram`, running in the server process like Discord.
- **Setup.** A bot token from @BotFather. The setup lookup checks it with `getMe`, then asks you to send the bot a message, and picks your chat from `getUpdates`. Only chats you allow are answered, and by default that's the one.
- **Listening.** Long polling on `getUpdates`, so no public address is needed. The offset is stored, so a restart doesn't answer anything twice.
- **Nodes.** `telegram.message_received` and `telegram.send_message`, flagged as sending with `ruleFields: ["chatId"]`. Long replies split at 4,096 characters, and Markdown is converted to Telegram's HTML subset.
- **Template.** **Telegram assistant**, built like **Discord assistant**.

## Signal and iMessage, on your machine (D90)

Neither has an API Sling can call, so a paired machine does it. The machine decides, as it does for repos.

- **Config.**
  - `sling-runner channel add imessage` (macOS only). It checks that it can read `~/Library/Messages/chat.db` (Full Disk Access) and that Messages answers to AppleScript, and says what to grant when it can't.
  - `sling-runner channel add signal --account <number>`. It needs `signal-cli` installed and linked as a device (`signal-cli link`), and runs `signal-cli -a <number> jsonRpc` as a child process.
  - `sling-runner channel allow <channel> <sender>` and `disallow`. With no allowed senders, nothing is forwarded.
  - `channel remove`, and `config set channels off`.
- **What the Runner does.**
  - **iMessage:** polls `chat.db` read-only every 2 seconds for rows past the last ROWID it forwarded, and sends with `osascript` outside the sandbox, the text passed as an argument and never in the script source.
  - **Signal:** reads `receive` notifications from signal-cli and sends with its `send` method.
  - It keeps a cursor per channel on disk, so messages that arrived while it was down are forwarded once after it reconnects.
- **Protocol.** `ChannelMessage` from the Runner, with the channel, conversation, sender, text, time, and ID. `ChannelSend` from the server, answered by `ChannelSendResult`. The inventory lists channels and their allowed-sender count.
- **Server.** Connectors `imessage` and `signal`, whose installation names a machine and a channel, with `*.message_received` and `*.send_message` nodes. A send waits up to 5 minutes for the machine to come online, then fails and says which machine. Templates **iMessage assistant** and **Signal assistant**.

## Voice (D91)

- The composer gets a mic button when the browser has `SpeechRecognition` or `webkitSpeechRecognition`. Hold it to talk, release to stop. A short tap starts and a second tap stops, for phones where holding is awkward.
- Interim words show in the composer as you talk, in the browser's language. Nothing sends until you press send.
- Chrome sends the audio to Google and Safari to Apple for recognition. Sling never sees the audio.

## Approving from a notification (D92)

- **Which approvals.** Sends from chat, and task steps that push or open a PR, get **Allow** and **Deny** actions on their push. Merges, deploys, commands, setup changes, and rules open Sling, as today.
- **The answer.** The push payload carries a token: an HMAC over the approval's ID, the user, and its expiry, with a key derived from `SLING_SECRET_KEY`. The service worker posts the action and the token to `POST /api/approvals/:id/notification-answer`, which works without a session, once, before the approval expires.
- **After.** The service worker replaces the notification with the outcome ("Allowed", "Already answered", "Expired").
- iOS shows no notification buttons, so iPhones tap through as today.

## Personality tool groups (D93)

`PERSONALITY_TOOLS` gains `memory` and `files`.

| Tool | Group | Does |
|---|---|---|
| `remember`, `forget`, `recall` | memory | Above |
| `search_files`, `read_file` | files | Above |
| `create_workflow`, `workflow_nodes` | setup | Above |
| `save_rule` | setup | Above, always with a card |
| `save_check`, `run_check` | setup, deploys | `save_check` in setup, `run_check` in deploys |
| `email_search`, `email_read`, `telegram_send_message`, … | apps | Flagged nodes, as today |

`check_deploy_target` is renamed `run_check`, and still takes a deploy target's name.

## Data model additions

Migration `0012_assistant_memory` (the W0 agent may split it):

| Change | Holds |
|---|---|
| `memories` (new) | The fields above, plus workspace and user. A generated `tsvector` column with a GIN index |
| `rules` (new) | Kind (`allow` or `start`), the fields above, created from (approval ID or chat), uses, last used, revoked at |
| `checks` (new) | Kind, name, config (jsonb), schedule seconds or deadline, machine, state, failures in a row, last result, notify. Unique on (workspace, name) |
| `check_results` (new) | Check, time, passed, results (jsonb). The last 100 per check |
| `deploy_targets` | Gains `check_id`. The migration makes a site check for each target and moves its checks, version URL, and last check |
| `action_checks` (new) | What an action's check said: the tool call or action, state, message, attempts, next run |
| `oauth_tokens` (new) | Installation, provider, refresh token (encrypted), access token (encrypted), expiry, scopes |
| `notification_answers` (new) | Approval ID, used at, so a token works once |
| `channel_cursors` | Not in Postgres. The Runner keeps them on disk |
| `personalities` | Every personality gains `memory`; the default gains `files` (data only) |
| `audit_events` | New verbs: `memory.*`, `rule.created`, `rule.revoked`, `rule.used`, `check.*`, `files.read`, `channel.*`, `oauth.connected` |

## Protocol

- **`Inventory`** gains `folders` (names), `files` (false after `files off`), and `channels` (kind, name, allowed-sender count, ready, and what's missing when it isn't).
- **Server to Runner:** `FileSearch { request_id, query, folders[], max_results }`, `FileRead { request_id, folder, path, max_bytes }`, `ChannelSend { request_id, channel, conversation, text }`.
- **Runner to server:** `FileSearchResult { request_id, hits[], truncated, error }`, `FileReadResult { request_id, content, truncated, error }`, `ChannelMessage { channel, conversation, sender, text, at, message_id }`, `ChannelSendResult { request_id, ok, message }`, and `ChannelMessageAck`-style acknowledgment so the cursor moves only after the server has it.

## API

```text
GET    /api/memories?q=                    the user's memories, searched
POST   /api/memories                       { text, personalityId? }
PATCH  /api/memories/:id
DELETE /api/memories/:id
GET    /api/rules
POST   /api/rules                          from the card's Always allow, and the Rules tab
DELETE /api/rules/:id                      revokes
GET    /api/checks                         with state, last result, and deploy target
POST   /api/checks
PATCH  /api/checks/:id
DELETE /api/checks/:id
POST   /api/checks/:id/run
GET    /api/checks/:id/results
GET    /api/oauth/google/start?installationId=
GET    /api/oauth/google/callback
POST   /api/approvals/:id/notification-answer   { token, answer }
```

- `/api/deploy-targets` keeps working, backed by checks, until the web app no longer calls it.
- **Realtime.** `memory.updated`, `rule.updated`, `check.changed`, and `tool_step.check` for an action's check.
- **Views.** `MemoryView`, `RuleView`, `CheckView`, `CheckResultView`, `ActionCheckView` on `ToolStep.check`, `MachineView.folders` and `.channels`, and `ConversationView.startedBy` for a rule.

## Workstreams

The contracts land on `main` first. Seven workstreams then run in parallel, each in its own worktree, and integration comes last. Each workstream owns its feature from the server to the web page, so it can check its own work end to end.

### W0. Contracts (on main, first)

- **`@sling/core`:** the views, events, and tool group additions above, and stub routes in the web router and nav (Memory, Checks in place of Deploys) that the workstreams fill in.
- **Protocol:** the messages above, then `buf generate`, with the Rust side compiling and the new messages unhandled.
- **`packages/db`:** the migration and schema.
- **`@sling/connector-sdk` 1.2.0:** `ruleFields` on `assistant`, and `verify` on node definitions, carried through `describe()` and extensions, with the API report updated.
- **Server:** empty service slots on `AppContext` (`memory`, `files`, `rules`, `checks`, `channels`, `oauth`) with interfaces, and `TOOLS_BY_GROUP` entries.

### WA. Memory and files

- **Server:** `apps/server/src/memory/` (service, secret refusal, the prompt block and its budget, routes), `remember`, `forget`, `recall`, and `search_files` and `read_file` over the new protocol messages.
- **Runner (Rust):** `folder add|remove|list`, `config set files`, `FileSearch` and `FileRead` with every refusal.
- **Web:** the **Memory** page, the "Remembered" step with **Undo**, and folders on **Machines**.
- **Tests:** unit tests for the secret patterns and the budget, Rust tests against real folders with symlinks out, an end-to-end test on the real Runner.

### WB. Workflows from chat

- **Server:** `create_workflow`, `workflow_nodes`, `change_workflow` with `definition`, the step summary for the card, the prompt rules, and `core.schedule` with `at`.
- **Web:** the workflow card (steps, which ones send, **Open in editor**), and **Make this a workflow** in the chat menu.
- **Tests:** validation round trips, the summary for every built-in template, a one-time schedule firing once, and the setup-change tests for each mode.

### WC. Rules

- **Server:** `apps/server/src/rules/`, matching in the chat send approvals and in task step approvals, the earned suggestion, start rules on `check.changed` with the 30-minute limit, `save_rule`, and the audit.
- **Web:** **Always allow** on the approval card with the rule it makes, the suggestion line, and **Approvals → Rules**, with revoke.
- **Tests:** matching (exact, suffix, free fields), each mode, what never matches, a start rule running a turn with a mock model, and a rule from a Full access chat still asking.

### WD. Checks

- **Server:** `apps/server/src/checks/` (service, scheduler, the three kinds, results, the migration of targets), verify moved onto site checks, `checks.changed`, the template, `save_check`, `run_check`, the action check runner and its jobs, `verify` for calendar and Discord, and the PR's CI.
- **Web:** **Checks** in place of **Deploys**, its dialog with the deploy section, a check's history, the redirect, and an action's check on its step.
- **Tests:** the existing `deploys.e2e` passing on checks, each kind changing state, the scheduler's limits, verify functions with fakes, and CI through a stand-in `gh`.

### WE. Apps

- **`integrations/email`:** `email.search`, `email.read`, and `verify` on `email.send` for bounces.
- **`integrations/calendar`:** the `google` kind and `verify` on `create_event` for Google.
- **Server:** `apps/server/src/oauth/`.
- **`integrations/telegram`:** the connector, nodes, setup lookup, and **Telegram assistant**.
- **Tests:** GreenMail for search, read, and a bounce; a local stand-in for Google's token and Calendar endpoints; a local stand-in for the Bot API.

### WF. Signal and iMessage

- **Runner (Rust):** `channel add|remove|allow|disallow`, the iMessage poller and sender, the signal-cli child process, cursors, and the protocol messages.
- **Server:** the `imessage` and `signal` connectors, nodes, the wait for an offline machine, and both templates.
- **Tests:** iMessage against a copy of a `chat.db` schema made in the test with a stand-in `osascript` on `PATH`, and Signal against a stand-in `signal-cli` that speaks its JSON-RPC.

### WG. Voice and notification answers

- **Web:** the mic button and its states, the service worker's actions and answer, and the replaced notification.
- **Server:** the answer token, the route, single use, and which approvals get actions.
- **Tests:** DOM tests with a stand-in `SpeechRecognition`, the token's expiry and single use, and the service worker's handler.

### W6. Integration (after merge)

- **Merge.** Cherry-pick each workstream onto `main`, resolve conflicts, and run every suite.
- **Done when.** Run every item end to end. Real CLI turns on the cheapest model for memory, a workflow from chat, a rule, and an email search.
- **Browser.** Playwright against a preview with its own database, at desktop and phone width, in dark and light.
- **Live, with the user's help:** a Telegram bot, a Google OAuth client, Full Disk Access for iMessage, and a linked signal-cli. Each is listed as unverified until it runs.
- **Docs.** README, a new `docs/memory.md`, `docs/rules.md`, and `docs/checks.md` (replacing `docs/deploys.md`), the Telegram, Signal, iMessage, and Google sections, the runner and threat model docs, and this plan's status.

## Testing

- **Unit:** secret patterns, the memory budget, rule matching, check state changes, the scheduler, every `verify`, the workflow step summary, the one-time schedule, the notification token, Telegram's Markdown conversion and splitting.
- **Rust:** folders and their refusals, channel cursors, the iMessage reader against a test database, and the signal-cli client against a stand-in.
- **End to end, Postgres plus server plus real Runner plus `fake-codex`:** memory across chats, files on a real Runner, a workflow from chat, allow and start rules, checks of each kind, the moved deploy flow, action checks with GreenMail and the fake Discord, Telegram with a stand-in Bot API, and the channels with stand-ins.
- **Live:** real CLI turns on Haiku 5.5 or GPT-6-Luna at low effort, never in fast mode, counted in the status. The services above when the user sets them up.

## Budgets

| Measure | Budget |
|---|---|
| Memory block in the prompt | at most 6 KB |
| `recall` over 10,000 memories, p95 | under 30 ms |
| `search_files` over 20,000 files on the machine | under 2 s |
| Rule matching per action | under 1 ms |
| Check scheduler overhead per check | under 5 ms |
| An action's first check after the node returns | under 2 s |
| Telegram message to the assistant's turn starting | under 500 ms |
| iMessage message to the server | under 3 s |
| Notification answer to the approval resolved, p95 | under 100 ms |
| Web bundle growth, gzipped | under 40 KB |
