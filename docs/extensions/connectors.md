# Writing a connector

A connector gives workflows a service to talk to: credentials and settings for each installation, a connection test, action nodes, and triggers fed by an event source. The [ntfy extension](../../extensions/ntfy) is a complete example, with a publish action, a message trigger over a WebSocket, and tests against fakes.

Start a project with the CLI:

```sh
sling-ext init acme-crm
cd acme-crm
sling-ext build && sling-ext check
```

`init` writes a working connector with an action, a trigger, an event source, and a test. The rest of this page explains each part.

## The entry point

`src/index.ts` default-exports `defineExtension`, with every connector the extension adds:

```ts
import { defineConnector, defineExtension } from "@sling/connector-sdk";
import { z } from "zod";

const credentialsSchema = z.object({
  apiKey: z.string().min(1).describe("API key from Settings > API in Acme"),
});
const configSchema = z.object({
  baseUrl: z.url().default("https://api.acme.test").describe("Your Acme API"),
});
type Credentials = z.infer<typeof credentialsSchema>;
type Config = z.infer<typeof configSchema>;

const connector = defineConnector<Credentials, Config>({
  id: "acme-crm",
  name: "Acme CRM",
  description: "Contacts and deals in Acme.",
  setupHelp: "Create an API key under Settings > API in Acme.",
  credentialsSchema,
  secretFields: ["apiKey"],
  configSchema,
  async test({ credentials, config, signal }) {
    const res = await fetch(`${config.baseUrl}/me`, {
      headers: { authorization: `Bearer ${credentials.apiKey}` },
      signal,
    });
    return res.ok ? { ok: true, detail: "Acme accepted the key." } : { ok: false, error: `Acme answered ${res.status}.` };
  },
  nodes: [createContact, dealWon],
  source: dealEvents,
});

export default defineExtension({ connectors: [connector] });
```

`build` bundles this file and everything it imports into one ES module. When Sling installs the package, it imports that module in the extension's process and calls `describe()`, which turns every zod schema into JSON Schema and returns what the extension adds. Sling stores that description, so it can list the extension's nodes later without starting the process.

### Names

Everything an extension adds is named after its ID, which is set in the manifest:

- A connector's ID is the extension's ID, such as `acme-crm`, or starts with it and a dot, such as `acme-crm.sandbox`.
- Every node type and trigger event starts with the ID and a dot: `acme-crm.create_contact`, `acme-crm.deal_won`.

Sling refuses a package that adds anything else, so two extensions can't collide or replace a built-in node.

## Credentials and config

Each installation of a connector has two parts, and both are zod schemas:

- **Credentials** are stored encrypted and never sent back to the browser. List the keys to show as password fields in `secretFields`.
- **Config** holds plain settings, such as a server URL or a default channel. It's visible in the web app.

Sling renders the installation form from the JSON Schema of each. Give every field a `.describe()`, which becomes its help text, and a `.meta({ title })` when the key doesn't read well as a label. A form sends an empty string for an empty field, so allow `""` on optional strings, or give them a default.

A config field that holds a URL can let the extension reach that URL's host. Name the field in the manifest's `network.configHosts`. See [manifest.md](manifest.md#network).

`test` runs when someone presses **Test** on an installation. It gets that installation's credentials and config, and has 30 seconds. Return `{ ok: true, detail }` or `{ ok: false, error }` with a message that says what to fix. Don't throw for an expected failure such as a wrong password.

## Nodes

`defineNode` builds a node with its config type inferred from its schema:

```ts
import { defineNode, NodeError } from "@sling/connector-sdk";

const createConfig = z.object({
  installationId: z.string().min(1).describe("Acme installation to use"),
  email: z.string().describe("The contact's email address"),
  name: z.string().default("").describe("Their name"),
});

export const createContact = defineNode({
  type: "acme-crm.create_contact",
  version: 1,
  title: "Create Acme contact",
  description: "Adds a contact to Acme CRM.",
  category: "action",
  configSchema: createConfig,
  expressionFields: ["email", "name"],
  installationFields: ["installationId"],
  inputs: [],
  outputs: [{ name: "contactId", type: "string", label: "Contact ID" }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: false,
  async run(ctx, { config: raw }) {
    const config = createConfig.parse(raw);
    const { credentials, config: settings } = await ctx.installation<Credentials, Config>(
      config.installationId,
    );
    const res = await fetch(`${settings.baseUrl}/contacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${credentials.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ email: config.email, name: config.name }),
      signal: ctx.signal,
    });
    if (res.status === 409) throw new NodeError("That contact already exists", { code: "duplicate" });
    if (!res.ok) throw new NodeError(`Acme answered ${res.status}`, { code: "acme_error", retryable: res.status >= 500 });
    const contact = (await res.json()) as { id: string };
    return { exec: "next", outputs: { contactId: contact.id } };
  },
});
```

| Field | Meaning |
|---|---|
| `type`, `version` | The node's name and version. Bump the version when a change would break saved workflows, and keep the old one registered |
| `category` | `trigger`, `action`, `logic`, `data`, `ai`, `state`, `human`, `agent`, or `composition`. It groups the node in the editor's palette |
| `configSchema` | The settings form. `.meta({ widget: "textarea" })` gives a multi-line box, `.meta({ widget: "json" })` a JSON editor |
| `expressionFields` | Config keys that may hold a JSONata expression, `={{ … }}`. Sling evaluates them before calling `run` |
| `installationFields` | Config keys that hold an installation ID, so the editor offers a picker and templates can bind them |
| `inputs`, `outputs` | Data ports. A config key named after an input is that input's default |
| `execInput`, `execOutputs` | Exec ports. Every node except a trigger has the exec input. Every non-trigger node also gets an `error` exec output and data output automatically |
| `idempotent` | Whether running it twice with the same inputs is safe. Sling retries only idempotent nodes, and only for errors marked `retryable` |
| `retry` | `{ maxAttempts, backoffMs }` for idempotent nodes |
| `assistant` | `{ sends, summary? }` lets the assistant call the node from chat, as a tool named after its type with dots as underscores (`acme.create_contact` becomes `acme_create_contact`). Set `sends: true` when it reaches outside Sling: then it's refused in Read-only and asks in the chat first in Supervised and Auto. `summary`, such as `"Post {text}"`, is filled from the call's values for the approval and the audit. Only nodes with an exec input that finish without waiting or resuming can be tools, and the manifest needs `sdk: "^1.1.0"`. The install dialog lists these nodes |

Port types are `any`, `string`, `number`, `boolean`, `json`, `list<T>`, and Sling's named types: `email`, `discord.message`, `conversation`, `task`, `approval`, and `http.response`. Extensions can't add named types, so pass structured values as `json`.

### What `run` gets

`run(ctx, { inputs, config })` gets the node's resolved inputs and its config, with expressions evaluated. Parse the config with your schema inside `run`: it arrives as plain JSON, and the parse applies your defaults.

The context has:

| Field | Holds |
|---|---|
| `runId`, `nodeId`, `nodeRunId`, `workflowId`, `workspaceId`, `ownerId` | Where the call comes from |
| `iteration`, `attempt` | The loop iteration, from 0, and the try, from 1 |
| `idempotencyKey` | `<runId>:<nodeId>:<iteration>`. Send it to services that dedupe requests |
| `signal` | Aborted when the run is cancelled or the 10-minute deadline passes. Pass it to `fetch` |
| `log` | `info`, `warn`, and `error`. Lines go to the server log and the extension's details. Never log credentials |
| `installation(id)` | The decrypted credentials and config of an installation |

`installation(id)` works only for installations of this extension's own connectors, in the run's workspace. Asking for any other installation fails. `ctx.services`, which built-in nodes use for server internals, is undefined in an extension.

Throw `NodeError` to fail the node with a message and a code. `retryable: true` marks a temporary failure. Return `{ exec: "<port>", outputs }` to continue, or `{ wait, outputs }` to park the run until a timer, an approval, a task, or an event, and handle the wake-up in `resume`.

## Triggers

A trigger is a node with `execInput: false` and a `trigger`:

```ts
export const dealWon = defineNode({
  type: "acme-crm.deal_won",
  version: 1,
  title: "Deal won",
  description: "Fires when a deal in Acme is marked won.",
  category: "trigger",
  configSchema: z.object({
    installationId: z.string().min(1).describe("Acme installation to watch"),
    minAmount: z.number().default(0).describe("Only deals worth at least this much"),
  }),
  installationFields: ["installationId"],
  inputs: [],
  outputs: [{ name: "deal", type: "json", label: "Deal" }],
  execInput: false,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  trigger: {
    event: "acme-crm.deal_won",
    match(event, config) {
      if (event.installationId !== config.installationId) return null;
      const deal = event.payload as { id: string; amount: number };
      if (deal.amount < config.minAmount) return null;
      return { outputs: { deal }, concurrencyKey: `acme-crm:${deal.id}` };
    },
  },
});
```

When an event of that type arrives, Sling calls `match` for every enabled workflow that uses the trigger. Return the trigger's outputs to start a run, or `null` to skip. Runs that share a `concurrencyKey` run one at a time, in order.

`match` runs in the extension's process and has 1 second. Keep it to filtering. Check `event.installationId` against the trigger's installation, or one installation's events will start another's workflows.

## Event sources

An event source watches the service for one installation and emits events for triggers. Sling runs one for each enabled installation that an enabled workflow's trigger uses, with the installation's credentials and config. It restarts the source when the installation's settings change, and stops it when no workflow needs it:

```ts
import type { EventSourceFactory } from "@sling/connector-sdk";

export const dealEvents: EventSourceFactory<Credentials, Config> = {
  async start(ctx) {
    const timer = setInterval(async () => {
      const since = (await ctx.state.get("cursor")) ?? "";
      const res = await fetch(`${ctx.config.baseUrl}/deals/won?since=${since}`, {
        headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
        signal: ctx.signal,
      });
      const { deals, cursor } = (await res.json()) as { deals: { id: string }[]; cursor: string };
      for (const deal of deals) {
        await ctx.emit({ type: "acme-crm.deal_won", payload: deal, dedupeKey: deal.id });
      }
      await ctx.state.set("cursor", cursor);
      ctx.setStatus("connected", "Watching won deals");
    }, 60_000);
    return { stop: async () => clearInterval(timer) };
  },
};
```

| Context field | Does |
|---|---|
| `credentials`, `config` | The installation's |
| `signal` | Aborted when Sling stops the source |
| `emit({ type, payload, dedupeKey })` | Hands an event to the workflow engine. The type must be one of this connector's trigger events. A repeat `dedupeKey` is ignored, so emitting the same event twice after a reconnect is safe |
| `state.get(key)`, `state.set(key, value)` | A small string store per installation, kept across restarts. Use it for cursors |
| `setStatus(status, detail)` | `connecting`, `connected`, or `error`, shown on the installation. `error` also restarts the source, as below |
| `approvals.decide(decision)` | Approves or rejects a pending approval for an outside user. Needs the `approvals` permission |
| `log` | As in nodes |

`start` has 30 seconds. Return quickly and do the long work in the background.

When a source reports `error`, or `start` throws, or the extension's process dies, Sling stops the source, shows the error on the installation, and starts it again after 1 second, then 2, 4, and so on up to 5 minutes. Reporting `connected` resets that delay. So report `error` when the source can't do its job, such as a rejected token or a server that won't accept the connection, and let Sling retry. A long-lived connection that drops now and then is routine: reconnect inside the source and report `connecting` meanwhile, so the installation doesn't flash an error.

The ntfy source does exactly that. It keeps one WebSocket for every watched topic, drops a connection that's silent for 2 minutes, reconnects in place after a drop, reports `error` only when it can't subscribe at all, and catches up from the last message's time after each reconnect.

## The network

An extension has the global `fetch` and `WebSocket` and no other network. Sling routes both through the server, which checks each request against the manifest's network permission:

- The host must be in `network.hosts`, or be the host of a URL in one of the installation config fields named in `network.configHosts`.
- `https:` and `wss:` only. Plain `http:` and `ws:` work only with `localNetwork`, and only to private addresses.
- Without `localNetwork`, names that resolve to loopback or private addresses are refused.
- Redirects are followed by the server, up to 5, and each hop is checked again.
- Request and response bodies are capped at 10 MB. A request times out after 60 seconds unless you pass a shorter `signal`.
- WebSocket messages are capped at 1 MB, and an extension can hold 16 sockets open at once.

A refused `fetch` rejects with a `TypeError` whose message says why, and a refused WebSocket fires an `error` event with the reason. Show that reason to the user, in a `NodeError` or with `setStatus`.

Use the standard APIs only: `new WebSocket(url, protocols)`, with no Node-specific options such as custom headers. Services that want a token on a WebSocket usually accept it in the URL. ntfy takes an `auth` query parameter, for example.

Read hosts and URLs from the installation's config, not from module-level constants, so a self-hosted server works once its config field is named in `configHosts`.

## What isn't there

The process runs Node, so the globals you'd expect are there: `fetch`, `WebSocket`, `URL`, `TextEncoder`, `crypto.subtle`, `structuredClone`, timers, and `Buffer`. These aren't:

- Node's file, process, worker, socket, and DNS modules. Importing `node:fs` works, but every call is refused. `sling-ext build` warns when a bundle imports one.
- `eval` and `new Function`. Libraries that build code from strings need a mode without it. zod switches to one by itself.
- Environment variables. `process.env` is empty. Put settings in the connector's config.
- Packages that need native addons.

## Testing

Test your connector's code directly, with fakes for the service. The ntfy tests run its publish node against a local HTTP server and its source against a fake socket, and its live test publishes to ntfy.sh for real.

Then run the bundle the way Sling does:

```sh
sling-ext build
sling-ext check
```

`check` unpacks the package into a temporary folder, runs the bundle there with Sling's restrictions, and lists what it adds and the permissions it asks for. It fails on anything Sling would refuse, such as a node named outside the extension's ID, or a `configHosts` field no connector has. The starter's `test/extension.test.ts` imports the built bundle the same way, so `node --test` tests what you ship.
