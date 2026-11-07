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
| Schedule | Cron schedule, in the time zone you set on the node, or the workspace's (**Settings → General**) when it's empty |
| Webhook | `POST` to the URL shown once published. Anyone with the URL can start the workflow |
| Chat message | A message sent in the web app |
| Conversation update | A note Sling adds to a conversation this workflow owns, for example a task finishing |
| Task settled | Any coding task finishing, waiting for approval, or finishing delivery |
| Approval requested | A new pending approval |
| Discord message received | A message from an allowed user. See [connectors/discord.md](connectors/discord.md) |
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
| Send email | Plain text over SMTP |
| List calendar events, Add calendar event | Read a day or a range of your calendar, with recurring events expanded, or add an event. See [connectors/calendar.md](connectors/calendar.md) |
| Check deploy targets | Runs every [deploy target](deploys.md)'s health checks, or one target's, and outputs the ones that went down or came back up |
| Notify my devices | A push notification to the devices you turned on under **Settings → Notifications**. A tap opens the page you give. See [notifications.md](notifications.md) |

## Templates

**New workflow** starts from a blank canvas or a template. A template asks for a connector installation for each placeholder, one step each, and you can add a missing one from that step. Then you name it, and it opens in the editor as an ordinary workflow you can edit.

| Template | Does |
|---|---|
| Sling Assistant | The web chat. Installed and enabled on first start. Disable it and chat answers that no workflow handles messages |
| Discord assistant | The same assistant in Discord DMs. Replies, and task updates, go back to the DM they came from |
| Important email to Discord | Summarizes mail from senders on a list and posts the summary and action items. Edit the list in the **If** node |
| Approval notifications in Discord | Posts every new approval with Approve and Reject buttons |
| Website health monitor | Checks a URL every five minutes and posts when it errors or can't be reached |
| Site down alert | Checks every deploy target each minute, and pushes "Website is down" or "back up" to your devices. Tapping the alert opens a chat with the Incident personality and a draft that says what failed |
| Morning briefing | At 07:30 in your time zone, reads today's calendar and has the assistant write the day's briefing in a new chat, then pushes it to your devices |

Templates live in `workflows/` in the repo, as the same JSON the editor exports. Extensions can add more: a template from an extension shows which one it came from, and works the same way.

**Export as package**, under **Export** on a workflow's **Versions** tab, turns a workflow into a package you can share. Every connector installation in it becomes a binding that asks for an installation when someone installs the template, and credentials are never included. The package is unsigned; sign it with `sling-ext sign` before you share it. See [workflow packages](extensions/workflow-packages.md).

## Connectors

Discord, email, and your calendar are set up under **Connectors**, as are connectors from [extensions](extensions/README.md), which add their own nodes. A connector that listens for events, such as Discord or email, only does so while an enabled workflow uses it, which is why an installation can show as idle.

- [Discord](connectors/discord.md)
- [Email](connectors/email.md)
- [Calendar](connectors/calendar.md)
