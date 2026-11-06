/**
 * Extensions end to end: real Postgres, the control plane in-process, a local
 * HTTP server that serves catalogs and stands in for the service the test
 * extensions talk to, and packages built and signed by the tests.
 *
 * Needs Docker. Extension code runs in the test process unless
 * SLING_TEST_EXTENSION_RUNTIME=process.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionKind, SDK_VERSION } from "@sling/connector-sdk";
import type {
  CatalogView,
  ConnectorView,
  DiscoverEntryView,
  ExtensionDetailView,
  ExtensionPreview,
  ExtensionView,
  InstallationView,
  PublisherView,
  RunDetailView,
  RunView,
  ServerEvent,
} from "@sling/core";
import { schema } from "@sling/db";
import { readPackage, type SigningKey, writePackage } from "@sling/extension-package";
import type { TemplateView } from "@sling/workflow";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { DIGEST_MISMATCH } from "../src/extensions/service.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { type BuiltExtension, buildExtension, generateSigningKey } from "./fixtures/extensions.ts";
import { InProcessRuntime, testRuntime } from "./fixtures/in-process-runtime.ts";
import { fakeConnector, testNodes } from "./fixtures/nodes.ts";

vi.setConfig({ testTimeout: 60_000 });

const SECRET = "extensions-test-secret-key-long-enough";
const ORIGIN = "http://sling.test";
const TOKEN = "chat-token-5f1e";
const inProcess = process.env.SLING_TEST_EXTENSION_RUNTIME !== "process";

// ---------------------------------------------------------------- test extensions

/**
 * A connector with a trigger fed by a long-poll event source, an action that
 * posts to the installation's server, and a connection test.
 */
function chatSource(id: string, name = "Acme chat"): string {
  return `
import { defineConnector, defineExtension, defineNode, NodeError } from "@sling/connector-sdk";
import { z } from "zod";

const message = defineNode({
  type: "${id}.message", version: 1, title: "Chat message", description: "A message on the topic.",
  category: "trigger",
  configSchema: z.object({
    installationId: z.string().describe("Installation."),
    contains: z.string().default("").describe("Only messages with this text."),
  }),
  installationFields: ["installationId"],
  inputs: [], outputs: [{ name: "text", type: "string" }],
  execInput: false, execOutputs: [{ name: "next" }], idempotent: true,
  trigger: {
    event: "${id}.message",
    match: async (e, config) => {
      const p = e.payload;
      if (config.contains && !p.text.includes(config.contains)) return null;
      return { outputs: { text: p.text } };
    },
  },
});

const send = defineNode({
  type: "${id}.send", version: 1, title: "Send chat message", description: "Posts a message.",
  category: "action",
  configSchema: z.object({
    installationId: z.string().describe("Installation."),
    text: z.string().default("").describe("Text, unless the text input is wired."),
  }),
  installationFields: ["installationId"],
  inputs: [{ name: "text", type: "string" }], outputs: [{ name: "status", type: "number" }],
  execInput: true, execOutputs: [{ name: "next" }], idempotent: false,
  run: async (ctx, { config, inputs }) => {
    const inst = await ctx.installation(config.installationId);
    const text = typeof inputs.text === "string" ? inputs.text : config.text;
    const res = await fetch(new URL("/sent", inst.config.server), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + inst.credentials.token },
      body: JSON.stringify({ text, topic: inst.config.topic }),
    });
    if (!res.ok) throw new NodeError("send failed: " + res.status, { code: "send_failed" });
    return { exec: "next", outputs: { status: res.status } };
  },
});

export default defineExtension({
  connectors: [
    defineConnector({
      id: "${id}", name: ${JSON.stringify(name)}, description: "Chat for tests.",
      credentialsSchema: z.object({ token: z.string().min(1).describe("Token.") }),
      secretFields: ["token"],
      configSchema: z.object({
        server: z.string().describe("Server URL."),
        topic: z.string().default("main").describe("Topic."),
      }),
      test: async ({ config }) => {
        const res = await fetch(new URL("/ping", config.server));
        return res.ok ? { ok: true, detail: "pong" } : { ok: false, error: "no pong" };
      },
      nodes: [message, send],
      source: {
        start: async (ctx) => {
          let cursor = 0;
          const loop = async () => {
            while (!ctx.signal.aborted) {
              try {
                const url = new URL("/events", ctx.config.server);
                url.searchParams.set("topic", ctx.config.topic);
                url.searchParams.set("after", String(cursor));
                const res = await fetch(url, { signal: ctx.signal });
                for (const e of await res.json()) {
                  cursor = e.seq;
                  await ctx.emit({ type: "${id}.message", payload: { text: e.text }, dedupeKey: String(e.seq) });
                }
              } catch {
                if (ctx.signal.aborted) return;
                await new Promise((r) => setTimeout(r, 100));
              }
            }
          };
          ctx.setStatus("connected");
          void loop();
          return { stop: async () => {} };
        },
      },
    }),
  ],
});
`;
}

/** One action that echoes its config, with no network. */
function echoSource(id: string, opts: { connectorId?: string; sdkTag?: string } = {}): string {
  const connectorId = opts.connectorId ?? id;
  return `
import { defineConnector, defineExtension, defineNode } from "@sling/connector-sdk";
import { z } from "zod";
export default defineExtension({
  connectors: [
    defineConnector({
      id: "${connectorId}", name: "${id} echo", description: "Echoes.${opts.sdkTag ?? ""}",
      credentialsSchema: z.object({}), secretFields: [], configSchema: z.object({}),
      test: async () => ({ ok: true }),
      nodes: [
        defineNode({
          type: "${id}.echo", version: 1, title: "Echo", description: "Returns its value.",
          category: "action",
          configSchema: z.object({ value: z.string().default("").describe("Value.") }),
          inputs: [], outputs: [{ name: "value", type: "string" }],
          execInput: true, execOutputs: [{ name: "next" }], idempotent: true,
          run: async (_ctx, { config }) => ({ exec: "next", outputs: { value: config.value } }),
        }),
      ],
    }),
  ],
});
`;
}

// ---------------------------------------------------------------- local server

interface Sent {
  text: string;
  topic: string;
  auth: string | undefined;
}

/** Serves catalog directories and plays the chat service the test extensions talk to. */
class LocalServer {
  readonly root: string;
  readonly sent: Sent[] = [];
  readonly hits = new Map<string, number>();
  notModified = 0;
  readonly #events: { seq: number; topic: string; text: string }[] = [];
  readonly #waiters = new Set<() => void>();
  #server: Server | null = null;
  port = 0;

  constructor(root: string) {
    this.root = root;
  }

  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((ok) => this.#server?.listen(0, "127.0.0.1", ok));
    const addr = this.#server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
  }

  async stop(): Promise<void> {
    for (const w of this.#waiters) w();
    this.#server?.closeAllConnections();
    await new Promise((ok) => this.#server?.close(ok));
  }

  publish(topic: string, text: string): void {
    this.#events.push({ seq: this.#events.length + 1, topic, text });
    for (const w of [...this.#waiters]) w();
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.base);
    this.hits.set(url.pathname, (this.hits.get(url.pathname) ?? 0) + 1);
    if (url.pathname === "/ping") return res.end("pong");
    if (url.pathname === "/sent" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const p = JSON.parse(body) as { text: string; topic: string };
      this.sent.push({ text: p.text, topic: p.topic, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      return res.end("{}");
    }
    if (url.pathname === "/events") {
      const topic = url.searchParams.get("topic") ?? "main";
      const after = Number(url.searchParams.get("after") ?? 0);
      const pending = () => this.#events.filter((e) => e.seq > after && e.topic === topic);
      if (pending().length === 0) {
        await new Promise<void>((ok) => {
          const done = () => {
            this.#waiters.delete(done);
            clearTimeout(timer);
            ok();
          };
          const timer = setTimeout(done, 500);
          this.#waiters.add(done);
          req.on("close", done);
        });
      }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(pending()));
    }
    // Everything else is a file under the catalog root, with an ETag.
    const file = join(this.root, decodeURIComponent(url.pathname));
    if (!file.startsWith(this.root)) return res.writeHead(404).end();
    try {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(file);
      const etag = `"${createHash("sha1").update(data).digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) {
        this.notModified++;
        return res.writeHead(304, { etag }).end();
      }
      res.writeHead(200, { etag, "content-length": data.length });
      return res.end(data);
    } catch {
      return res.writeHead(404).end();
    }
  }
}

// ---------------------------------------------------------------- catalogs

interface CatalogItem {
  built: BuiltExtension;
  key?: SigningKey | null;
  kinds?: ExtensionKind[];
  revoked?: string;
  /** Lists this digest instead of the package's own. */
  digest?: string;
  /** Lists this version instead of the package's own. */
  version?: string;
}

/** Writes `catalog.json` and the packages into `dir`, with relative URLs. */
async function writeCatalog(dir: string, name: string, items: CatalogItem[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const publishers = new Map<string, { keyId: string; name: string; publicKey: string }>();
  const entries = new Map<string, Record<string, unknown> & { versions: unknown[] }>();
  for (const item of items) {
    const m = item.built.pkg.manifest;
    const version = item.version ?? m.version;
    const file = `${m.id}-${version}.slx`;
    await writeFile(join(dir, file), item.built.bytes);
    if (item.key) {
      publishers.set(item.key.keyId, {
        keyId: item.key.keyId,
        name: item.key.publisher,
        publicKey: item.key.publicKey,
      });
    }
    let entry = entries.get(m.id);
    if (!entry) {
      entry = {
        id: m.id,
        name: m.name,
        description: m.description,
        publisher: item.key?.keyId ?? null,
        kinds: item.kinds ?? ["connector"],
        versions: [],
      };
      entries.set(m.id, entry);
    }
    entry.versions.push({
      version,
      url: file,
      digest: item.digest ?? item.built.digest,
      size: item.built.bytes.length,
      sdk: m.sdk,
      permissions: m.permissions,
      publishedAt: "2026-11-01T00:00:00Z",
      revoked: item.revoked ? { reason: item.revoked } : null,
    });
  }
  const catalog = {
    format: "sling.catalog/v1",
    name,
    publishers: [...publishers.values()],
    extensions: [...entries.values()],
  };
  await writeFile(join(dir, "catalog.json"), JSON.stringify(catalog, null, 2));
}

// ---------------------------------------------------------------- harness

class Client {
  cookie = "";
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  async raw(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const isBytes = body instanceof Uint8Array;
    const res = await fetch(this.base + path, {
      method,
      headers: {
        origin: ORIGIN,
        cookie: this.cookie,
        ...(body === undefined
          ? {}
          : { "content-type": isBytes ? "application/octet-stream" : "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie();
    if (set.length) this.cookie = set.map((s) => s.split(";")[0]).join("; ");
    return res;
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Expects a refusal, and returns its status and message. */
  async refused(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; error: string }> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    if (res.ok) throw new Error(`${method} ${path} should have failed: ${text}`);
    return { status: res.status, error: (JSON.parse(text) as { error: string }).error };
  }

  async signUp() {
    await this.call("POST", "/api/auth/sign-up/email", {
      name: "Admin",
      email: "admin@example.com",
      password: "correct-horse-battery",
    });
  }
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 15_000,
): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

interface Node {
  id: string;
  type: string;
  version: number;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}
let seq = 0;
const n = (id: string, type: string, config: Record<string, unknown> = {}): Node => ({
  id,
  type,
  version: 1,
  position: { x: 0, y: 0 },
  config,
});
const port = (ref: string) => {
  const [node, p] = ref.split(".") as [string, string];
  return { node, port: p };
};
const x = (from: string, to: string) => ({
  id: `e${++seq}`,
  kind: "exec" as const,
  from: port(from),
  to: { node: to, port: "in" },
});
const d = (from: string, to: string) => ({
  id: `e${++seq}`,
  kind: "data" as const,
  from: port(from),
  to: port(to),
});
const def = (name: string, nodes: Node[], edges: unknown[]) => ({
  schema: "sling.workflow/v1",
  name,
  description: "",
  nodes,
  edges,
});

interface Detail {
  id: string;
  enabled: boolean;
  activeVersion: number | null;
  templateKey: string | null;
  draft: { nodes: Node[] };
}

async function deploy(client: Client, definition: unknown, opts: { enable?: boolean } = {}) {
  const wf = await client.call<Detail>("POST", "/api/workflows", { definition });
  const pub = await client.raw("POST", `/api/workflows/${wf.id}/publish`, { note: "test" });
  if (!pub.ok) throw new Error(`publish failed: ${await pub.text()}`);
  if (opts.enable) await client.call("PATCH", `/api/workflows/${wf.id}`, { enabled: true });
  return client.call<Detail>("GET", `/api/workflows/${wf.id}`);
}

async function runManual(client: Client, workflowId: string): Promise<RunDetailView> {
  const run = await client.call<RunView>("POST", `/api/workflows/${workflowId}/run`, {});
  return until(`run ${run.id} to finish`, async () => {
    const r = await client.call<RunDetailView>("GET", `/api/runs/${run.id}`);
    return ["succeeded", "failed", "cancelled"].includes(r.run.status) ? r : null;
  });
}

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let runtime: ReturnType<typeof testRuntime>;
let c: Client;
let local: LocalServer;
let root: string;
let includedDir: string;
let cacheDir: string;
let templatesDir: string;
const extra: RunningServer[] = [];
/** No process has this ID: it's past every platform's limit. */
const DEAD_PID = 2_147_483_000;

async function close(s: RunningServer) {
  extra.splice(extra.indexOf(s), 1);
  await s.close();
}

const acmeKey = generateSigningKey("Acme");
const otherKey = generateSigningKey("Other Co");

function configFor(databaseUrl: string): Config {
  return {
    databaseUrl,
    publicUrl: new URL(ORIGIN),
    secretKey: SECRET,
    host: "127.0.0.1",
    port: 0,
    logLevel: "warn",
    webDist: undefined,
    allowUnsignedExtensions: true,
    includedExtensionsDir: includedDir,
    extensionCacheDir: cacheDir,
  };
}

async function boot(databaseUrl: string, rt = testRuntime()): Promise<RunningServer> {
  return startServer(configFor(databaseUrl), {
    jobs: false,
    nodes: testNodes,
    connectors: [fakeConnector],
    templatesDir,
    extensionRuntime: rt,
  });
}

async function freshDatabase(name: string): Promise<string> {
  await server.ctx.db.execute(sql.raw(`create database ${name}`));
  const url = new URL(pg.getConnectionUri());
  url.pathname = `/${name}`;
  return url.toString();
}

async function workspaceId(s: RunningServer = server): Promise<string> {
  const [m] = await s.ctx.db.select().from(schema.workspaceMembers).limit(1);
  if (!m) throw new Error("no workspace");
  return m.workspaceId;
}

async function verbs(s: RunningServer = server): Promise<string[]> {
  const rows = await s.ctx.db.select({ verb: schema.auditEvents.verb }).from(schema.auditEvents);
  return rows.map((r) => r.verb);
}

/** Previews uploaded bytes, then confirms. */
async function upload(
  client: Client,
  built: BuiltExtension,
  opts: { trust?: boolean } = {},
): Promise<ExtensionView> {
  const preview = await client.call<ExtensionPreview>(
    "POST",
    "/api/extensions/preview",
    built.bytes,
  );
  return client.call<ExtensionView>("POST", "/api/extensions/install", {
    stagingId: preview.stagingId,
    digest: preview.digest,
    permissions: preview.permissionsKey,
    trustPublisher: opts.trust ?? false,
  });
}

// Built once and shared: the chat extension and its catalog.
let chatV1: BuiltExtension;
let catalogId = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sling-ext-e2e-"));
  includedDir = join(root, "included");
  cacheDir = join(root, "cache");
  templatesDir = join(root, "templates");
  await mkdir(templatesDir, { recursive: true });

  const [incPush, incAlerts] = await Promise.all([
    buildExtension({
      id: "inc-push",
      source: echoSource("inc-push"),
      manifest: { name: "Inc push", description: "Push notifications, included." },
    }),
    buildExtension({
      id: "inc-alerts",
      manifest: {
        name: "Inc alerts",
        description: "Alert workflows.",
        requires: { extensions: { "inc-push": "^1.0.0" }, connectors: [] },
      },
      templates: {
        notify: {
          template: { name: "Notify on push", description: "Echoes." },
          workflow: def(
            "Notify on push",
            [n("m", "core.manual"), n("e", "inc-push.echo", { value: "hi" })],
            [x("m.next", "e")],
          ),
        },
      },
    }),
  ]);
  await writeCatalog(includedDir, "Included with Sling", [
    { built: incPush, kinds: ["connector"] },
    { built: incAlerts, kinds: ["workflows"] },
  ]);

  local = new LocalServer(join(root, "served"));
  await local.start();
  chatV1 = await buildExtension({
    id: "acme-chat",
    source: chatSource("acme-chat"),
    key: acmeKey,
    manifest: {
      name: "Acme chat",
      description: "Chat for tests.",
      // The chat server is the test's own, on loopback over plain HTTP.
      permissions: {
        network: { hosts: ["chat.acme.test"], configHosts: ["server"], localNetwork: true },
      },
    },
  });
  await writeCatalog(join(local.root, "acme"), "Acme extensions", [
    { built: chatV1, key: acmeKey },
  ]);

  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  runtime = testRuntime();
  server = await boot(pg.getConnectionUri(), runtime);
  server.ctx.connectors.backoffBaseMs = 50;
  c = new Client(server.url);
  await c.signUp();
}, 180_000);

afterAll(async () => {
  for (const s of extra) await s.close().catch(() => {});
  await server?.close();
  await local?.stop();
  await pg?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests

describe("install from a catalog", () => {
  let installationId = "";
  let workflowId = "";

  it("adds a catalog and lists its extensions in discover", async () => {
    const cat = await c.call<CatalogView>("POST", "/api/extension-catalogs", {
      url: `${local.base}/acme/catalog.json`,
    });
    catalogId = cat.id;
    expect(cat).toMatchObject({ name: "Acme extensions", included: false, extensionCount: 1 });
    expect(cat.error).toBeNull();
    const again = await c.refused("POST", "/api/extension-catalogs", {
      url: `${local.base}/acme/catalog.json`,
    });
    expect(again.status).toBe(409);

    const entries = await c.call<DiscoverEntryView[]>("GET", "/api/extensions/discover");
    const entry = entries.find((e) => e.id === "acme-chat");
    expect(entry).toMatchObject({
      catalogId,
      catalogName: "Acme extensions",
      kinds: ["connector"],
      installed: null,
      unavailable: null,
      publisher: { keyId: acmeKey.keyId, name: "Acme", trusted: false },
      latest: { version: "1.0.0" },
    });
    expect(entry?.latest?.permissions.map((p) => p.key)).toEqual([
      "host:chat.acme.test",
      "configHost:server",
      "localNetwork",
    ]);
  });

  it("previews, asks to trust the publisher, then installs", async () => {
    const preview = await c.call<ExtensionPreview>("POST", "/api/extensions/preview", {
      catalogId,
      extensionId: "acme-chat",
      version: "1.0.0",
    });
    expect(preview).toMatchObject({
      id: "acme-chat",
      version: "1.0.0",
      source: "catalog",
      catalogId,
      signed: true,
      publisher: { keyId: acmeKey.keyId, trusted: false },
      problems: [],
      diff: null,
      kinds: ["connector"],
      digest: chatV1.digest,
    });
    expect(preview.publisher?.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(preview.contents.connectors).toEqual([
      { id: "acme-chat", name: "Acme chat", isExecutionProvider: false },
    ]);
    expect(preview.contents.nodes.map((x) => [x.type, x.isTrigger])).toEqual([
      ["acme-chat.message", true],
      ["acme-chat.send", false],
    ]);
    expect(preview.readme).toContain("# Acme chat");

    const body = {
      stagingId: preview.stagingId,
      digest: preview.digest,
      permissions: preview.permissionsKey,
    };
    const untrusted = await c.refused("POST", "/api/extensions/install", body);
    expect(untrusted.status).toBe(409);
    expect(untrusted.error).toContain("Trust Acme");
    const changed = await c.refused("POST", "/api/extensions/install", {
      ...body,
      permissions: "0".repeat(64),
      trustPublisher: true,
    });
    expect(changed.error).toContain("changed since the preview");

    const view = await c.call<ExtensionView>("POST", "/api/extensions/install", {
      ...body,
      trustPublisher: true,
    });
    expect(view).toMatchObject({
      id: "acme-chat",
      version: "1.0.0",
      source: "catalog",
      catalogId,
      signed: true,
      enabled: true,
      status: "stopped",
      publisher: { keyId: acmeKey.keyId, trusted: true },
      update: null,
      revoked: null,
    });
    // The staging ID is used up.
    const reused = await c.refused("POST", "/api/extensions/install", body);
    expect(reused.status).toBe(410);

    const publishers = await c.call<PublisherView[]>("GET", "/api/extension-publishers");
    expect(publishers).toEqual([
      expect.objectContaining({ keyId: acmeKey.keyId, name: "Acme", extensions: ["acme-chat"] }),
    ]);
    expect(await verbs()).toEqual(
      expect.arrayContaining(["catalog.added", "publisher.trusted", "extension.installed"]),
    );
  });

  it("registers its connector and nodes", async () => {
    const connectors = await c.call<ConnectorView[]>("GET", "/api/connectors");
    const chat = connectors.find((x) => x.id === "acme-chat");
    expect(chat).toMatchObject({
      name: "Acme chat",
      secretFields: ["token"],
      nodeTypes: ["acme-chat.message", "acme-chat.send"],
      extension: { id: "acme-chat", name: "Acme chat", version: "1.0.0", hasIcon: false },
    });
    expect(chat?.configSchema).toMatchObject({ properties: { server: { type: "string" } } });
    expect(connectors.find((x) => x.id === "fake")?.extension).toBeNull();
    const nodes = await c.call<{ nodes: { type: string; connector: string | null }[] }>(
      "GET",
      "/api/workflow-nodes",
    );
    expect(nodes.nodes.filter((x) => x.connector === "acme-chat").map((x) => x.type)).toEqual([
      "acme-chat.message",
      "acme-chat.send",
    ]);
  });

  it("runs a workflow through its trigger and its action", async () => {
    const inst = await c.call<InstallationView>("POST", "/api/installations", {
      connectorId: "acme-chat",
      name: "Team chat",
      credentials: { token: TOKEN },
      config: { server: local.base },
    });
    installationId = inst.id;
    expect([...server.ctx.extensions.configHosts("acme-chat")]).toEqual(["127.0.0.1"]);
    if (runtime instanceof InProcessRuntime) {
      expect([...(runtime.active("acme-chat")?.configHosts() ?? [])]).toEqual(["127.0.0.1"]);
    }
    const test = await c.call<{ ok: boolean; detail?: string }>(
      "POST",
      `/api/installations/${inst.id}/test`,
    );
    expect(test).toEqual({ ok: true, detail: "pong" });

    const wf = await deploy(
      c,
      def(
        "Chat echo",
        [
          n("trig", "acme-chat.message", { installationId, contains: "hello" }),
          n("send", "acme-chat.send", { installationId }),
        ],
        [x("trig.next", "send"), d("trig.text", "send.text")],
      ),
      { enable: true },
    );
    workflowId = wf.id;
    await until("the source to connect", async () => {
      const list = await c.call<InstallationView[]>("GET", "/api/installations");
      return list.find((i) => i.id === installationId)?.status === "connected";
    });

    local.publish("main", "ignore me");
    local.publish("main", "hello from chat");
    const sent = await until("the action to post", async () =>
      local.sent.find((s) => s.text === "hello from chat"),
    );
    expect(sent).toEqual({ text: "hello from chat", topic: "main", auth: `Bearer ${TOKEN}` });
    const runs = await until("the run to succeed", async () => {
      const list = await c.call<RunView[]>("GET", `/api/workflows/${workflowId}/runs`);
      return list.length > 0 && list.every((r) => r.status === "succeeded") ? list : null;
    });
    // The trigger's match filtered out the first message.
    expect(runs).toHaveLength(1);
    expect(local.sent.some((s) => s.text === "ignore me")).toBe(false);

    const list = await c.call<ExtensionView[]>("GET", "/api/extensions");
    expect(list.find((e) => e.id === "acme-chat")?.usedBy).toEqual({
      installations: 1,
      workflows: 1,
    });
  });

  it("keeps config hosts in step with installations", async () => {
    await c.call("PATCH", `/api/installations/${installationId}`, {
      config: { server: `http://localhost:${local.port}`, topic: "main" },
    });
    expect([...server.ctx.extensions.configHosts("acme-chat")]).toEqual(["localhost"]);
    const second = await c.call<InstallationView>("POST", "/api/installations", {
      connectorId: "acme-chat",
      name: "Other chat",
      credentials: { token: "t2" },
      config: { server: "https://chat.example.org/api", topic: "other" },
      enabled: false,
    });
    expect([...server.ctx.extensions.configHosts("acme-chat")].sort()).toEqual([
      "chat.example.org",
      "localhost",
    ]);
    await c.call("DELETE", `/api/installations/${second.id}`);
    expect([...server.ctx.extensions.configHosts("acme-chat")]).toEqual(["localhost"]);
    await c.call("PATCH", `/api/installations/${installationId}`, {
      config: { server: local.base, topic: "main" },
    });
  });

  it("shows details: manifest, digest, versions, log, and what uses it", async () => {
    const detail = await c.call<ExtensionDetailView>("GET", "/api/extensions/acme-chat");
    expect(detail.digest).toBe(chatV1.digest);
    expect(detail.manifest).toMatchObject({ id: "acme-chat", version: "1.0.0" });
    expect(detail.readme).toContain("A test extension.");
    expect(detail.versions).toEqual([
      { version: "1.0.0", publishedAt: expect.any(String), revoked: null },
    ]);
    expect(detail.installations).toEqual([
      { id: installationId, name: "Team chat", connectorId: "acme-chat" },
    ]);
    expect(detail.workflows).toEqual([{ id: workflowId, name: "Chat echo", enabled: true }]);
    if (inProcess) expect(detail.log.map((l) => l.message)).toContain("activated 1.0.0");
    const icon = await c.raw("GET", "/api/extensions/acme-chat/icon");
    expect(icon.status).toBe(404);
  });

  it("maps runtime status and crashes onto the extension", async () => {
    if (!(runtime instanceof InProcessRuntime)) return;
    runtime.emitStatus("acme-chat", "running");
    await until("the status to be saved", async () => {
      const [row] = await server.ctx.db
        .select()
        .from(schema.extensions)
        .where(eq(schema.extensions.id, "acme-chat"));
      return row?.status === "running";
    });
    runtime.emitCrash("acme-chat", "out of memory");
    await until("the crash to be audited", async () =>
      (await verbs()).includes("extension.crashed"),
    );
    runtime.emitStatus("acme-chat", "stopped");
    await until("the status to be saved", async () => {
      const view = await c.call<ExtensionView>("GET", "/api/extensions/acme-chat");
      return view.status === "stopped";
    });
  });

  it("refreshes a catalog with its ETag", async () => {
    const before = local.notModified;
    const cat = await c.call<CatalogView>("POST", `/api/extension-catalogs/${catalogId}/refresh`);
    expect(cat.error).toBeNull();
    expect(local.notModified).toBe(before + 1);
  });
});

describe("refusals", () => {
  async function preview(built: BuiltExtension): Promise<ExtensionPreview> {
    return c.call<ExtensionPreview>("POST", "/api/extensions/preview", built.bytes);
  }

  async function withSignedOnly<T>(fn: () => Promise<T>): Promise<T> {
    server.ctx.config.allowUnsignedExtensions = false;
    try {
      return await fn();
    } finally {
      server.ctx.config.allowUnsignedExtensions = true;
    }
  }

  it("refuses unsigned packages unless the server allows them, and labels them", async () => {
    const built = await buildExtension({ id: "plain-echo", source: echoSource("plain-echo") });
    await withSignedOnly(async () => {
      const p = await preview(built);
      expect(p.signed).toBe(false);
      expect(p.problems).toContain(
        "The package isn't signed. This server only installs signed packages.",
      );
      const refused = await c.refused("POST", "/api/extensions/install", {
        stagingId: p.stagingId,
        digest: p.digest,
        permissions: p.permissionsKey,
      });
      expect(refused.status).toBe(409);
      expect(refused.error).toContain("isn't signed");
      // Without the flag, a catalog on this machine over plain HTTP is refused too.
      const http = await c.refused("POST", "/api/extension-catalogs", {
        url: `${local.base}/elsewhere/catalog.json`,
      });
      expect(http.error).toContain("Catalogs must use HTTPS");
    });
    const p = await preview(built);
    expect(p).toMatchObject({ signed: false, publisher: null, problems: [] });
    const view = await upload(c, built);
    expect(view).toMatchObject({
      signed: false,
      source: "upload",
      catalogId: null,
      publisher: null,
    });
    expect(
      (await c.refused("POST", "/api/extension-catalogs", { url: "http://example.com/c.json" }))
        .error,
    ).toBe("Catalogs must use HTTPS.");
  });

  it("refuses a package whose files don't match its signature", async () => {
    const built = await buildExtension({
      id: "tampered",
      source: echoSource("tampered"),
      key: acmeKey,
    });
    const files = new Map(built.pkg.files);
    files.set("README.md", new TextEncoder().encode("# Changed after signing\n"));
    const bytes = writePackage(files, built.pkg.signature);
    const p = await c.call<ExtensionPreview>("POST", "/api/extensions/preview", bytes);
    expect(p.problems).toContain(
      "The signature doesn't match the package. Its files changed after it was signed.",
    );
    expect(p.contents.connectors).toEqual([]);
  });

  it("refuses a download that doesn't match the catalog", async () => {
    const real = await buildExtension({ id: "bad-digest", source: echoSource("bad-digest") });
    const other = await buildExtension({
      id: "bad-digest",
      source: echoSource("bad-digest", { sdkTag: " Other." }),
    });
    await writeCatalog(join(local.root, "bad"), "Bad catalog", [
      { built: real, digest: other.digest },
      { built: other, version: "9.9.9" },
    ]);
    const cat = await c.call<CatalogView>("POST", "/api/extension-catalogs", {
      url: `${local.base}/bad/catalog.json`,
    });
    const digest = await c.refused("POST", "/api/extensions/preview", {
      catalogId: cat.id,
      extensionId: "bad-digest",
      version: "1.0.0",
    });
    expect(digest).toEqual({
      status: 422,
      error: "The download doesn't match the digest in the catalog.",
    });
    const version = await c.refused("POST", "/api/extensions/preview", {
      catalogId: cat.id,
      extensionId: "bad-digest",
      version: "9.9.9",
    });
    expect(version.error).toContain("but the catalog lists bad-digest 9.9.9");
    await c.call("DELETE", `/api/extension-catalogs/${cat.id}`);
  });

  it("refuses a catalog whose listed publisher didn't sign the package", async () => {
    const built = await buildExtension({
      id: "wrong-pub",
      source: echoSource("wrong-pub"),
      key: otherKey,
    });
    await writeCatalog(join(local.root, "wrongpub"), "Wrong publisher", [{ built, key: acmeKey }]);
    const cat = await c.call<CatalogView>("POST", "/api/extension-catalogs", {
      url: `${local.base}/wrongpub/catalog.json`,
    });
    const p = await c.call<ExtensionPreview>("POST", "/api/extensions/preview", {
      catalogId: cat.id,
      extensionId: "wrong-pub",
      version: "1.0.0",
    });
    expect(p.problems.join(" ")).toContain("but the catalog lists");
    await c.call("DELETE", `/api/extension-catalogs/${cat.id}`);
  });

  it("asks to trust a new key, and trusts it on confirm", async () => {
    const built = await buildExtension({
      id: "other-echo",
      source: echoSource("other-echo"),
      key: otherKey,
    });
    const p = await preview(built);
    expect(p.problems).toEqual([]);
    expect(p.publisher).toMatchObject({ keyId: otherKey.keyId, name: "Other Co", trusted: false });
    const refused = await c.refused("POST", "/api/extensions/install", {
      stagingId: p.stagingId,
      digest: p.digest,
      permissions: p.permissionsKey,
    });
    expect(refused.error).toContain("Trust Other Co");
    const view = await upload(c, built, { trust: true });
    expect(view.publisher).toMatchObject({ keyId: otherKey.keyId, trusted: true });
  });

  it("refuses an update signed by a different key than the installed version", async () => {
    // acme-chat is pinned to the Acme key. Other Co is trusted, but that doesn't matter.
    const update = await buildExtension({
      id: "acme-chat",
      version: "1.0.1",
      source: chatSource("acme-chat"),
      key: otherKey,
    });
    const p = await preview(update);
    expect(p.diff?.fromVersion).toBe("1.0.0");
    expect(p.problems.join(" ")).toContain("signed by a different key than the installed version");
    const unsigned = await buildExtension({
      id: "acme-chat",
      version: "1.0.1",
      source: chatSource("acme-chat"),
    });
    expect((await preview(unsigned)).problems.join(" ")).toContain(
      "The installed version is signed by",
    );
  });

  it("refuses a package that needs a newer SDK", async () => {
    const built = await buildExtension({
      id: "future-echo",
      source: echoSource("future-echo"),
      manifest: { sdk: "^2.0.0" },
    });
    const p = await preview(built);
    expect(p.problems).toContain(`It needs SDK ^2.0.0, and this server has ${SDK_VERSION}.`);
    if (runtime instanceof InProcessRuntime) {
      const before = runtime.calls.describe;
      await preview(built);
      // Code that fails a check isn't started.
      expect(runtime.calls.describe).toBe(before);
    }
  });

  it("refuses names outside the extension's ID, and names others use", async () => {
    const outside = await buildExtension({
      id: "sneaky",
      source: echoSource("sneaky", { connectorId: "discord" }),
    });
    const p = await preview(outside);
    expect(p.problems).toContain("Connector discord must be named sneaky or start with sneaky.");
    // `fake` is a connector built into this test server.
    const clash = await buildExtension({ id: "fake", source: echoSource("fake") });
    expect((await preview(clash)).problems).toEqual([
      "The name fake is already used by Sling's built-in nodes.",
      "Connector fake is already registered by Sling's built-in nodes.",
    ]);
  });

  it("lists what a package needs that isn't installed", async () => {
    const built = await buildExtension({
      id: "needs-stuff",
      manifest: {
        requires: { extensions: { "inc-push": "^1.0.0", nowhere: "^1.0.0" }, connectors: ["nope"] },
      },
      templates: {
        t: {
          template: { name: "T" },
          workflow: def("T", [n("m", "core.manual")], []),
        },
      },
    });
    const p = await preview(built);
    expect(p.missing).toEqual({
      extensions: [
        { id: "inc-push", range: "^1.0.0", catalogId: "included" },
        { id: "nowhere", range: "^1.0.0", catalogId: null },
      ],
      connectors: ["nope"],
    });
    expect(p.problems).toHaveLength(3);
  });

  it("refuses a stored package changed in the database when the server loads it", async () => {
    const db = await freshDatabase("tamper_check");
    const s2 = await boot(db);
    extra.push(s2);
    const c2 = new Client(s2.url);
    await c2.signUp();
    const built = await buildExtension({ id: "stored-echo", source: echoSource("stored-echo") });
    await upload(c2, built);
    const files = new Map(built.pkg.files);
    files.set("README.md", new TextEncoder().encode("# Swapped in the database\n"));
    await s2.ctx.db
      .update(schema.extensionPackages)
      .set({ archive: writePackage(files) })
      .where(eq(schema.extensionPackages.extensionId, "stored-echo"));
    await close(s2);

    const s3 = await boot(db);
    extra.push(s3);
    const c3 = new Client(s3.url);
    c3.cookie = c2.cookie;
    const view = await c3.call<ExtensionView>("GET", "/api/extensions/stored-echo");
    expect(view).toMatchObject({ status: "error", statusDetail: DIGEST_MISMATCH });
    // Its nodes stay registered as stand-ins, so workflows that use them still validate.
    const wf = await deploy(
      c3,
      def("Uses it", [n("m", "core.manual"), n("e", "stored-echo.echo")], [x("m.next", "e")]),
    );
    const run = await runManual(c3, wf.id);
    expect(run.run.status).toBe("failed");
    expect(run.nodeRuns.find((r) => r.nodeId === "e")?.error).toEqual({
      message: DIGEST_MISMATCH,
      code: "extension_disabled",
    });
    // Turning it off and on reads the package again, and it's still refused.
    await c3.call("PATCH", "/api/extensions/stored-echo", { enabled: false });
    const again = await c3.call<ExtensionView>("PATCH", "/api/extensions/stored-echo", {
      enabled: true,
    });
    expect(again.status).toBe("error");
    await close(s3);
  });
});

describe("updates and revocation", () => {
  let notesCatalog = "";
  let wfId = "";
  const notes = (version: string, hosts: string[], extra: { approvals?: boolean } = {}) =>
    buildExtension({
      id: "acme-notes",
      version,
      source: echoSource("acme-notes"),
      key: acmeKey,
      manifest: {
        name: "Acme notes",
        permissions: { network: { hosts }, approvals: extra.approvals ?? false },
      },
    });

  it("shows an update with its permission diff, and applies it without a restart", async () => {
    const v1 = await notes("1.0.0", ["a.acme.test", "b.acme.test"]);
    const dir = join(local.root, "notes");
    await writeCatalog(dir, "Notes", [{ built: v1, key: acmeKey }]);
    const cat = await c.call<CatalogView>("POST", "/api/extension-catalogs", {
      url: `${local.base}/notes/catalog.json`,
    });
    notesCatalog = cat.id;
    const p1 = await c.call<ExtensionPreview>("POST", "/api/extensions/preview", {
      catalogId: notesCatalog,
      extensionId: "acme-notes",
      version: "1.0.0",
    });
    // Acme is trusted already.
    expect(p1.publisher?.trusted).toBe(true);
    await c.call("POST", "/api/extensions/install", {
      stagingId: p1.stagingId,
      digest: p1.digest,
      permissions: p1.permissionsKey,
    });
    const wf = await deploy(
      c,
      def(
        "Notes",
        [n("m", "core.manual"), n("e", "acme-notes.echo", { value: "v" })],
        [x("m.next", "e")],
      ),
    );
    wfId = wf.id;
    expect((await runManual(c, wfId)).run.status).toBe("succeeded");

    const v2 = await notes("1.1.0", ["a.acme.test", "c.acme.test"], { approvals: true });
    await writeCatalog(dir, "Notes", [
      { built: v1, key: acmeKey },
      { built: v2, key: acmeKey },
    ]);
    await c.call("POST", `/api/extension-catalogs/${notesCatalog}/refresh`);
    const listed = await c.call<ExtensionView[]>("GET", "/api/extensions");
    expect(listed.find((e) => e.id === "acme-notes")?.update).toEqual({
      version: "1.1.0",
      catalogId: notesCatalog,
    });
    const entry = (await c.call<DiscoverEntryView[]>("GET", "/api/extensions/discover?q=notes"))[0];
    expect(entry?.installed).toEqual({ version: "1.0.0", updateAvailable: true });

    const p2 = await c.call<ExtensionPreview>(
      "POST",
      "/api/extensions/acme-notes/update/preview",
      {},
    );
    expect(p2.version).toBe("1.1.0");
    expect(p2.diff).toEqual({
      fromVersion: "1.0.0",
      added: [
        { key: "host:c.acme.test", text: "Connect to c.acme.test", risk: "normal" },
        expect.objectContaining({ key: "approvals", risk: "high" }),
      ],
      removed: [{ key: "host:b.acme.test", text: "Connect to b.acme.test", risk: "normal" }],
    });
    const view = await c.call<ExtensionView>("POST", "/api/extensions/install", {
      stagingId: p2.stagingId,
      digest: p2.digest,
      permissions: p2.permissionsKey,
    });
    expect(view).toMatchObject({ version: "1.1.0", update: null, status: "stopped" });
    expect(view.permissions.map((l) => l.key)).toEqual([
      "host:a.acme.test",
      "host:c.acme.test",
      "approvals",
    ]);
    if (runtime instanceof InProcessRuntime) {
      expect(runtime.active("acme-notes")).toMatchObject({
        version: "1.1.0",
        granted: { approvals: true },
      });
    }
    const pkgs = await server.ctx.db
      .select({ version: schema.extensionPackages.version })
      .from(schema.extensionPackages)
      .where(eq(schema.extensionPackages.extensionId, "acme-notes"));
    expect(pkgs.map((p) => p.version).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect((await runManual(c, wfId)).run.status).toBe("succeeded");
    expect(await verbs()).toContain("extension.updated");

    // A third version keeps it and the one before it.
    const v3 = await notes("1.2.0", ["a.acme.test", "c.acme.test"], { approvals: true });
    await writeCatalog(dir, "Notes", [
      { built: v1, key: acmeKey },
      { built: v2, key: acmeKey },
      { built: v3, key: acmeKey },
    ]);
    await c.call("POST", `/api/extension-catalogs/${notesCatalog}/refresh`);
    const p3 = await c.call<ExtensionPreview>("POST", "/api/extensions/acme-notes/update/preview", {
      version: "1.2.0",
    });
    expect(p3.diff).toMatchObject({ fromVersion: "1.1.0", added: [], removed: [] });
    await c.call("POST", "/api/extensions/install", {
      stagingId: p3.stagingId,
      digest: p3.digest,
      permissions: p3.permissionsKey,
    });
    const after = await server.ctx.db
      .select({ version: schema.extensionPackages.version })
      .from(schema.extensionPackages)
      .where(eq(schema.extensionPackages.extensionId, "acme-notes"));
    expect(after.map((p) => p.version).sort()).toEqual(["1.1.0", "1.2.0"]);
    // Rewrites the catalog with 1.2.0 for the revocation test.
    await writeCatalog(dir, "Notes", [
      { built: v2, key: acmeKey },
      { built: v3, key: acmeKey },
    ]);
  });

  it("disables a version the catalog revokes, with the catalog's reason", async () => {
    const dir = join(local.root, "notes");
    const v2 = await notes("1.1.0", ["a.acme.test", "c.acme.test"], { approvals: true });
    const v3 = await notes("1.2.0", ["a.acme.test", "c.acme.test"], { approvals: true });
    await writeCatalog(dir, "Notes", [
      { built: v2, key: acmeKey },
      { built: v3, key: acmeKey, revoked: "It leaks notes." },
    ]);
    await c.call("POST", `/api/extension-catalogs/${notesCatalog}/refresh`);
    const view = await c.call<ExtensionView>("GET", "/api/extensions/acme-notes");
    expect(view).toMatchObject({
      enabled: false,
      status: "disabled",
      statusDetail: "It leaks notes.",
      revoked: { reason: "It leaks notes." },
      // 1.1.0 is older, so it isn't offered as an update.
      update: null,
    });
    expect(await verbs()).toContain("extension.revoked");
    const run = await runManual(c, wfId);
    expect(run.nodeRuns.find((r) => r.nodeId === "e")?.error).toEqual({
      message: "The extension is disabled",
      code: "extension_disabled",
    });
    const on = await c.refused("PATCH", "/api/extensions/acme-notes", { enabled: true });
    expect(on.status).toBe(409);
    expect(on.error).toContain("It leaks notes.");
    const entry = (await c.call<DiscoverEntryView[]>("GET", "/api/extensions/discover?q=notes"))[0];
    expect(entry?.latest?.version).toBe("1.1.0");
    const detail = await c.call<ExtensionDetailView>("GET", "/api/extensions/acme-notes");
    expect(detail.versions.map((v) => [v.version, v.revoked?.reason ?? null])).toEqual([
      ["1.2.0", "It leaks notes."],
      ["1.1.0", null],
    ]);
  });
});

describe("the included catalog", () => {
  it("is listed in discover, and installs without a signature", async () => {
    const catalogs = await c.call<CatalogView[]>("GET", "/api/extension-catalogs");
    expect(catalogs[0]).toMatchObject({
      id: "included",
      included: true,
      url: null,
      name: "Included with Sling",
      error: null,
      extensionCount: 2,
    });
    const all = await c.call<DiscoverEntryView[]>("GET", "/api/extensions/discover");
    expect(all.filter((e) => e.catalogId === "included").map((e) => e.id)).toEqual([
      "inc-push",
      "inc-alerts",
    ]);
    const workflows = await c.call<DiscoverEntryView[]>(
      "GET",
      "/api/extensions/discover?kind=workflows",
    );
    expect(workflows.map((e) => e.id)).toEqual(["inc-alerts"]);
    const search = await c.call<DiscoverEntryView[]>("GET", "/api/extensions/discover?q=PUSH");
    expect(search.map((e) => e.id)).toContain("inc-push");
    expect(search.find((e) => e.id === "inc-push")?.publisher).toBeNull();

    server.ctx.config.allowUnsignedExtensions = false;
    try {
      // The template package needs inc-push, which the same catalog has.
      const alerts = await c.call<ExtensionPreview>("POST", "/api/extensions/preview", {
        catalogId: "included",
        extensionId: "inc-alerts",
        version: "1.0.0",
      });
      expect(alerts.missing.extensions).toEqual([
        { id: "inc-push", range: "^1.0.0", catalogId: "included" },
      ]);
      const started = performance.now();
      const p = await c.call<ExtensionPreview>("POST", "/api/extensions/preview", {
        catalogId: "included",
        extensionId: "inc-push",
        version: "1.0.0",
      });
      expect(p).toMatchObject({ source: "included", signed: true, publisher: null, problems: [] });
      const view = await c.call<ExtensionView>("POST", "/api/extensions/install", {
        stagingId: p.stagingId,
        digest: p.digest,
        permissions: p.permissionsKey,
      });
      console.log(
        `install from the included catalog: ${Math.round(performance.now() - started)} ms`,
      );
      expect(view).toMatchObject({ source: "included", catalogId: "included", signed: true });
      const p2 = await c.call<ExtensionPreview>("POST", "/api/extensions/preview", {
        catalogId: "included",
        extensionId: "inc-alerts",
        version: "1.0.0",
      });
      expect(p2.problems).toEqual([]);
      expect(p2.kinds).toEqual(["workflows"]);
      await c.call("POST", "/api/extensions/install", {
        stagingId: p2.stagingId,
        digest: p2.digest,
        permissions: p2.permissionsKey,
      });
    } finally {
      server.ctx.config.allowUnsignedExtensions = true;
    }
    const templates = await c.call<TemplateView[]>("GET", "/api/templates");
    expect(templates.find((t) => t.key === "inc-alerts/notify")).toMatchObject({
      name: "Notify on push",
      builtIn: false,
      extension: { id: "inc-alerts", name: "Inc alerts" },
    });
    const wf = await c.call<Detail>("POST", "/api/workflows", { templateKey: "inc-alerts/notify" });
    expect(wf).toMatchObject({
      templateKey: "inc-alerts/notify",
      activeVersion: 1,
      enabled: false,
    });
    expect((await runManual(c, wf.id)).run.status).toBe("succeeded");
  });
});

describe("workflow packages", () => {
  it("exports a workflow with bindings and no credentials, and installs it again", async () => {
    const fake1 = await c.call<InstallationView>("POST", "/api/installations", {
      connectorId: "fake",
      name: "Fake one",
      credentials: { token: "good-token-123" },
    });
    const fake2 = await c.call<InstallationView>("POST", "/api/installations", {
      connectorId: "fake",
      name: "Fake two",
      credentials: { token: "other-token-456" },
    });
    const chat = (await c.call<InstallationView[]>("GET", "/api/installations")).find(
      (i) => i.connectorId === "acme-chat",
    ) as InstallationView;
    const wf = await deploy(
      c,
      def(
        "Daily digest!",
        [
          n("m", "core.manual"),
          n("a", "fake.echo_secret", { installationId: fake1.id }),
          n("b", "fake.echo_secret", { installationId: fake2.id }),
          n("again", "fake.echo_secret", { installationId: fake1.id }),
          n("s", "acme-chat.send", { installationId: chat.id, text: "digest" }),
        ],
        [x("m.next", "a"), x("a.next", "b"), x("b.next", "again"), x("again.next", "s")],
      ),
    );
    const res = await c.raw("POST", `/api/workflows/${wf.id}/export-package`, {
      id: "daily-digest",
      version: "1.0.0",
      name: "Daily digest",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="daily-digest-1.0.0.slx"',
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const pkg = readPackage(bytes);
    expect(pkg.signature).toBeNull();
    expect(pkg.manifest).toMatchObject({
      id: "daily-digest",
      version: "1.0.0",
      name: "Daily digest",
      publisher: "Admin",
      templates: ["daily-digest"],
      requires: { extensions: { "acme-chat": "^1.0.0" }, connectors: ["fake"] },
    });
    expect(pkg.manifest.main).toBeUndefined();
    const text = [...pkg.files.values()].map((f) => new TextDecoder().decode(f)).join("\n");
    for (const secret of [
      fake1.id,
      fake2.id,
      chat.id,
      "good-token-123",
      "other-token-456",
      TOKEN,
    ]) {
      expect(text).not.toContain(secret);
    }
    const template = JSON.parse(
      new TextDecoder().decode(pkg.files.get("templates/daily-digest/template.json")),
    );
    expect(template.bindings).toEqual([
      { placeholder: "$fake", connectorId: "fake", label: "Fake" },
      { placeholder: "$fake_2", connectorId: "fake", label: "Fake 2" },
      { placeholder: "$acme_chat", connectorId: "acme-chat", label: "Acme chat" },
    ]);
    const workflow = JSON.parse(
      new TextDecoder().decode(pkg.files.get("templates/daily-digest/workflow.json")),
    );
    expect(workflow.nodes.map((x: Node) => x.config.installationId ?? null)).toEqual([
      null,
      "$fake",
      "$fake_2",
      "$fake",
      "$acme_chat",
    ]);
    expect(new TextDecoder().decode(pkg.files.get("README.md"))).toContain("# Daily digest");

    const view = await upload(c, { bytes, pkg, digest: pkg.digest });
    expect(view).toMatchObject({ id: "daily-digest", signed: false, kinds: ["workflows"] });
    const templates = await c.call<TemplateView[]>("GET", "/api/templates");
    expect(templates.find((t) => t.key === "daily-digest/daily-digest")).toMatchObject({
      extension: { id: "daily-digest", name: "Daily digest" },
      bindings: template.bindings,
    });
    const missing = await c.refused("POST", "/api/workflows", {
      templateKey: "daily-digest/daily-digest",
      bindings: { $fake: fake1.id },
    });
    expect(missing.error).toContain("Pick an installation for Fake 2");
    const installed = await c.call<Detail>("POST", "/api/workflows", {
      templateKey: "daily-digest/daily-digest",
      bindings: { $fake: fake2.id, $fake_2: fake1.id, $acme_chat: chat.id },
    });
    expect(installed).toMatchObject({ activeVersion: 1, enabled: false });
    expect(installed.draft.nodes.map((x) => x.config.installationId ?? null)).toEqual([
      null,
      fake2.id,
      fake1.id,
      fake2.id,
      chat.id,
    ]);
  });
});

describe("disable and remove", () => {
  it("disables an extension: its source stops and its nodes fail", async () => {
    const chat = (await c.call<InstallationView[]>("GET", "/api/installations")).find(
      (i) => i.connectorId === "acme-chat",
    ) as InstallationView;
    expect(chat.status).toBe("connected");
    const wf = await deploy(
      c,
      def(
        "Send once",
        [
          n("m", "core.manual"),
          n("s", "acme-chat.send", { installationId: chat.id, text: "once" }),
        ],
        [x("m.next", "s")],
      ),
    );
    expect((await runManual(c, wf.id)).run.status).toBe("succeeded");

    const view = await c.call<ExtensionView>("PATCH", "/api/extensions/acme-chat", {
      enabled: false,
    });
    expect(view).toMatchObject({ enabled: false, status: "disabled" });
    await until("the source to stop", async () => {
      const list = await c.call<InstallationView[]>("GET", "/api/installations");
      return list.find((i) => i.id === chat.id)?.status === "idle";
    });
    if (runtime instanceof InProcessRuntime) expect(runtime.active("acme-chat")).toBeUndefined();
    const failed = await runManual(c, wf.id);
    expect(failed.nodeRuns.find((r) => r.nodeId === "s")?.error).toEqual({
      message: "The extension is disabled",
      code: "extension_disabled",
    });
    const test = await c.call("POST", `/api/installations/${chat.id}/test`);
    expect(test).toEqual({ ok: false, error: "The extension is disabled" });
    // The editor still knows its nodes, and the connector still lists.
    const nodes = await c.call<{ nodes: { type: string }[] }>("GET", "/api/workflow-nodes");
    expect(nodes.nodes.map((x) => x.type)).toContain("acme-chat.message");
    const connectors = await c.call<ConnectorView[]>("GET", "/api/connectors");
    expect(connectors.find((x) => x.id === "acme-chat")?.extension?.id).toBe("acme-chat");
    const sentBefore = local.sent.length;
    local.publish("main", "hello while disabled");
    await new Promise((r) => setTimeout(r, 300));
    expect(local.sent.length).toBe(sentBefore);

    await c.call("PATCH", "/api/extensions/acme-chat", { enabled: true });
    await until("the source to reconnect", async () => {
      const list = await c.call<InstallationView[]>("GET", "/api/installations");
      return list.find((i) => i.id === chat.id)?.status === "connected";
    });
    expect((await runManual(c, wf.id)).run.status).toBe("succeeded");
    expect(await verbs()).toEqual(
      expect.arrayContaining(["extension.disabled", "extension.enabled"]),
    );
  });

  it("tells open tabs when an extension changes or goes", async () => {
    const events: ServerEvent[] = [];
    let closed = () => {};
    // A stand-in for a browser tab's socket.
    const socket = {
      OPEN: 1,
      readyState: 1,
      send: (data: string) => events.push(JSON.parse(data) as ServerEvent),
      on: (event: string, fn: () => void) => {
        if (event === "close") closed = fn;
      },
    };
    server.ctx.hub.add(await workspaceId(), socket as never);
    try {
      await c.call("PATCH", "/api/extensions/plain-echo", { enabled: false });
      expect(events).toContainEqual({
        type: "extension.updated",
        extension: expect.objectContaining({
          id: "plain-echo",
          enabled: false,
          status: "disabled",
        }),
      });
      await c.call("DELETE", "/api/extensions/plain-echo");
      expect(events.at(-1)).toEqual({ type: "extension.removed", id: "plain-echo" });
    } finally {
      closed();
    }
  });

  it("serves an extension's icon with a sandboxing policy", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
    const built = await buildExtension({
      id: "icon-echo",
      source: echoSource("icon-echo"),
      manifest: { icon: "icon.svg" },
      files: { "icon.svg": svg },
    });
    const view = await upload(c, built);
    expect(view.hasIcon).toBe(true);
    const connectors = await c.call<ConnectorView[]>("GET", "/api/connectors");
    expect(connectors.find((x) => x.id === "icon-echo")?.extension?.hasIcon).toBe(true);
    const res = await c.raw("GET", "/api/extensions/icon-echo/icon");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(svg);
    const etag = res.headers.get("etag") as string;
    const again = await c.raw("GET", "/api/extensions/icon-echo/icon", undefined, {
      "if-none-match": etag,
    });
    expect(again.status).toBe(304);
    await c.call("DELETE", "/api/extensions/icon-echo");
  });

  it("removes an extension, its installations, and its node types", async () => {
    const detail = await c.call<ExtensionDetailView>("GET", "/api/extensions/acme-chat");
    expect(detail.installations).toHaveLength(1);
    expect(detail.workflows.map((w) => w.name).sort()).toEqual([
      "Chat echo",
      "Daily digest!",
      "Daily digest!",
      "Send once",
    ]);
    const installationId = detail.installations[0]?.id as string;
    const [inst] = await server.ctx.db
      .select()
      .from(schema.connectorInstallations)
      .where(eq(schema.connectorInstallations.id, installationId));
    const credentialId = inst?.credentialId as string;

    await c.call("DELETE", "/api/extensions/acme-chat");
    expect(
      (await c.call<ExtensionView[]>("GET", "/api/extensions")).map((e) => e.id),
    ).not.toContain("acme-chat");
    expect(await c.refused("GET", "/api/extensions/acme-chat")).toMatchObject({ status: 404 });
    const left = await server.ctx.db
      .select()
      .from(schema.connectorInstallations)
      .where(eq(schema.connectorInstallations.connectorId, "acme-chat"));
    expect(left).toEqual([]);
    const creds = await server.ctx.db
      .select()
      .from(schema.credentials)
      .where(eq(schema.credentials.id, credentialId));
    expect(creds).toEqual([]);
    const pkgs = await server.ctx.db
      .select()
      .from(schema.extensionPackages)
      .where(eq(schema.extensionPackages.extensionId, "acme-chat"));
    expect(pkgs).toEqual([]);
    const nodes = await c.call<{ nodes: { type: string }[] }>("GET", "/api/workflow-nodes");
    expect(nodes.nodes.map((x) => x.type)).not.toContain("acme-chat.send");
    // Workflows stay, and fail on the node type that's gone.
    const wf = detail.workflows.find((w) => w.name === "Send once") as { id: string };
    const run = await runManual(c, wf.id);
    expect(run.nodeRuns.find((r) => r.nodeId === "s")?.error?.code).toBe("unknown_node_type");
    expect(await verbs()).toContain("extension.removed");
    // Still trusted, with nothing pinned.
    const publishers = await c.call<PublisherView[]>("GET", "/api/extension-publishers");
    expect(publishers.find((p) => p.keyId === acmeKey.keyId)?.extensions).toEqual(["acme-notes"]);
  });

  it("removes a trusted publisher and a catalog", async () => {
    await c.call("DELETE", `/api/extension-publishers/${otherKey.keyId}`);
    const publishers = await c.call<PublisherView[]>("GET", "/api/extension-publishers");
    expect(publishers.map((p) => p.keyId)).toEqual([acmeKey.keyId]);
    // Its extension keeps running.
    const echo = await c.call<ExtensionView>("GET", "/api/extensions/other-echo");
    expect(echo).toMatchObject({ enabled: true, publisher: { trusted: false } });
    await c.call("DELETE", `/api/extension-catalogs/${catalogId}`);
    const catalogs = await c.call<CatalogView[]>("GET", "/api/extension-catalogs");
    expect(catalogs.map((x) => x.id)).not.toContain(catalogId);
    const included = await c.refused("DELETE", "/api/extension-catalogs/included");
    expect(included.status).toBe(409);
    expect(await verbs()).toEqual(expect.arrayContaining(["publisher.removed", "catalog.removed"]));
  });
});

describe("owner only", () => {
  it("refuses changes from someone who isn't the workspace owner", async () => {
    const ws = await workspaceId();
    const [owner] = await server.ctx.db
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, ws));
    await server.ctx.db
      .update(schema.workspaceMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, ws),
          eq(schema.workspaceMembers.userId, owner?.userId as string),
        ),
      );
    try {
      for (const [method, path, body] of [
        ["PATCH", "/api/extensions/acme-notes", { enabled: false }],
        ["DELETE", "/api/extensions/acme-notes", undefined],
        ["POST", "/api/extension-catalogs", { url: "https://example.com/catalog.json" }],
        ["DELETE", `/api/extension-publishers/${acmeKey.keyId}`, undefined],
        [
          "POST",
          "/api/extensions/preview",
          { catalogId: "included", extensionId: "inc-push", version: "1.0.0" },
        ],
      ] as const) {
        const r = await c.refused(method, path, body);
        expect(r).toEqual({
          status: 403,
          error: "Only the workspace owner can change extensions.",
        });
      }
      // Reads still work.
      expect(await c.call<ExtensionView[]>("GET", "/api/extensions")).not.toHaveLength(0);
    } finally {
      await server.ctx.db
        .update(schema.workspaceMembers)
        .set({ role: "owner" })
        .where(eq(schema.workspaceMembers.workspaceId, ws));
    }
  });
});

describe("startup", () => {
  it("loads 10 installed extensions quickly, starts no code, and clears old unpack directories", async () => {
    const db = await freshDatabase("startup_budget");
    const s1 = await boot(db);
    extra.push(s1);
    const c1 = new Client(s1.url);
    await c1.signUp();
    const builds = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const id = `bench-${String(i + 1).padStart(2, "0")}`;
        return buildExtension({ id, source: echoSource(id) });
      }),
    );
    for (const b of builds) await upload(c1, b);
    await close(s1);

    // A directory a dead server left behind, and one a live one is using.
    const dead = join(cacheDir, `${DEAD_PID}-dead-run`);
    const live = join(cacheDir, `${process.ppid}-live-run`);
    await mkdir(join(dead, "x"), { recursive: true });
    await mkdir(live, { recursive: true });

    const rt = testRuntime();
    const s2 = await boot(db, rt);
    extra.push(s2);
    const timings = s2.ctx.extensions.startTimings;
    console.log(`extension start with 10 installed: ${JSON.stringify(timings)}`);
    expect(timings?.extensions).toBe(10);
    expect(timings?.totalMs).toBeLessThan(100);
    if (rt instanceof InProcessRuntime) {
      expect(rt.calls).toMatchObject({ describe: 0, activate: 10 });
    }
    const c2 = new Client(s2.url);
    c2.cookie = c1.cookie;
    const list = await c2.call<ExtensionView[]>("GET", "/api/extensions");
    expect(list.map((e) => e.status)).toEqual(Array(10).fill("stopped"));
    await until("the dead server's directory to go", async () => {
      const names = await readdir(cacheDir);
      return !names.includes(`${DEAD_PID}-dead-run`) ? names : null;
    });
    expect(await readdir(cacheDir)).toContain(`${process.ppid}-live-run`);

    // Each start unpacks into a fresh directory of its own, removed on close.
    const runDir = s2.ctx.extensions.cache.runDir;
    expect((await readdir(runDir)).length).toBe(10);
    await close(s2);
    expect(await readdir(cacheDir)).not.toContain(runDir.split("/").at(-1));
  });
});
