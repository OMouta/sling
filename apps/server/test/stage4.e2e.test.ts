/**
 * Extensions end to end the way someone outside the project uses them, with
 * every extension in a real restricted process:
 *
 * - `sling-ext` makes, builds, signs, and catalogs an extension in a folder
 *   outside the repo, and Sling installs it from that catalog and runs a
 *   workflow through its trigger and its action.
 * - The examples that ship with Sling install from the included catalog, and
 *   a finished task sends an ntfy notification.
 * - The Fly Machines example starts a sandbox through a fake Machines API,
 *   whose Runner pairs and runs a task, and the orphan sweep goes through it.
 *
 * Needs Docker and Node 26. SLING_LIVE_NTFY=1 runs the ntfy part against
 * ntfy.sh with the included package as it ships, instead of a local fake.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type CatalogView,
  type ConnectorView,
  type DiscoverEntryView,
  type ExtensionPreview,
  type ExtensionView,
  type InstallationView,
  SANDBOX_ENV,
  type SandboxListView,
  type TaskView,
} from "@sling/core";
import { schema } from "@sling/db";
import { buildProject, loadProject, packProject, writeCatalog } from "@sling/extension-cli";
import { type FakeMachinesApi, startFakeMachinesApi } from "@sling/extension-fly-machines/fake-api";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { FakeRunner } from "./fixtures/fake-runner.ts";
import { calls, recordNode } from "./fixtures/nodes.ts";

vi.setConfig({ testTimeout: 90_000 });

const ROOT = resolve(import.meta.dirname, "../../..");
const CLI = join(ROOT, "packages/extension-cli/src/main.ts");
const LIVE_NTFY = process.env.SLING_LIVE_NTFY === "1";
/** A remote on a host that never resolves, so the repo has an identity without network. */
const REMOTE = "https://git.sling.invalid/acme/site.git";
const KEY = "git.sling.invalid/acme/site";

const execFileAsync = promisify(execFile);

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let origin = "";
let cookie = "";
let work = "";
let static_: StaticServer;
let machine: FakeRunner;

// ---------------------------------------------------------------- helpers

async function raw(method: string, path: string, body?: unknown, type = "application/json") {
  const isBytes = body instanceof Uint8Array;
  const res = await fetch(server.url + path, {
    method,
    headers: {
      origin,
      cookie,
      ...(body === undefined
        ? {}
        : { "content-type": isBytes ? "application/octet-stream" : type }),
    },
    body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie();
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, text };
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await raw(method, path, body);
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${res.text}`);
  return res.body as T;
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 45_000,
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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

async function cli(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
    });
    return stdout;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`sling-ext ${args.join(" ")} failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  }
}

/** Preview, then confirm. */
async function install(
  preview: ExtensionPreview,
  opts: { trustPublisher?: boolean } = {},
): Promise<ExtensionView> {
  expect(preview.problems).toEqual([]);
  return api<ExtensionView>("POST", "/api/extensions/install", {
    stagingId: preview.stagingId,
    digest: preview.digest,
    permissions: preview.permissionsKey,
    trustPublisher: opts.trustPublisher ?? false,
  });
}

const fromCatalog = (catalogId: string, extensionId: string, version = "1.0.0") =>
  api<ExtensionPreview>("POST", "/api/extensions/preview", { catalogId, extensionId, version });

/**
 * Copies an example out of the repo, lets it reach this machine (the fakes
 * listen on loopback over plain HTTP), and packs it unsigned.
 */
async function localVariant(example: string): Promise<Uint8Array> {
  const dir = join(work, `variant-${example}`);
  cpSync(join(ROOT, "extensions", example), dir, {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  const manifestPath = join(dir, "sling-extension.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.permissions.network.localNetwork = true;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const project = await loadProject(dir);
  await buildProject(project);
  const packed = await packProject(project, { outDir: join(dir, "out") });
  return packed.bytes;
}

async function workflow(def: Record<string, unknown>): Promise<string> {
  const wf = await api<{ id: string }>("POST", "/api/workflows", { definition: def });
  await api("POST", `/api/workflows/${wf.id}/publish`, { note: "test" });
  await api("PATCH", `/api/workflows/${wf.id}`, { enabled: true });
  return wf.id;
}

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
  id,
  type,
  version: 1,
  position: { x: 0, y: 0 },
  config,
});
const exec = (from: string, to: string) => ({
  id: `x_${from}_${to}`,
  kind: "exec",
  from: { node: from, port: "next" },
  to: { node: to, port: "in" },
});
const data = (from: string, port: string, to: string, toPort: string) => ({
  id: `d_${from}_${to}`,
  kind: "data",
  from: { node: from, port },
  to: { node: to, port: toPort },
});

const task = async (id: string) => (await api<{ task: TaskView }>("GET", `/api/tasks/${id}`)).task;

/** Serves a folder, the way a catalog would be hosted as static files. */
class StaticServer {
  #server: Server | null = null;
  base = "";
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async start() {
    this.#server = createServer((req, res) => {
      const path = join(
        this.root,
        decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname),
      );
      if (!path.startsWith(this.root) || !existsSync(path)) {
        res.writeHead(404).end();
        return;
      }
      const type = extname(path) === ".json" ? "application/json" : "application/octet-stream";
      res.writeHead(200, { "content-type": type }).end(readFileSync(path));
    });
    await new Promise<void>((ok) => this.#server?.listen(0, "127.0.0.1", ok));
    this.base = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }
  async stop() {
    await new Promise<void>((ok) => (this.#server ? this.#server.close(() => ok()) : ok()));
  }
}

/** Enough of ntfy for the example: health, JSON publish, and topic subscriptions over WebSocket. */
class FakeNtfy {
  readonly published: Record<string, unknown>[] = [];
  readonly #sockets = new Map<WebSocket, string[]>();
  #server: Server | null = null;
  #wss: WebSocketServer | null = null;
  url = "";

  async start() {
    this.#wss = new WebSocketServer({ noServer: true });
    this.#server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/v1/health") {
        res.writeHead(200, { "content-type": "application/json" }).end('{"healthy":true}');
        return;
      }
      if (req.method === "POST" && req.url === "/") {
        let text = "";
        for await (const chunk of req) text += chunk;
        const body = JSON.parse(text) as Record<string, unknown>;
        this.published.push(body);
        const msg = this.message(String(body.topic), String(body.message ?? ""), body);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg));
        this.deliver(msg);
        return;
      }
      res.writeHead(404).end();
    });
    this.#server.on("upgrade", (req, socket, head) => {
      const m = /^\/([^/]+)\/ws/.exec(req.url ?? "");
      if (!m?.[1]) {
        socket.destroy();
        return;
      }
      const topics = m[1].split(",");
      this.#wss?.handleUpgrade(req, socket, head, (ws) => {
        this.#sockets.set(ws, topics);
        ws.on("close", () => this.#sockets.delete(ws));
        ws.send(JSON.stringify({ id: "open", time: now(), event: "open", topic: m[1] }));
      });
    });
    await new Promise<void>((ok) => this.#server?.listen(0, "127.0.0.1", ok));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  message(topic: string, message: string, extra: Record<string, unknown> = {}) {
    return {
      id: randomBytes(6).toString("hex"),
      time: now(),
      event: "message",
      topic,
      message,
      ...(typeof extra.title === "string" ? { title: extra.title } : {}),
    };
  }

  /** Sends a message to everyone subscribed to its topic, as a publish from elsewhere would. */
  deliver(msg: { topic: string }) {
    for (const [ws, topics] of this.#sockets) {
      if (topics.includes(msg.topic)) ws.send(JSON.stringify(msg));
    }
  }

  subscribers(topic: string): number {
    return [...this.#sockets.values()].filter((t) => t.includes(topic)).length;
  }

  async stop() {
    for (const ws of this.#sockets.keys()) ws.terminate();
    this.#wss?.close();
    await new Promise<void>((ok) => (this.#server ? this.#server.close(() => ok()) : ok()));
  }
}

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- setup

beforeAll(async () => {
  // Outside the repo, as a developer's own folder would be.
  work = mkdtempSync(join(tmpdir(), "sling-stage4-"));

  // The catalog that ships with Sling, built from the examples the way
  // `pnpm extensions:build` builds it.
  const included = join(work, "included");
  for (const example of ["ntfy", "fly-machines", "task-alerts"]) {
    const project = await loadProject(join(ROOT, "extensions", example));
    await buildProject(project);
    await packProject(project, { outDir: included });
  }
  await writeCatalog(included, { name: "Included with Sling" });

  static_ = new StaticServer(join(work, "site"));
  mkdirSync(static_.root, { recursive: true });
  await static_.start();

  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  const port = await new Promise<number>((ok) => {
    const s = createServer().listen(0, () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => ok(p));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL(origin),
    secretKey: "stage4-e2e-secret-key-long-enough-0123",
    host: "127.0.0.1",
    port,
    logLevel: "warn",
    webDist: undefined,
    // For the loopback catalog and the unsigned local variants of the examples.
    allowUnsignedExtensions: true,
    includedExtensionsDir: included,
    extensionCacheDir: join(work, "cache"),
    testing: { allowLocalCloneUrls: true },
  };
  // No runtime option: the server runs extensions the way it does in production.
  server = await startServer(config, { jobs: false, nodes: [recordNode] });
  server.ctx.connectors.backoffBaseMs = 200;
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });

  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  machine = new FakeRunner({
    url: server.url,
    name: "laptop",
    repos: [{ name: "site", remoteUrl: REMOTE, defaultBranch: "main" }],
    harnesses: ["codex"],
  });
  await machine.pair(code);
  await machine.connect();
}, 240_000);

afterAll(async () => {
  machine?.close();
  await server?.close();
  await static_?.stop();
  await pg?.stop();
  if (work) rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests

it("runs on a server that can isolate extension code", () => {
  expect(server.ctx.extensions.runtime.unsupportedReason).toBeNull();
});

describe("an extension made with sling-ext outside the repo", () => {
  const hook = { body: "v1", posts: [] as string[] };
  let hookServer: Server;
  let hookUrl = "";
  let extId = "";

  beforeAll(async () => {
    hookServer = createServer(async (req, res) => {
      if (req.method === "POST") {
        let text = "";
        for await (const chunk of req) text += chunk;
        hook.posts.push(JSON.parse(text).message);
        res.writeHead(200).end("ok");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end(hook.body);
    });
    await new Promise<void>((ok) => hookServer.listen(0, "127.0.0.1", ok));
    hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook`;
  });
  afterAll(async () => {
    await new Promise<void>((ok) => hookServer.close(() => ok()));
  });

  it("is made, built, checked, signed, and cataloged with the CLI", async () => {
    await cli(
      work,
      "init",
      "hello",
      "--kind",
      "connector",
      "--name",
      "Hello hooks",
      "--publisher",
      "Hello Co",
    );
    const dir = join(work, "hello");
    const manifestPath = join(dir, "sling-extension.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    extId = manifest.id;
    // A developer trying it against a service on their own machine, polling faster than the starter allows.
    manifest.permissions.network.localNetwork = true;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const src = join(dir, "src/index.ts");
    writeFileSync(src, readFileSync(src, "utf8").replace(".min(30)", ".min(1)"));

    await cli(dir, "build");
    const check = await cli(dir, "check");
    expect(check).toContain(`${extId}.post`);
    const keygen = await cli(
      work,
      "keygen",
      "--out",
      join(work, "key.json"),
      "--publisher",
      "Hello Co",
    );
    expect(keygen).toMatch(/[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}/);
    await cli(dir, "pack", "--sign", join(work, "key.json"), "--out", static_.root);
    await cli(work, "catalog", static_.root, "--name", "Hello extensions");
    expect(existsSync(join(static_.root, "catalog.json"))).toBe(true);
  });

  it("installs from its catalog after you trust the publisher by fingerprint", async () => {
    const catalog = await api<CatalogView>("POST", "/api/extension-catalogs", {
      url: `${static_.base}/catalog.json`,
    });
    expect(catalog).toMatchObject({ name: "Hello extensions", extensionCount: 1, error: null });
    const entry = (await api<DiscoverEntryView[]>("GET", "/api/extensions/discover")).find(
      (e) => e.id === extId,
    );
    expect(entry).toMatchObject({
      catalogId: catalog.id,
      publisher: { name: "Hello Co", trusted: false },
    });

    const preview = await fromCatalog(catalog.id, extId, entry?.latest?.version);
    expect(preview).toMatchObject({ signed: true, publisher: { trusted: false } });
    const keyId = JSON.parse(readFileSync(join(work, "key.json"), "utf8")).keyId as string;
    expect(preview.publisher?.fingerprint.replaceAll(" ", "")).toBe(keyId);
    expect(preview.permissions.map((p) => p.key)).toContain("localNetwork");

    const refused = await raw("POST", "/api/extensions/install", {
      stagingId: preview.stagingId,
      digest: preview.digest,
      permissions: preview.permissionsKey,
    });
    expect(refused.status).toBe(409);
    const view = await install(preview, { trustPublisher: true });
    expect(view).toMatchObject({ id: extId, signed: true, publisher: { trusted: true } });

    const connectors = await api<ConnectorView[]>("GET", "/api/connectors");
    expect(connectors.find((c) => c.id === extId)?.extension).toMatchObject({ id: extId });
  });

  it("runs a workflow through its trigger and its action", async () => {
    const inst = await api<InstallationView>("POST", "/api/installations", {
      connectorId: extId,
      name: "Local hook",
      credentials: {},
      config: { url: hookUrl, pollSeconds: 1 },
    });
    const tested = await api<{ ok: boolean }>("POST", `/api/installations/${inst.id}/test`);
    expect(tested.ok).toBe(true);
    await workflow({
      schema: "sling.workflow/v1",
      name: "Hook relay",
      description: "",
      nodes: [
        node("t", `${extId}.changed`, { installationId: inst.id }),
        node("p", `${extId}.post`, {
          installationId: inst.id,
          message: '={{ "changed to " & trigger.body }}',
        }),
      ],
      edges: [exec("t", "p")],
    });
    await until("the source to connect", async () => {
      const list = await api<InstallationView[]>("GET", "/api/installations");
      return list.find((i) => i.id === inst.id)?.status === "connected";
    });
    // Let it see v1 once, so v2 counts as a change.
    await new Promise((r) => setTimeout(r, 1500));
    hook.body = "v2";
    await until("the post", async () => hook.posts.includes("changed to v2"));
    const view = (await api<ExtensionView[]>("GET", "/api/extensions")).find((e) => e.id === extId);
    expect(view).toMatchObject({ status: "running", usedBy: { installations: 1, workflows: 1 } });
  });
});

describe("the examples that ship with Sling", () => {
  let ntfy: FakeNtfy | null = null;
  let ntfyServer = "https://ntfy.sh";
  const topicOut = `sling-test-out-${randomBytes(8).toString("hex")}`;
  const topicIn = `sling-test-in-${randomBytes(8).toString("hex")}`;

  beforeAll(async () => {
    if (!LIVE_NTFY) {
      ntfy = new FakeNtfy();
      await ntfy.start();
      ntfyServer = ntfy.url;
    }
  });
  afterAll(async () => {
    await ntfy?.stop();
  });

  it("are listed in Discover from the included catalog", async () => {
    const entries = (await api<DiscoverEntryView[]>("GET", "/api/extensions/discover")).filter(
      (e) => e.catalogId === "included",
    );
    expect(entries.map((e) => [e.id, e.kinds]).sort()).toEqual([
      ["fly-machines", ["provider"]],
      ["ntfy", ["connector"]],
      ["task-alerts", ["workflows"]],
    ]);
    for (const e of entries) {
      expect(e).toMatchObject({
        catalogName: "Included with Sling",
        publisher: null,
        unavailable: null,
      });
    }
    const started = performance.now();
    const preview = await fromCatalog("included", "ntfy", "1.2.0");
    // Reading, verifying, and describing a package with code, in a fresh restricted process.
    console.log(`preview of the included ntfy: ${Math.round(performance.now() - started)} ms`);
    expect(preview).toMatchObject({ source: "included", problems: [] });
    expect(preview.permissions.map((p) => p.key)).toEqual(["host:ntfy.sh", "configHost:server"]);
    const alerts = await fromCatalog("included", "task-alerts", "1.0.1");
    expect(alerts.missing.extensions).toMatchObject([{ id: "ntfy", catalogId: "included" }]);
    expect(alerts.problems.length).toBeGreaterThan(0);
  });

  it("send a push notification when a task finishes, and start workflows from ntfy messages", async () => {
    if (LIVE_NTFY) {
      await install(await fromCatalog("included", "ntfy", "1.2.0"));
    } else {
      // The same code, allowed to reach the fake ntfy on loopback.
      const preview = await api<ExtensionPreview>(
        "POST",
        "/api/extensions/preview",
        await localVariant("ntfy"),
      );
      await install(preview);
    }
    const alerts = await install(await fromCatalog("included", "task-alerts", "1.0.1"));
    expect(alerts).toMatchObject({ kinds: ["workflows"], source: "included" });

    // The setup form's lookup runs in the extension's own process: a topic first, then a link to it.
    const suggested = await api<{ config?: { defaultTopic?: string } }>(
      "POST",
      "/api/connectors/ntfy/setup",
      {},
    );
    expect(suggested.config?.defaultTopic).toMatch(/^sling-[a-z0-9]{12}$/);
    const linked = await api<{ notes?: { link?: { url: string } }[] }>(
      "POST",
      "/api/connectors/ntfy/setup",
      { config: { server: ntfyServer, defaultTopic: topicOut } },
    );
    expect(linked.notes?.[0]?.link?.url).toBe(`${ntfyServer.replace(/\/+$/, "")}/${topicOut}`);

    // Add tests the connection first, before any installation names this server.
    const inst = await api<InstallationView>("POST", "/api/installations", {
      connectorId: "ntfy",
      name: "ntfy",
      credentials: {},
      config: { server: ntfyServer, topics: [topicIn], defaultTopic: topicOut },
      check: true,
    });
    expect((await api<{ ok: boolean }>("POST", `/api/installations/${inst.id}/test`)).ok).toBe(
      true,
    );

    const templates = await api<{ key: string; extension: { id: string } | null }[]>(
      "GET",
      "/api/templates",
    );
    const key = "task-alerts/notify-task-finished";
    expect(templates.find((t) => t.key === key)?.extension?.id).toBe("task-alerts");
    const wf = await api<{ id: string }>("POST", "/api/workflows", {
      templateKey: key,
      bindings: { $ntfy: inst.id },
    });
    await api("PATCH", `/api/workflows/${wf.id}`, { enabled: true });

    // A second workflow, started by messages on the watched topic.
    await workflow({
      schema: "sling.workflow/v1",
      name: "From ntfy",
      description: "",
      nodes: [
        node("t", "ntfy.message_received", { installationId: inst.id }),
        node("r", "test.record", { tag: "ntfy" }),
      ],
      edges: [exec("t", "r"), data("t", "message", "r", "value")],
    });
    await until("the ntfy source to subscribe", async () => {
      const list = await api<InstallationView[]>("GET", "/api/installations");
      const ok = list.find((i) => i.id === inst.id)?.status === "connected";
      return ok && (ntfy ? ntfy.subscribers(topicIn) > 0 : true);
    });

    const created = await api<{ id: string }>("POST", "/api/tasks", {
      repo: "site",
      title: "Fix the footer",
      objective: "Change the footer.",
      deliver: "local",
      mode: "auto",
    });
    await until("the task to succeed", async () => (await task(created.id)).state === "succeeded");

    if (ntfy) {
      const sent = await until("the notification", async () =>
        ntfy?.published.find((p) => p.topic === topicOut),
      );
      expect(sent).toMatchObject({ title: "Done: Fix the footer", priority: 3 });
      ntfy.deliver(ntfy.message(topicIn, "deploy please"));
    } else {
      const sent = await until("the notification on ntfy.sh", async () => {
        const res = await fetch(`https://ntfy.sh/${topicOut}/json?poll=1&since=10m`);
        const lines = (await res.text()).trim().split("\n").filter(Boolean);
        return lines.map((l) => JSON.parse(l)).find((m) => m.event === "message");
      });
      expect(sent).toMatchObject({ title: "Done: Fix the footer" });
      const res = await fetch(`https://ntfy.sh/${topicIn}`, {
        method: "POST",
        body: "deploy please",
      });
      expect(res.ok).toBe(true);
    }
    const heard = await until("the ntfy trigger", async () =>
      calls.find(
        (c) => c.tag === "ntfy" && (c.value as { message?: string })?.message === "deploy please",
      ),
    );
    expect(heard.value).toMatchObject({ topic: topicIn });
  });
});

describe("a sandbox provider from an extension", () => {
  let fly: FakeMachinesApi;
  const booted: FakeRunner[] = [];
  let bare = "";

  beforeAll(async () => {
    fly = await startFakeMachinesApi({ apps: ["sling-sandboxes"] });
    fly.onCreate = async (m) => {
      // What the sandbox image does when it starts: pair with the code and connect.
      const env = m.config.env;
      const runner = new FakeRunner({
        // The sandbox would reach Sling at its public URL; here it's this process.
        url: server.url,
        name: `sandbox-${env[SANDBOX_ENV.sandboxId]}`,
        repos: (
          JSON.parse(env[SANDBOX_ENV.repos] ?? "[]") as { name: string; cloneUrl: string }[]
        ).map((r) => ({ name: r.name, remoteUrl: r.cloneUrl, defaultBranch: "main" })),
        harnesses: (env[SANDBOX_ENV.harnesses] ?? "codex").split(","),
      });
      booted.push(runner);
      await runner.pair(env[SANDBOX_ENV.pairCode] ?? "");
      await runner.connect();
    };
    bare = join(work, "remote.git");
    mkdirSync(bare);
  });
  afterAll(async () => {
    for (const r of booted) r.close();
    await fly?.close();
  });

  it("starts a sandbox whose Runner pairs and runs the task, then destroys it", async () => {
    const bytes = await localVariant("fly-machines");
    const started = performance.now();
    const preview = await api<ExtensionPreview>("POST", "/api/extensions/preview", bytes);
    expect(preview.permissions.find((p) => p.key === "sandboxes")).toMatchObject({ risk: "high" });
    expect(preview.contents.connectors).toEqual([
      { id: "fly-machines", name: "Fly Machines", isExecutionProvider: true },
    ]);
    await install(preview);
    console.log(
      `preview and install of Fly Machines: ${Math.round(performance.now() - started)} ms`,
    );

    const inst = await api<InstallationView>("POST", "/api/installations", {
      connectorId: "fly-machines",
      name: "fly",
      credentials: { apiToken: fly.token },
      config: {
        app: "sling-sandboxes",
        region: "ams",
        image: "registry.fly.io/sling-sandbox:test",
        controlPlaneUrl: "https://sling.example.com",
        apiUrl: fly.url,
      },
    });
    expect((await api<{ ok: boolean }>("POST", `/api/installations/${inst.id}/test`)).ok).toBe(
      true,
    );
    await api("PUT", `/api/sandbox-repos/${encodeURIComponent(KEY)}`, {
      cloneUrl: `file://${bare}`,
      defaultBranch: "main",
    });

    const created = await api<{ id: string; environment: string }>("POST", "/api/tasks", {
      repo: "site",
      title: "Fix it in a sandbox",
      objective: "Change the footer.",
      deliver: "local",
      mode: "auto",
      environment: "sandbox",
      providerInstallationId: inst.id,
    });
    expect(created.environment).toBe("sandbox");
    let last: unknown = null;
    const done = await until("delivered and destroyed", async () => {
      const t = await task(created.id);
      last = { state: t.state, sandbox: t.environment.sandboxState, error: t.error };
      return t.state === "succeeded" && t.environment.sandboxState === "destroyed" ? t : null;
    }).catch((err: Error) => {
      throw new Error(`${err.message}: ${JSON.stringify(last)}`);
    });
    expect(done.environment.providerName).toBe("fly");

    const create = fly.requests.find((r) => r.method === "POST" && r.path.endsWith("/machines"));
    if (!create) throw new Error("the provider never created a machine");
    const env = (create.body as { config: { env: Record<string, string> } }).config.env;
    expect(env[SANDBOX_ENV.sandboxId]).toBe(done.environment.sandboxId);
    expect(env[SANDBOX_ENV.pairCode]).toBeTruthy();
    expect(env[SANDBOX_ENV.url]).toBe("https://sling.example.com");
    expect(fly.requests.some((r) => r.method === "DELETE")).toBe(true);
    expect([...fly.machines.values()].map((m) => m.state)).toEqual(["destroyed"]);
  });

  it("removes a machine Sling doesn't know about on the next sweep", async () => {
    const [m] = await server.ctx.db.select().from(schema.workspaceMembers).limit(1);
    fly.machines.set("orphan1", {
      id: "orphan1",
      app: "sling-sandboxes",
      name: "sling-orphan",
      state: "started",
      region: "ams",
      created_at: new Date().toISOString(),
      config: {
        image: "registry.fly.io/sling-sandbox:test",
        env: {},
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
        metadata: { sling_sandbox: "sbx_orphan", sling_workspace: m?.workspaceId ?? "" },
      },
    });
    await server.ctx.sandboxes.sweep();
    await until("the orphan to go", async () => fly.machines.get("orphan1")?.state === "destroyed");
    const list = await api<SandboxListView>("GET", "/api/sandboxes");
    expect(list.sandboxes.every((s) => s.state === "destroyed")).toBe(true);
  });

  it("won't disable the provider while one of its sandboxes is live", async () => {
    const [m] = await server.ctx.db.select().from(schema.workspaceMembers).limit(1);
    const [inst] = await server.ctx.db
      .select({ id: schema.connectorInstallations.id })
      .from(schema.connectorInstallations)
      .where(eq(schema.connectorInstallations.connectorId, "fly-machines"));
    if (!m || !inst) throw new Error("the Fly installation is missing");
    await server.ctx.db.insert(schema.sandboxes).values({
      id: "sbx_live_on_disable",
      workspaceId: m.workspaceId,
      ownerId: m.userId,
      providerInstallationId: inst.id,
      state: "ready",
      remoteKey: KEY,
      readyAt: new Date(),
    });
    const refused = await raw("PATCH", "/api/extensions/fly-machines", { enabled: false });
    expect(refused.status).toBe(409);
    expect(refused.text).toMatch(/still has 1 sandbox/);

    await server.ctx.db
      .update(schema.sandboxes)
      .set({ state: "destroyed", destroyedAt: new Date() })
      .where(eq(schema.sandboxes.id, "sbx_live_on_disable"));
    await api("PATCH", "/api/extensions/fly-machines", { enabled: false });
    await api("PATCH", "/api/extensions/fly-machines", { enabled: true });
  });
});
