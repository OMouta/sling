/**
 * The files `sling-ext init` writes. `__ID__` and `__NAME__` are replaced
 * with the extension's ID and name.
 */

export type StarterKind = "connector" | "provider" | "workflows";

const connectorSource = `/**
 * __NAME__: posts messages to an HTTP endpoint, and fires a trigger when the
 * endpoint's content changes. Replace it with your own service.
 */
import {
  defineConnector,
  defineExtension,
  defineNode,
  type EventSourceFactory,
  NodeError,
} from "@sling/connector-sdk";
import { z } from "zod";

const ID = "__ID__";
const CHANGED = \`\${ID}.changed\`;

const credentialsSchema = z.object({
  token: z
    .string()
    .optional()
    .describe("Sent as a bearer token with each request, if the endpoint needs one"),
});
type Credentials = z.infer<typeof credentialsSchema>;

const configSchema = z.object({
  url: z.url().describe("The endpoint to post to and watch, for example https://example.com/hook"),
  pollSeconds: z
    .number()
    .int()
    .min(30)
    .default(300)
    .describe("How often to check the endpoint for changes, in seconds"),
});
type Config = z.infer<typeof configSchema>;

function headers(credentials: Credentials): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (credentials.token) h.authorization = \`Bearer \${credentials.token}\`;
  return h;
}

async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

const postConfig = z.object({
  installationId: z.string().min(1).describe("Installation to post with"),
  message: z.string().min(1).describe("Text to send"),
});

const post = defineNode({
  type: \`\${ID}.post\`,
  version: 1,
  title: "Post a message",
  description: "POSTs { message } as JSON to the installation's URL.",
  category: "action",
  configSchema: postConfig,
  expressionFields: ["message"],
  installationFields: ["installationId"],
  inputs: [],
  outputs: [{ name: "status", type: "number", label: "HTTP status" }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  // Posting twice sends two messages, so Sling never retries it on its own.
  idempotent: false,
  async run(ctx, { config: raw }) {
    const config = postConfig.parse(raw);
    const installation = await ctx.installation<Credentials, Config>(config.installationId);
    const res = await fetch(installation.config.url, {
      method: "POST",
      headers: headers(installation.credentials),
      body: JSON.stringify({ message: config.message }),
      signal: ctx.signal,
    });
    if (!res.ok) {
      throw new NodeError(\`The endpoint answered \${res.status}\`, { code: "http_error" });
    }
    return { exec: "next", outputs: { status: res.status } };
  },
});

const changedConfig = z.object({
  installationId: z.string().min(1).describe("Installation whose endpoint is watched"),
});

const changed = defineNode({
  type: CHANGED,
  version: 1,
  title: "Endpoint changed",
  description: "Fires when the body at the installation's URL changes.",
  category: "trigger",
  configSchema: changedConfig,
  installationFields: ["installationId"],
  inputs: [],
  outputs: [{ name: "body", type: "string", label: "Body" }],
  execInput: false,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  trigger: {
    event: CHANGED,
    match(event, config) {
      if (event.installationId !== config.installationId) return null;
      return { outputs: { body: (event.payload as { body: string }).body } };
    },
  },
});

/** Polls the URL, and emits an event when the body's hash changes. */
const source: EventSourceFactory<Credentials, Config> = {
  async start(ctx) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(ctx.config.url, {
          headers: headers(ctx.credentials),
          signal: ctx.signal,
        });
        const body = await res.text();
        const digest = await sha256(body);
        const previous = await ctx.state.get("digest");
        if (previous !== null && previous !== digest) {
          await ctx.emit({ type: CHANGED, payload: { body }, dedupeKey: \`\${previous}:\${digest}\` });
        }
        await ctx.state.set("digest", digest);
        ctx.setStatus("connected", \`Watching \${ctx.config.url}\`);
      } catch (error) {
        if (ctx.signal.aborted) return;
        ctx.setStatus("error", error instanceof Error ? error.message : String(error));
      }
      if (!ctx.signal.aborted) timer = setTimeout(poll, ctx.config.pollSeconds * 1000);
    };
    void poll();
    return {
      async stop() {
        clearTimeout(timer);
      },
    };
  },
};

const connector = defineConnector<Credentials, Config>({
  id: ID,
  name: "__NAME__",
  description: "Posts messages to an HTTP endpoint and fires when its content changes.",
  credentialsSchema,
  secretFields: ["token"],
  configSchema,
  async test({ credentials, config, signal }) {
    try {
      const res = await fetch(config.url, { method: "HEAD", headers: headers(credentials), signal });
      return res.ok
        ? { ok: true, detail: \`\${config.url} answered \${res.status}.\` }
        : { ok: false, error: \`\${config.url} answered \${res.status}.\` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  nodes: [post, changed],
  source,
});

export default defineExtension({ connectors: [connector] });
`;

const connectorTest = `import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionDefinition, NodeContext } from "@sling/connector-sdk";

// Runs against the built bundle, as Sling does. Run \`sling-ext build\` first.
const bundle = new URL("../extension.mjs", import.meta.url).href;
const { default: extension } = (await import(bundle)) as { default: ExtensionDefinition };

test("describes the connector and its nodes", () => {
  const [connector] = extension.describe().connectors;
  assert.equal(connector?.id, "__ID__");
  assert.deepEqual(
    connector?.nodes.map((n) => n.type),
    ["__ID__.post", "__ID__.changed"],
  );
});

test("post sends the message as JSON", async () => {
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const post = extension.connectors[0]?.nodes.find((n) => n.type === "__ID__.post");
  const ctx = {
    signal: AbortSignal.timeout(5000),
    installation: async () => ({
      id: "ins_1",
      connectorId: "__ID__",
      name: "Test",
      credentials: {},
      config: { url: "https://example.com/hook", pollSeconds: 300 },
    }),
  } as unknown as NodeContext;
  const result = await post?.run?.(ctx, {
    inputs: {},
    config: { installationId: "ins_1", message: "hi" },
  });
  assert.deepEqual(result, { exec: "next", outputs: { status: 204 } });
  assert.deepEqual(calls, [{ url: "https://example.com/hook", body: '{"message":"hi"}' }]);
});
`;

const providerSource = `/**
 * __NAME__: starts Sling sandboxes on a platform with a simple HTTP API.
 * Replace the requests with your platform's.
 *
 * Sling calls create() with a SandboxSpec. Start spec.image with spec.env as
 * its environment: those variables are how the sandbox's Runner pairs with
 * Sling, and they include its secrets, so never log them. Attach spec.labels
 * so list() can find the sandbox again for the orphan sweep.
 */
import {
  defineConnector,
  defineExtension,
  type ExecutionProvider,
  type ProviderContext,
  SANDBOX_LABELS,
} from "@sling/connector-sdk";
import { z } from "zod";

const credentialsSchema = z.object({
  apiToken: z.string().min(1).describe("API token for the platform"),
});
type Credentials = z.infer<typeof credentialsSchema>;

const configSchema = z.object({
  apiUrl: z.url().describe("The platform's API, for example https://api.example.com"),
  image: z.string().min(1).describe("Sandbox image the platform runs, from a registry it can pull"),
  controlPlaneUrl: z
    .url()
    .optional()
    .describe("Sling's URL as sandboxes reach it. Empty uses the server's public URL"),
  cpus: z.number().positive().optional().describe("CPUs per sandbox"),
  memoryMb: z.number().int().positive().optional().describe("Memory per sandbox, in MB"),
});
type Config = z.infer<typeof configSchema>;

type Ctx = ProviderContext<Credentials, Config>;

interface RemoteSandbox {
  id: string;
  labels?: Record<string, string>;
}

async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(new URL(path, ctx.config.apiUrl), {
    method,
    headers: {
      authorization: \`Bearer \${ctx.credentials.apiToken}\`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: ctx.signal,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(\`The platform answered \${method} \${path} with \${res.status}\`);
  }
  return res;
}

const provider: ExecutionProvider<Credentials, Config> = {
  async create(ctx, spec) {
    const res = await call(ctx, "POST", "/sandboxes", {
      image: spec.image || ctx.config.image,
      env: spec.env,
      labels: spec.labels,
      cpus: spec.cpus ?? ctx.config.cpus,
      memoryMb: spec.memoryMb ?? ctx.config.memoryMb,
      lifetimeSeconds: spec.lifetimeSeconds,
    });
    if (res.status === 404) throw new Error("The platform has no /sandboxes endpoint");
    const created = (await res.json()) as RemoteSandbox;
    return { externalId: created.id, detail: \`Sandbox \${created.id}\` };
  },

  async destroy(ctx, externalId) {
    // A sandbox that's already gone counts as destroyed, so 404 is fine.
    await call(ctx, "DELETE", \`/sandboxes/\${encodeURIComponent(externalId)}\`);
  },

  async list(ctx) {
    const res = await call(ctx, "GET", "/sandboxes");
    const all = res.status === 404 ? [] : ((await res.json()) as RemoteSandbox[]);
    return all
      .filter((s) => s.labels?.[SANDBOX_LABELS.sandbox])
      .map((s) => ({ externalId: s.id, sandboxId: s.labels?.[SANDBOX_LABELS.sandbox] ?? null }));
  },
};

const connector = defineConnector<Credentials, Config>({
  id: "__ID__",
  name: "__NAME__",
  description: "Runs coding tasks in sandboxes on your platform.",
  credentialsSchema,
  secretFields: ["apiToken"],
  configSchema,
  async test({ credentials, config, signal }) {
    try {
      const res = await fetch(new URL("/sandboxes", config.apiUrl), {
        headers: { authorization: \`Bearer \${credentials.apiToken}\` },
        signal,
      });
      return res.ok
        ? { ok: true, detail: "The platform accepted the token." }
        : { ok: false, error: \`The platform answered \${res.status}.\` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  nodes: [],
  executionProvider: provider,
});

export default defineExtension({ connectors: [connector] });
`;

const providerTest = `import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionDefinition, ProviderContext } from "@sling/connector-sdk";

// Runs against the built bundle, as Sling does. Run \`sling-ext build\` first.
const bundle = new URL("../extension.mjs", import.meta.url).href;
const { default: extension } = (await import(bundle)) as { default: ExtensionDefinition };

test("describes a sandbox provider", () => {
  const [connector] = extension.describe().connectors;
  assert.equal(connector?.isExecutionProvider, true);
});

test("create sends the image, environment, and labels", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "sb-1" });
  }) as typeof fetch;
  const provider = extension.connectors[0]?.executionProvider;
  const ctx = {
    credentials: { apiToken: "t" },
    config: { apiUrl: "https://api.example.com", image: "sling-sandbox:latest" },
    signal: AbortSignal.timeout(5000),
  } as unknown as ProviderContext<unknown, unknown>;
  const created = await provider?.create(ctx, {
    sandboxId: "sbx_1",
    workspaceId: "ws_1",
    image: "",
    env: { SLING_URL: "https://sling.example.com" },
    labels: { "sling.sandbox": "sbx_1", "sling.workspace": "ws_1" },
    lifetimeSeconds: 3600,
  });
  assert.equal(created?.externalId, "sb-1");
  assert.deepEqual((bodies[0] as { labels: unknown }).labels, {
    "sling.sandbox": "sbx_1",
    "sling.workspace": "ws_1",
  });
});
`;

const workflowsTemplate = `{
  "key": "say-hello",
  "name": "Say hello in Discord",
  "description": "Posts a message to Discord when you press Run. Pick your Discord installation when you install it.",
  "builtIn": false,
  "bindings": [
    {
      "placeholder": "$discord",
      "connectorId": "discord",
      "label": "Discord bot"
    }
  ]
}
`;

const workflowsWorkflow = `{
  "schema": "sling.workflow/v1",
  "name": "Say hello in Discord",
  "description": "Posts a message to Discord when you press Run.",
  "nodes": [
    {
      "id": "run",
      "type": "core.manual",
      "version": 1,
      "position": { "x": 0, "y": 0 },
      "config": {},
      "label": "Run"
    },
    {
      "id": "send",
      "type": "discord.send_message",
      "version": 1,
      "position": { "x": 320, "y": 0 },
      "config": {
        "installationId": "$discord",
        "content": "Hello from a workflow package."
      },
      "label": "Say hello"
    }
  ],
  "edges": [
    {
      "id": "x_run_send",
      "kind": "exec",
      "from": { "node": "run", "port": "next" },
      "to": { "node": "send", "port": "in" }
    }
  ]
}
`;

const workflowsTest = `import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../templates/", import.meta.url);

test("every binding is used, and every placeholder has a binding", () => {
  for (const key of readdirSync(root)) {
    const template = JSON.parse(readFileSync(new URL(\`\${key}/template.json\`, root), "utf8"));
    const workflow = readFileSync(new URL(\`\${key}/workflow.json\`, root), "utf8");
    const declared = template.bindings.map((b: { placeholder: string }) => b.placeholder).sort();
    const used = [...new Set(workflow.match(/"\\$[a-z][a-z0-9_]*"/g) ?? [])]
      .map((p) => JSON.parse(p))
      .sort();
    assert.deepEqual(used, declared, key);
  }
});
`;

function manifest(kind: StarterKind): string {
  const base: Record<string, unknown> = {
    format: "sling.extension/v1",
    id: "__ID__",
    name: "__NAME__",
    version: "0.1.0",
    description: {
      connector: "Posts to an HTTP endpoint and fires when its content changes.",
      provider: "Runs Sling sandboxes on your platform.",
      workflows: "Workflow templates for Sling.",
    }[kind],
    publisher: "__PUBLISHER__",
    sdk: "^1.0.0",
  };
  if (kind !== "workflows") base.main = "extension.mjs";
  base.templates = kind === "workflows" ? ["say-hello"] : [];
  base.icon = "icon.svg";
  base.permissions =
    kind === "connector"
      ? { network: { hosts: [], configHosts: ["url"] } }
      : kind === "provider"
        ? { network: { hosts: [], configHosts: ["apiUrl"] }, sandboxes: true }
        : {};
  base.requires = kind === "workflows" ? { extensions: {}, connectors: ["discord"] } : {};
  base.license = "Apache-2.0";
  return `${JSON.stringify(base, null, 2)}\n`;
}

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 12h8M12 8v8"/></svg>
`;

function readme(kind: StarterKind): string {
  const what = {
    connector:
      "A connector with a **Post a message** action, an **Endpoint changed** trigger fed by an event source, and a connection test.",
    provider: "An execution provider that starts Sling sandboxes through an HTTP API.",
    workflows:
      "A workflow package with one template, **Say hello in Discord**. It has no code, so it runs nothing and asks for no permissions.",
  }[kind];
  const build =
    kind === "workflows"
      ? `\`\`\`sh
sling-ext check          # checks the manifest and templates
node --test              # runs test/
sling-ext pack           # writes dist/__ID__-0.1.0.slx
\`\`\``
      : `\`\`\`sh
sling-ext build          # bundles src/index.ts into extension.mjs
sling-ext check          # runs the bundle the way Sling does and lists what it adds
node --test              # runs test/ against the bundle
sling-ext pack           # writes dist/__ID__-0.1.0.slx
\`\`\``;
  return `# __NAME__

${what}

## Develop

${build}

The project needs no dependencies: \`sling-ext\` brings \`@sling/connector-sdk\` and \`zod\` and bundles its own copies, and \`tsconfig.json\` points your editor at them. Add other packages with npm as usual, and the build bundles them in.

## Sign and publish

\`\`\`sh
sling-ext keygen --out ~/.sling/signing-key.json --publisher "__PUBLISHER__"
sling-ext pack --sign ~/.sling/signing-key.json
sling-ext catalog dist --name "__PUBLISHER__ extensions"
\`\`\`

Upload \`dist/\` to any static HTTPS host, then add \`<url>/catalog.json\` in Sling under **Extensions → Sources**. Keep the key out of this folder and out of git.
`;
}

const gitignore = `node_modules/
dist/
extension.mjs
*.key.json
signing-key.json
`;

export function packageJson(id: string): string {
  return `${JSON.stringify(
    {
      name: id,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    },
    null,
    2,
  )}\n`;
}

/** Every file a starter has, by path, before placeholders are filled in. */
export function starterFiles(kind: StarterKind): Record<string, string> {
  const files: Record<string, string> = {
    "sling-extension.json": manifest(kind),
    "README.md": readme(kind),
    "icon.svg": icon,
    ".gitignore": gitignore,
  };
  if (kind === "connector") {
    files["src/index.ts"] = connectorSource;
    files["test/extension.test.ts"] = connectorTest;
  } else if (kind === "provider") {
    files["src/index.ts"] = providerSource;
    files["test/extension.test.ts"] = providerTest;
  } else {
    files["templates/say-hello/template.json"] = workflowsTemplate;
    files["templates/say-hello/workflow.json"] = workflowsWorkflow;
    files["test/templates.test.ts"] = workflowsTest;
  }
  return files;
}
