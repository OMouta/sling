# Stage 2 build plan

Workflows become first-class. This is spec section 15, Stage 2, with the choices in `decisions.md` applied (D28 to D35 are new for this stage).

## Goal

You can build and run the email example from the spec in a visual editor, and the assistant you chat with is itself a workflow you can open and change. Discord becomes a second way to talk to the same assistant and to approve its work.

## Done when

1. Under **Connectors**, add Discord (bot token, your Discord user ID as an allowed user and an approver) and Email (IMAP and SMTP). Both show a passing connection test.
2. Install the **Important email to Discord** template, set the sender allowlist, and enable it.
3. An email from an allowlisted sender produces a Discord DM within a minute, with a summary and action items. The run shows up under the workflow's executions with every node's inputs, outputs, and timing.
4. An email from anyone else produces a run that takes the condition's false branch and sends nothing.
5. Open that workflow in the editor, change the prompt, add a node, and publish version 2. The next email runs on version 2. Version 1's runs stay inspectable.
6. DM the Sling bot on Discord: "fix the footer year in site". The same assistant as the web app delegates to Codex and replies in the Discord DM when the task is done. The conversation also appears in the web app.
7. In Supervised mode, the approval DM has Approve and Reject buttons. Approve from an allowlisted Discord account pushes the branch. The same button pressed by anyone else is refused and logged.
8. Web chat still works, now through the installed **Sling Assistant** workflow. Disabling that workflow makes the chat say that no workflow handles chat messages.
9. Restarting the server while a run waits on a timer or an approval doesn't lose it. The run resumes once the timer fires or the approval is decided.
10. The **Website health monitor** template checks a URL on a schedule and sends a Discord alert when it fails.

## Out of scope

- A public template marketplace, package signing, or third-party connector loading. Connectors ship in this repo.
- Gmail OAuth, a GitHub connector, and Slack.
- A JavaScript code node. JSONata only (D29).
- Parallel branches (fork and join). One exec edge per exec output port.
- More than one user. Stage 3 items: Docker or cloud environments, routing across Runners.

## Workflow model (D32)

A workflow definition is JSON:

```jsonc
{
  "schema": "sling.workflow/v1",
  "name": "Important email to Discord",
  "description": "…",
  "nodes": [
    {
      "id": "n_trigger",
      "type": "email.received",          // NodeSpec.type
      "version": 1,                      // NodeSpec.version
      "label": "New email",
      "position": { "x": 0, "y": 0 },
      "config": { "installationId": "…", "folder": "INBOX" }
    }
  ],
  "edges": [
    { "id": "e1", "kind": "exec", "from": { "node": "n_trigger", "port": "next" }, "to": { "node": "n_if", "port": "in" } },
    { "id": "e2", "kind": "data", "from": { "node": "n_trigger", "port": "email" }, "to": { "node": "n_if", "port": "value" } }
  ]
}
```

- **Exec edges** decide what runs next. Every node except a trigger has one exec input called `in`. A node has zero or more exec outputs, for example `next`, `true` and `false`, or `each` and `done`. Each exec output connects to at most one node. Several edges may lead into one node, which is how branches rejoin.
- **Data edges** carry typed values from an output port to an input port. A data input takes at most one edge.
- **Config** holds the node's settings. Any string config field marked `expression` in the node's schema may hold a JSONata expression, written as `={{ <jsonata> }}`. It's evaluated against `{ inputs, trigger, vars, execution }`.
- **Port types** are `any`, `string`, `number`, `boolean`, `json`, `list<T>`, or a named type from the registry (`email`, `discord.message`, `conversation`, `task`, `approval`, `http.response`). Exec ports are drawn separately. Compatibility: same type, either side `any`, target `json` (accepts anything serializable), or `list<T>` into `list<any>`.
- **Error ports.** Every node that can fail gets an implicit exec output `error`. If it's connected, a failure follows it and the node's `error` data output holds `{ message, code }`. If not, the run fails.

A workflow has a **draft** that the editor saves freely, and immutable **versions**. Publishing validates the draft and creates version N+1, which becomes the active version. Runs always record the version they ran.

### Validation

Publishing fails, with errors that point at node and port IDs, when:

- a node type or version is unknown, or its config fails the node's schema
- an edge references a missing node or port, or connects exec to data
- a data edge connects incompatible types, or a data input has two edges
- an exec output has two edges
- a required data input has no edge and no config default
- there is no trigger, or a non-trigger node can't be reached from one
- a cycle exists in exec edges outside a `core.for_each` body

## Execution semantics

A run starts at the trigger node that fired, with that node's outputs. The engine then repeats:

1. Pick the node the current exec edge points at.
2. Resolve its data inputs from the outputs of nodes that already ran in this run. If the source didn't run (another branch), the input is `null`, and a required input fails the node.
3. Evaluate expression config fields.
4. Run the node. It returns one of:
   - `{ exec: "<port>", outputs }`: follow that exec output.
   - `{ wait: … }`: park the run (see Waits).
   - a thrown `NodeError` with `retryable`.
5. Persist the node run and the run's cursor in one transaction.

The run ends when the chosen exec output has no edge, or a `core.return` node runs. Inside a `core.for_each` body, reaching the end of the body moves the loop to its next item, and after the last item the loop leaves through `done`. Loops keep a frame stack in the cursor. Iterations are capped at 1,000 per loop, and a run is capped at 10,000 node runs.

### Durability (D35)

- One pg-boss job drives a run. It runs nodes in a loop and persists after each node, so a crash resumes from the last finished node.
- Runs that share a **concurrency key** (for example a conversation ID) run one at a time, in order. Others run in parallel.
- A node that was mid-run when the process died is re-run if its spec says `idempotent: true`. Otherwise it's marked `failed` with "interrupted, outcome unknown", and the run follows its error port or fails.

### Retries (D33)

Node specs declare `idempotent` and `retry: { maxAttempts, backoffMs }`. The engine retries only when the error is retryable **and** the node is idempotent. Nodes with side effects (send a message, send an email, start a task) default to no automatic retry. Each node run gets an idempotency key, `<runId>:<nodeId>:<iteration>`, which connectors pass along where the service supports it (Discord's message `nonce`, the email `Message-ID`).

### Waits

A node can park the run:

| Wait | Resumes when |
|---|---|
| `timer` | A pg-boss job scheduled with `startAfter` fires |
| `approval` | The approval is decided or expires |
| `task` | The Sling task settles (finished, needs approval, delivered) |
| `event` | A matching Sling event arrives, with a timeout |

Waiting runs hold no job. Resuming enqueues a new job for the run.

## Triggers

A trigger node subscribes its workflow to an event while the workflow is enabled. Subscriptions are rows in `workflow_triggers`, rebuilt whenever a version is published or the workflow is enabled or disabled.

| Trigger | Fires on |
|---|---|
| `core.manual` | The editor's **Run** button, or `POST /api/workflows/:id/run` |
| `core.schedule` | A cron expression, through pg-boss schedules keyed by trigger ID |
| `core.webhook` | `POST /hooks/:token`. The token is random per trigger, and the body becomes the output |
| `app.chat_message` | A message sent in the web app |
| `sling.conversation_update` | A note the server adds to a conversation, for example when a task settles |
| `sling.task_settled` | Any task settling, with the reason |
| `sling.approval_requested` | A new pending approval |
| `discord.message_received` | A Discord message the bot can see, after the connector's filters |
| `email.received` | New mail in an IMAP folder |

## Node catalog

Core, in `packages/workflow` and `apps/server`:

| Type | Ports in | Outputs | Notes |
|---|---|---|---|
| `core.if` | `value: any` | exec `true`, `false` | Config `condition`: JSONata, truthy |
| `core.switch` | `value: any` | exec per case plus `default` | |
| `core.transform` | `value: any` | `result: json` | Config `expression`: JSONata |
| `core.for_each` | `items: list<any>` | exec `each`, `done`; `item`, `index` | |
| `core.wait` | | exec `next` | Duration or until a time |
| `core.set_var` / `core.get_var` | | | Run-scoped variables |
| `core.invoke_workflow` | `input: json` | `output: json` | Runs another workflow's active version as a child run and waits |
| `core.return` | `value: json` | | Ends the run and sets its output |
| `http.request` | `body: json` | `response: http.response` | Idempotent only for GET and HEAD |
| `state.kv_get` / `state.kv_set` | | | Per-workflow key-value store |
| `ai.prompt` | `context: json` | `text: string` | Config: prompt template, model override |
| `ai.extract` | `context: json` | `result: json` | Config: JSON Schema for the output |
| `ai.classify` | `context: json` | exec per label; `label: string` | |
| `human.approval` | `summary: json` | exec `approved`, `rejected`, `expired` | Creates a standalone approval |
| `agent.delegate_coding_task` | `objective: string` | `task: task` | Waits for the task to settle |
| `agent.assistant` | `conversation: conversation`, `message: string` | `reply: string` | Runs the master agent for one turn |
| `state.conversation` | `key: string` | `conversation: conversation` | Finds or creates the conversation for a key such as `discord:<installation>:<channel>` |

Connectors (D28, D34):

| Type | Notes |
|---|---|
| `discord.message_received` | Trigger. Config: installation, DMs only or channel IDs, mention required. Messages from users outside the installation's allowed list are dropped before the trigger fires |
| `discord.send_message` | Channel ID or user ID for a DM, content, optional approval buttons |
| `email.received` | Trigger. Config: installation, folder, optional from and subject filters |
| `email.send` | To, subject, text body |

AI nodes have no tools. `agent.assistant` keeps the Stage 1 tools and limits: the conversation's mode, the machines in the workspace, and nothing else. Untrusted text (emails, Discord messages, task output) is passed as data inside the user turn, never as instructions.

## The assistant as a workflow (D30)

On first start, the server installs and enables the **Sling Assistant** workflow from `workflows/sling-assistant`:

```text
[app.chat_message] ──▶ [state.conversation] ──▶ [agent.assistant]
[sling.conversation_update (bound to this workflow)] ──┘
```

- `POST /api/conversations/:id/messages` stores the message and emits `app.chat_message`. If no enabled workflow subscribes, the server adds an assistant message saying so.
- Each conversation records the workflow that owns it (`conversations.workflow_id`) and an optional external key. Task-settle notes emit `sling.conversation_update` for the owning workflow only, so a Discord conversation's follow-ups go back to Discord.
- Runs for one conversation share its concurrency key, so turns stay in order.
- `agent.assistant` streams deltas to the web app as before, and saves the turn's messages to the conversation.
- The Stage 1 `Agent` class becomes the implementation behind `agent.assistant`. Its in-memory queue and startup recovery give way to the engine's concurrency keys and durable runs.

The **Discord assistant** template:

```text
[discord.message_received] ──▶ [state.conversation key=discord:…] ──▶ [agent.assistant] ──▶ [discord.send_message reply]
[sling.conversation_update] ──────────────────────────────────────────┘
```

## Discord approvals (D31)

- The **Approval notifications** template is `sling.approval_requested` ──▶ `discord.send_message` with `approvalButtons: true`, DMing the configured user.
- Buttons carry `sling:approval:<approvalId>:<approve|reject>`. The Discord connector handles the interaction itself: it checks that the clicking user's ID is in the installation's `approverUserIds`, that the approval belongs to the installation's workspace, and that it's still pending. Then it calls the same `decide` path as the web app.
- The audit entry records `via: "discord"` and the Discord user ID. Refused clicks are audited too, and the user gets an ephemeral "You can't approve this" reply.
- Interactions arrive over the bot's authenticated gateway connection, so there's no public interactions endpoint to secure.

## Connectors (D28, D34)

`packages/connector-sdk` defines a connector: credential fields (marked secret or not), a connection test, node specs, and an optional long-running **event source**. Connectors live in `integrations/<id>` and are registered in the server.

- An **installation** is one configured connector: its encrypted credentials, its non-secret config (allowed users, approvers, default channel), and its status. Credentials never appear in node inputs, outputs, or logs.
- The server's connector runtime starts the event source for each enabled installation that has at least one active trigger. It restarts sources with backoff and reports status (`connected`, `error: …`) to the web app.
- **Discord** uses discord.js with the Guilds, GuildMessages, DirectMessages, and MessageContent intents. The Message Content intent has to be switched on in the Discord developer portal, and the connection test says so if it's missing.
- **Email** uses imapflow (IDLE, with polling as fallback) and nodemailer, with mailparser for parsing. The source stores the highest seen UID per folder in `connector_state`, so a restart doesn't re-fire old mail. On first connect it starts from the newest message and doesn't backfill.

## Data model additions

All owned tables carry `workspace_id` and `owner_id`.

| Table | Holds |
|---|---|
| `workflows` | Name, description, `enabled`, `active_version_id`, `draft` (JSON), `template_key`, timestamps |
| `workflow_versions` | Immutable: workflow, `number`, `definition`, created by, note |
| `workflow_triggers` | Workflow, version, node ID, trigger type, config, installation, webhook token hash |
| `workflow_runs` | Workflow, version, status (`queued`, `running`, `waiting`, `succeeded`, `failed`, `cancelled`), trigger node and payload, `concurrency_key`, cursor (JSON), output, error, parent run, timestamps |
| `node_runs` | Run, node ID and type, iteration, attempt, status, inputs, outputs (both redacted), exec port taken, error, idempotency key, timestamps |
| `run_waits` | Run, node run, wait kind, key (approval ID, task ID, event type), resume-at |
| `connector_installations` | Connector ID, name, credential ID, config (JSON), `enabled`, status, last error |
| `connector_state` | Installation, key, value. For example IMAP UID marks |
| `workflow_kv` | Workflow, key, value |
| `conversations` | Two new columns: `workflow_id`, `external_key` (unique per workspace) |
| `approvals` | `action_id` becomes nullable, plus `kind` (`task_action` or `workflow`), `title`, `payload`, so `human.approval` can reuse the table |

Node run inputs and outputs are kept 30 days, like task events, then pruned.

## API

New routes, all behind the session except webhooks:

```text
GET    /api/workflow-nodes                  node specs for the editor (ports, config JSON Schema)
GET    /api/workflows                       list
POST   /api/workflows                       create blank or { templateKey, bindings }
GET    /api/workflows/:id                   workflow, draft, active version, trigger summary
PUT    /api/workflows/:id/draft             save draft (no validation beyond shape)
POST   /api/workflows/:id/validate          validate draft, returns errors
POST   /api/workflows/:id/publish           { note } -> new version, re-subscribes triggers
PATCH  /api/workflows/:id                   { name, description, enabled }
DELETE /api/workflows/:id
GET    /api/workflows/:id/versions
GET    /api/workflows/:id/versions/:n
POST   /api/workflows/:id/run               manual trigger { input }
GET    /api/workflows/:id/runs              list, newest first
GET    /api/runs/:id                        run plus node runs
POST   /api/runs/:id/cancel
POST   /api/runs/:id/retry                  new run from the same trigger payload
GET    /api/workflows/:id/export            definition JSON
POST   /api/workflows/import                definition JSON -> new workflow (draft)
GET    /api/templates                       bundled templates and what they need
GET    /api/connectors                      available connectors and their credential fields
GET    /api/installations
POST   /api/installations                   { connectorId, name, credentials, config }
PATCH  /api/installations/:id               config, credentials (write-only), enabled
POST   /api/installations/:id/test
DELETE /api/installations/:id
POST   /hooks/:token                        webhook trigger, no session
```

New realtime events: `workflow.updated`, `run.updated`, `node_run.updated`, `installation.updated`.

## Editor

`apps/web`, using React Flow (`@xyflow/react`):

- **Workflows** list: name, enabled toggle, trigger summary, last run status. New from template, blank, or import.
- **Canvas**: a palette grouped by category, drag to add, pan and zoom, box select, copy and paste, undo and redo, delete. Exec ports are drawn as arrows, data ports as dots colored by type. Connecting incompatible ports is blocked as you drag, with the reason in a tooltip.
- **Inspector**: a form generated from the node's config JSON Schema. Strings marked `expression` get a JSONata toggle with the available fields listed. Prompts open in a large editor. Installation fields are a dropdown of matching installations.
- The draft autosaves. **Publish** validates on the server and shows errors on the nodes they belong to. **Run** asks for input JSON when the trigger is manual.
- **Runs** tab: a list of runs, and a run view that colors each node by status. Clicking a node shows its inputs, outputs, error, attempts, and timing.
- **Versions** tab: view any version read-only, restore it as the draft, export JSON.
- **Connectors** page: install, test, enable or disable, and status for each installation.

## Workstreams

The contracts land on `main` first. Then three workstreams run in parallel, each in its own worktree, and merge back.

### W0. Contracts (on main, first)

- `packages/workflow`: the definition schema (zod), the port type registry and compatibility function, `NodeSpec`, `NodeContext`, `NodeResult`, `WaitSpec`, and `TriggerSpec` interfaces.
- `packages/connector-sdk`: `ConnectorDefinition`, `EventSource`, and the installation context.
- `packages/core/src/api.ts`: views and realtime events for workflows, runs, node specs, connectors, and installations.
- `packages/db`: the new tables and one migration.
- `pnpm-workspace.yaml` gains `integrations/*`, and `workflows/` holds template JSON.

### W1. Engine and server

`packages/workflow` validation, traversal, and JSONata evaluation with limits. In `apps/server`: run persistence and the executor, waits and resume, retries, the concurrency key, triggers and subscriptions, core, AI, state, and agent nodes, the workflow REST API, the template installer, the Sling Assistant migration, and Sling event triggers. Tests: pure unit tests in `packages/workflow`, and Postgres-backed engine tests that cover crash and resume, waits, retries, loops, and subworkflows.

### W2. Connectors

`integrations/discord` and `integrations/email` against `connector-sdk`: credential fields, connection tests, node specs, and event sources. Discord approval buttons go through a `decideApproval` callback the server provides. Tests: a fake Discord gateway behind a thin interface, and GreenMail in testcontainers for IMAP and SMTP.

### W3. Editor and connector UI

Everything under **Editor** above, against the API contract. Tests: DOM smoke tests with a mocked API, graph-store unit tests (connect rules, undo and redo), and an editor round trip of load, edit, save, and publish.

### W4. Integration (after merge)

Wire the connectors into the server runtime, write the bundled templates, run the "Done when" list end to end, add an end-to-end test for the email-to-Discord template (GreenMail, a fake Discord gateway, the mock model), and update the docs and threat model.

## Testing

- **Unit:** validation rules, type compatibility, traversal (branches, rejoin, loops, error ports, return), JSONata limits, cursor serialization.
- **Engine, with Postgres:** kill the executor mid-run and resume; a timer wait across a restart; an approval wait; a retry for idempotent nodes and no retry for side-effect nodes; per-key ordering; a child workflow.
- **Connectors:** a Discord message to the trigger output; approval buttons from an allowed and a refused user; IMAP new mail to the trigger exactly once across a restart; an SMTP send.
- **End to end:** the email-to-Discord template, the assistant over Discord with a delegated task, and web chat through the Sling Assistant workflow.

## Budgets

| Measure | Budget |
|---|---|
| Engine overhead per node, excluding the node's own work | under 5 ms at p95 |
| Trigger to first node started (manual, webhook) | under 100 ms at p95 |
| Editor: 200-node workflow pans and drags | 60 fps on a 2022 laptop |
