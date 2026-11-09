# Workflows

A workflow is a graph of nodes that runs when something happens: an email arrives, someone messages the bot, a schedule fires, or you send a chat message. The chat assistant in the web app is itself a workflow, called **Sling Assistant**, and you can open it like any other.

## The canvas

Nodes have two kinds of ports.

- **Exec ports** decide what runs next. Every node except a trigger has one exec input on its left. Exec outputs sit on the right, for example `next`, `true` and `false`, or one per label. Each exec output connects to at most one node. Several outputs may lead into the same node, which is how branches join again.
- **Data ports** carry values. A data input takes one edge, from an output of a node that ran earlier in the run. Ports have types (`string`, `email`, `discord.message`, `http.response`, and so on), and the editor refuses connections between types that don't fit. `json` accepts anything, and `any` goes anywhere.

Every node that isn't a trigger also has an `error` exec output and an `error` data output. Wire the exec output and a failure takes that path, with `{ message, code }` on the data output. Leave it unwired and the run fails.

If a data input's node didn't run (it sat on the other branch), the input is empty. A required input that ends up empty fails the node.

## Expressions

Config fields that accept expressions have a toggle in the inspector. An expression is [JSONata](https://jsonata.org), stored as `={{ … }}`, and evaluated against:

| Name | Holds |
|---|---|
| `inputs` | This node's data inputs, for example `inputs.value.from.address` |
| `trigger` | The trigger's outputs, for example `trigger.email.subject` |
| `vars` | Values stored with **Set variable**, for example `vars.summary.actionItems` |
| `execution` | `runId`, `workflowId`, `nodeId`, `iteration`, `attempt`, `triggerType`, and the `installationId` of the connector that fired it |

Condition fields (**If**, **Switch** cases, **Transform**) always hold JSONata, so you write `inputs.value.status >= 400` without the `={{ }}`.

Each evaluation stops after 1 second, a recursion depth of 300, or a million items.

## Drafts, versions, and runs

The editor saves your draft as you go. **Publish** validates it and makes it the next version. Enabled workflows react to their triggers using the newest published version, and every run records the version it ran, so older runs stay inspectable after you change things.

Every save of the draft moves its revision on, whether it comes from the editor, another tab, the API, or a change you approve in a chat. A save names the revision it started from, so the editor never overwrites a change it hasn't loaded. When the draft has changed somewhere else, the editor stops saving and asks: load the other draft, download yours as a file you can import, or overwrite the other one. **Publish** publishes the revision on your canvas, and refuses if the draft has moved on since. Leaving the editor waits for the last save, and if it fails you can retry or discard your changes. `PUT /api/workflows/:id/draft` takes `{ "definition": …, "revision": n }` for a save over revision `n` only, which answers 409 with the current draft when it has moved on. A bare definition still saves over whatever is there.

Open a run to see the graph colored by what happened, then click a node for its inputs, outputs, error, attempts, and timing. Stored inputs and outputs are cut at 64 KB each and kept for 30 days.

Runs survive restarts. Each node's result is saved before the next node starts, so a run picks up where it left off. **Wait**, **Approval**, and **Delegate coding task** can park a run for hours. A parked run holds no resources and wakes when its timer fires, the approval is decided, or the task settles.

## Retries and side effects

A node is retried automatically only if it says it's safe to repeat. Nodes that change something outside Sling (send a message, send an email, start a task, POST to a URL) are never retried on their own after a failure where the outcome is unclear. Wire their `error` port, or press **Retry** on the run once you've checked. If the server stops in the middle of such a node, the node fails with "interrupted, outcome unknown" rather than running twice.

Runs that belong to one conversation or one Discord channel run one at a time, in order. Other runs run side by side.

## Nodes

| Node | What it does |
|---|---|
| **Triggers** | |
| Manual run | Starts from the **Run** button, the API, or another workflow |
| Schedule | Cron schedule, or once at a date and time, in the time zone you set on the node, or the workspace's (**Settings → General**) when it's empty. See [one-time schedules](#one-time-schedules) |
| Webhook | `POST` to the URL shown once published. Anyone with the URL can start the workflow, unless it takes signed requests only. See [webhooks](#webhooks) |
| Chat message | A message sent in the web app |
| Conversation update | A note Sling adds to a conversation this workflow owns, for example a task finishing |
| Task settled | Any coding task finishing, waiting for approval, or finishing delivery |
| Approval requested | A new pending approval |
| Check changed | One of your [checks](checks.md) goes down, comes back up, or a reply check is met or missed. Filter by check name, kind, or change. Outputs the check, its state, the reason, and the page an alert should open |
| Discord message received | A message from an allowed user. See [connectors/discord.md](connectors/discord.md) |
| iMessage received, Signal message received | A message from a sender your machine allows. See [connectors/imessage.md](connectors/imessage.md) and [connectors/signal.md](connectors/signal.md) |
| Email received | New mail in a watched folder. See [connectors/email.md](connectors/email.md) |
| **Logic and data** | |
| If, Switch | Branch on a JSONata condition |
| For each | Run the following nodes once per item, up to 1,000 |
| Wait | Pause for a while or until a time |
| Transform | Build a value with JSONata |
| Set variable, Get variable | Values for the rest of the run |
| Store value, Get stored value | Values kept between runs of this workflow |
| Invoke workflow, Return | Call another workflow and use its result |
| **AI** | Uses the model from **Settings**. None of these have tools |
| AI prompt | Text out |
| AI extract | A JSON object matching a schema you give |
| AI classify | Picks one of your labels and leaves through that exec output |
| **Agents and people** | |
| Assistant | One turn of the Sling assistant in a conversation, with its machines and the conversation's permission mode |
| Delegate coding task | Starts a Codex or Claude Code task, on the best machine or in a sandbox, and waits for it to settle |
| Approval | Waits for you to approve, reject, or let it expire |
| Conversation | Finds or creates the conversation for a key |
| **Actions** | |
| HTTP request | Calls a URL. GET and HEAD retry on network errors, 429, and 5xx |
| Send Discord message | Channel or DM, optionally with Approve and Reject buttons |
| Send iMessage, Send Signal message | From your machine, to a sender it allows or a group they wrote in |
| Send email | Plain text over SMTP |
| List calendar events, Add calendar event | Read a day or a range of your calendar, with recurring events expanded, or add an event. See [connectors/calendar.md](connectors/calendar.md) |
| Check deploy targets | Runs the site check of every deploy target, or of one, and outputs the ones that changed since it last ran. For older workflows; new ones start from Check changed |
| Notify my devices | A push notification to the devices you turned on under **Settings → Notifications**. A tap opens the page you give. See [notifications.md](notifications.md) |

### One-time schedules

Put a local date and time in a **Schedule** node's **At**, such as `2026-11-09T17:00`, and leave **Cron** empty. The workflow runs once at that time, in the node's time zone or the workspace's, and then turns itself off. A time that has already passed can't be published or turned back on: set a new one first. If Sling is off at that time, the run starts when Sling is back.

### Webhooks

A **Webhook** trigger's settings say who may start it and how much at once. They take effect when you publish.

- **Requests**: **URL only** accepts any request to the URL. **Signed** also wants `X-Sling-Timestamp`, the Unix time in seconds, and `X-Sling-Signature`, the hex HMAC-SHA256 of the timestamp, a period, and the exact request body, made with the trigger's signing secret. A signature more than five minutes from the server's clock is refused with 401. **Create secret** makes the secret and shows it once. **Rotate** replaces it without changing the URL, and the old secret keeps working for an hour so senders can switch over. Rotating twice in a row retires the old one at once. A signed trigger can't be published without a secret.
- **Event ID header**: the header a sender puts its delivery ID in, such as `X-GitHub-Delivery`. A second request with the same ID answers 409 and starts nothing. It's `X-Sling-Event-Id` unless you pick another, or **None**. A signed request without one is told apart by its timestamp and body, so replaying it answers 409 too.
- **Runs at once**: while this many runs from the trigger are unfinished (queued, running, or waiting on an approval, a timer, or a task), further requests answer 429 with `Retry-After` and start nothing. The count is kept in the database, so it holds across restarts.

Triggers left on **URL only** follow the server's `SLING_WEBHOOK_SECRET` when it's set, and every webhook shares the per-workspace and per-address rate limits. See [install.md](install.md#automation-admission-and-storage-limits).

## From a chat

Ask the assistant for something that repeats, such as "every Monday at 9, send me this week's calendar on Discord", or for something at a set time, such as "remind me at 17:00 to call the bank". It writes a workflow and shows it on a card in the chat:

- the steps in the order they run, in plain words, such as "Every Monday at 09:00" and "Send to Discord #general"
- **Sends** next to each step that reaches outside Sling
- its name, and the accounts it uses

Sling checks the workflow the same way **Publish** does before the card shows, so the assistant fixes anything wrong first. Nothing is made until you press **Apply**, unless the chat is in Full access. Then it's published and on, and **Open in editor** on the card opens it. The assistant usually adds a **Manual run** next to a schedule, so you can try the workflow with **Run** before its time comes.

To change it, say so in the chat, such as "change it to Tuesdays". The card shows what changes, and **Apply** publishes a new version of the same workflow.

**Make this a workflow**, in a chat's **…** menu, asks the assistant to turn what you did in that chat into a workflow. The chat's personality needs **Change Sling's setup**. See [personalities.md](personalities.md#what-it-can-use).

## Templates

**New workflow** starts from a blank canvas or a template. A template asks for a connector installation for each placeholder, one step each, and you can add a missing one from that step. Then you name it, and it opens in the editor as an ordinary workflow you can edit.

| Template | Does |
|---|---|
| Sling Assistant | The web chat. Installed and enabled on first start. Disable it and chat answers that no workflow handles messages |
| Discord assistant | The same assistant in Discord DMs. Replies, and task updates, go back to the DM they came from |
| iMessage assistant, Signal assistant | The same assistant in iMessage or Signal, through your machine. Replies, and task updates, go back to the chat they came from |
| Important email to Discord | Summarizes mail from senders on a list and posts the summary and action items. Edit the list in the **If** node |
| Approval notifications in Discord | Posts every new approval with Approve and Reject buttons |
| Website health monitor | Checks a URL every five minutes and posts when it errors or can't be reached |
| Site down alert | When a site check goes down or comes back up, pushes "Website is down" or "back up" to your devices. Tapping the alert opens a chat with the Incident personality and a draft that says what failed. While it's on, the checks don't push a second alert |
| Morning briefing | At 07:30 in your time zone, reads today's calendar and has the assistant write the day's briefing in a new chat, then pushes it to your devices |

Templates live in `workflows/` in the repo, as the same JSON the editor exports. Extensions can add more: a template from an extension shows which one it came from, and works the same way.

**Export as package**, under **Export** on a workflow's **Versions** tab, turns a workflow into a package you can share. Every connector installation in it becomes a binding that asks for an installation when someone installs the template, and credentials are never included. The package is unsigned; sign it with `sling-ext sign` before you share it. See [workflow packages](extensions/workflow-packages.md).

## Connectors

Discord, email, and your calendar are set up under **Connectors**, as are connectors from [extensions](extensions/README.md), which add their own nodes. A connector that listens for events, such as Discord or email, only does so while an enabled workflow uses it, which is why an installation can show as idle.

- [Discord](connectors/discord.md)
- [Email](connectors/email.md)
- [Calendar](connectors/calendar.md)
- [iMessage](connectors/imessage.md) and [Signal](connectors/signal.md), relayed by one of your machines
