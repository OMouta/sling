import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AnyConnector } from "@sling/connector-sdk";
import { type AnyNodeSpec, type Installation, NodeError } from "@sling/workflow";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  alive,
  type FixtureExtension,
  fakeNodeContext,
  fakeSourceContext,
  fixtureExtension,
  SDK,
  type TestRuntime,
  testRuntime,
  waitFor,
} from "../../test/fixtures/extension-processes.ts";
import type { Resolver } from "./broker.ts";
import { canDenyNetwork, ProcessRuntime } from "./process-runtime.ts";

const ACME = `${SDK}
const node = (spec) =>
  defineNode({
    title: spec.type,
    description: "",
    category: "action",
    inputs: [],
    outputs: [],
    execInput: true,
    execOutputs: [{ name: "next" }],
    idempotent: false,
    version: 1,
    configSchema: z.object({}),
    ...spec,
  });

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("the node saw the abort"));
    });
  });

const nodes = [
  node({
    type: "acme.echo",
    configSchema: z.object({
      n: z.number().default(7),
      nested: z.object({ flag: z.boolean().default(true) }).prefault({}),
      label: z.string().transform((s) => s.toUpperCase()).optional(),
    }),
    async run(ctx, { inputs, config }) {
      ctx.log.info("echoing", { n: config.n });
      console.log("console says", config.n);
      return {
        exec: "next",
        outputs: {
          config,
          inputs,
          runId: ctx.runId,
          workspaceId: ctx.workspaceId,
          attempt: ctx.attempt,
          services: typeof ctx.services,
        },
      };
    },
  }),
  node({
    type: "acme.fail",
    async run() {
      throw new NodeError("Rate limited", { code: "rate_limited", retryable: true });
    },
  }),
  node({
    type: "acme.plainfail",
    async run() {
      throw new TypeError("bad thing");
    },
  }),
  node({
    type: "acme.spam",
    async run() {
      for (let i = 0; i < 250; i++) console.log("line " + i);
      return { exec: "next" };
    },
  }),
  node({
    type: "acme.badresult",
    async run() {
      return { exec: 42 };
    },
  }),
  node({
    type: "acme.huge",
    async run() {
      return { exec: "next", outputs: { s: "x".repeat(20 * 1024 * 1024) } };
    },
  }),
  node({
    type: "acme.wait",
    configSchema: z.object({ kind: z.string() }),
    async run(_ctx, { config }) {
      const waits = {
        timer: { kind: "timer", until: new Date("2030-01-01T00:00:00Z") },
        own: { kind: "event", eventType: "acme.done", key: "k1" },
        foreign: { kind: "event", eventType: "core.manual", key: "k1" },
        approval: { kind: "approval", approvalId: "apv_1" },
      };
      return { wait: waits[config.kind], outputs: { waiting: true } };
    },
    async resume(_ctx, { resolution }) {
      return { exec: "next", outputs: { resolution } };
    },
  }),
  node({
    type: "acme.installation",
    configSchema: z.object({ id: z.string() }),
    async run(ctx, { config }) {
      const inst = await ctx.installation(config.id);
      return { exec: "next", outputs: { connectorId: inst.connectorId, credentials: inst.credentials } };
    },
  }),
  node({
    type: "acme.sleep",
    configSchema: z.object({ ms: z.number() }),
    async run(ctx, { config }) {
      await sleep(config.ms, ctx.signal);
      return { exec: "next", outputs: { slept: config.ms } };
    },
  }),
  node({
    type: "acme.fetch",
    configSchema: z.object({ url: z.string(), method: z.string().default("GET"), body: z.string().optional() }),
    async run(_ctx, { config }) {
      try {
        const res = await fetch(config.url, { method: config.method, body: config.body, headers: { "x-acme": "1" } });
        return {
          exec: "next",
          outputs: { status: res.status, body: await res.text(), url: res.url, redirected: res.redirected, type: res.headers.get("content-type") },
        };
      } catch (e) {
        return { exec: "next", outputs: { error: e.message, name: e.name } };
      }
    },
  }),
  node({
    type: "acme.ws",
    configSchema: z.object({ url: z.string() }),
    async run(_ctx, { config }) {
      const got = [];
      const ws = new WebSocket(config.url, "chat");
      ws.binaryType = "arraybuffer";
      const result = await new Promise((resolve) => {
        ws.onerror = (e) => got.push("error: " + e.message);
        ws.onopen = () => {
          ws.send("ping");
          ws.send(new Uint8Array([1, 2, 3]));
        };
        ws.addEventListener("message", (e) => {
          got.push(typeof e.data === "string" ? e.data : [...new Uint8Array(e.data)]);
          if (got.length === 3) ws.close(1000, "done");
        });
        ws.onclose = (e) => resolve({ code: e.code, reason: e.reason, protocol: ws.protocol });
      });
      return { exec: "next", outputs: { got, ...result } };
    },
  }),
  defineNode({
    type: "acme.on",
    version: 1,
    title: "On thing",
    description: "",
    category: "trigger",
    configSchema: z.object({ want: z.string().default("yes") }),
    inputs: [],
    outputs: [],
    execInput: false,
    execOutputs: [{ name: "next" }],
    idempotent: true,
    trigger: {
      event: "acme.thing",
      async match(event, config) {
        if (event.payload.v === "throw") throw new Error("match blew up");
        if (event.payload.v === "hang") return new Promise(() => {});
        if (event.payload.v !== config.want) return null;
        return { outputs: { v: event.payload.v, at: event.at instanceof Date } };
      },
    },
  }),
];

const acme = defineConnector({
  id: "acme",
  name: "Acme",
  description: "Acme things.",
  credentialsSchema: z.object({ token: z.string() }),
  secretFields: ["token"],
  configSchema: z.object({ server: z.string().default("https://api.acme.test"), mode: z.string().default("plain") }),
  async test({ credentials, config }) {
    return credentials.token === "good" ? { ok: true, detail: config.server } : { ok: false, error: "bad token" };
  },
  nodes,
  source: {
    async start(ctx) {
      ctx.setStatus("connected");
      await ctx.state.set("cursor", "41");
      const cursor = await ctx.state.get("cursor");
      await ctx.emit({ type: "acme.thing", payload: { v: "yes", cursor }, dedupeKey: "d1" });
      let foreign = "sent";
      try {
        await ctx.emit({ type: "core.manual", payload: {} });
      } catch (e) {
        foreign = e.message;
      }
      let decided = "none";
      if (ctx.config.mode === "approve") {
        try {
          decided = JSON.stringify(
            await ctx.approvals.decide({ approvalId: "apv_1", approve: true, actor: { via: "acme", externalUserId: "u1" } }),
          );
        } catch (e) {
          decided = e.message;
        }
      }
      await ctx.emit({ type: "acme.thing", payload: { v: "report", foreign, decided } });
      return { async stop() { ctx.log.info("source stopped"); } };
    },
  },
});

const sandbox = defineConnector({
  id: "acme.sandbox",
  name: "Acme sandboxes",
  description: "",
  credentialsSchema: z.object({ key: z.string() }),
  secretFields: ["key"],
  configSchema: z.object({}),
  async test() { return { ok: true }; },
  nodes: [],
  executionProvider: {
    async create(ctx, spec) {
      return { externalId: "ext-" + spec.sandboxId, detail: ctx.credentials.key.length + " " + Object.keys(spec.env).join(",") };
    },
    async destroy() {},
    async list(ctx) {
      return [{ externalId: "ext-1", sandboxId: "sbx_1" }, { externalId: "ext-2", sandboxId: ctx.installationId }];
    },
  },
});

export default defineExtension({ connectors: [acme, sandbox] });
`;

let server: Server;
let wss: WebSocketServer;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/redirect")) {
      res.writeHead(302, { location: "/landed" });
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          acme: req.headers["x-acme"] ?? null,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    socket.send(`hello ${req.headers["sec-websocket-protocol"] ?? ""}`);
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const c of wss.clients) c.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const resolver: Resolver = async (host) => {
  if (host.endsWith(".acme.test") || host === "evil.test")
    return [{ address: "127.0.0.1", family: 4 }];
  throw new Error(`getaddrinfo ENOTFOUND ${host}`);
};

function nodeOf(connectors: AnyConnector[], type: string): AnyNodeSpec {
  for (const c of connectors) {
    const n = c.nodes.find((x) => x.type === type);
    if (n) return n;
  }
  throw new Error(`no node ${type}`);
}

async function run(
  connectors: AnyConnector[],
  type: string,
  config: Record<string, unknown> = {},
  inputs: Record<string, unknown> = {},
  installations: Record<string, Installation> = {},
) {
  const fake = fakeNodeContext(installations);
  const result = await nodeOf(connectors, type).run?.(fake.ctx, { inputs, config });
  return { result, ...fake };
}

function failure(p: Promise<unknown>): Promise<Error & { code?: string; retryable?: boolean }> {
  return p.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: Error) => e,
  );
}

describe("the runtime on this Node", () => {
  it("can deny network", () => {
    expect(canDenyNetwork()).toBe(true);
    expect(new ProcessRuntime().unsupportedReason).toBeNull();
  });

  it("runs no extension code on a Node that can't deny network", async () => {
    const real = testRuntime();
    const ext = await fixtureExtension(real.runtime, { id: "acme", source: ACME });
    await real.runtime.stopAll();
    // As on Node 24, which has the permission model but no --allow-net.
    const spy = vi
      .spyOn(process, "allowedNodeEnvironmentFlags", "get")
      .mockReturnValue(new Set(["--permission"]));
    try {
      const t = testRuntime();
      const reason = `Extensions need Node 26 or later. This server runs Node ${process.versions.node}.`;
      expect(t.runtime.unsupportedReason).toBe(reason);
      await expect(t.runtime.describe(ext)).rejects.toThrow(reason);
      const connectors = t.runtime.activate(ext);
      expect(t.statuses).toEqual([{ id: "acme", status: "unsupported", detail: reason }]);
      const err = await failure(run(connectors, "acme.echo"));
      expect(err).toMatchObject({ code: "extension_unsupported", message: reason });
      expect(t.runtime.host("acme")?.process).toBeNull();
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});

describe("an extension's connectors", () => {
  let t: TestRuntime;
  let ext: FixtureExtension;
  let connectors: AnyConnector[];

  beforeAll(async () => {
    t = testRuntime({ network: { resolver } });
    ext = await fixtureExtension(t.runtime, {
      id: "acme",
      source: ACME,
      manifest: {
        permissions: {
          network: {
            hosts: ["api.acme.test", "*.cdn.acme.test"],
            configHosts: ["server"],
            localNetwork: true,
          },
        },
      },
      granted: {
        network: {
          hosts: ["api.acme.test", "*.cdn.acme.test"],
          configHosts: ["server"],
          localNetwork: true,
        },
      },
    });
    connectors = t.runtime.activate(ext);
  }, 30_000);

  afterAll(async () => {
    await t.runtime.stopAll();
  });

  it("describes what the extension adds", () => {
    expect(ext.description.connectors.map((c) => c.id)).toEqual(["acme", "acme.sandbox"]);
    const echo = ext.description.connectors[0]?.nodes.find((n) => n.type === "acme.echo");
    expect(echo?.configSchema).toMatchObject({ type: "object", properties: { n: { default: 7 } } });
    expect(ext.description.connectors[0]?.hasSource).toBe(true);
    expect(ext.description.connectors[1]?.isExecutionProvider).toBe(true);
  });

  it("builds schemas the server can validate with", () => {
    const [acme] = connectors as [AnyConnector];
    expect(acme.configSchema.parse({})).toEqual({ server: "https://api.acme.test", mode: "plain" });
    expect(acme.credentialsSchema.safeParse({}).success).toBe(false);
    expect(acme.credentialsSchema.parse({ token: "t" })).toEqual({ token: "t" });
    expect(acme.secretFields).toEqual(["token"]);
    const echo = nodeOf(connectors, "acme.echo");
    expect(echo.configSchema.safeParse({ n: "x" }).success).toBe(false);
    expect(echo.connector).toBe("acme");
  });

  it("runs a node with the extension's own schema, defaults, and transforms", async () => {
    const { result, lines } = await run(connectors, "acme.echo", { label: "shout" }, { a: 1 });
    expect(result).toEqual({
      exec: "next",
      outputs: {
        config: { n: 7, nested: { flag: true }, label: "SHOUT" },
        inputs: { a: 1 },
        runId: "run_1",
        workspaceId: "ws_1",
        attempt: 1,
        services: "undefined",
      },
    });
    expect(lines).toContainEqual({ level: "info", message: "echoing", data: { data: { n: 7 } } });
    expect(lines.map((l) => l.message)).toContain("console says 7");
    expect(t.runtime.log("acme").map((l) => l.message)).toContain("console says 7");
  });

  it("refuses config the extension's schema rejects", async () => {
    const err = await failure(run(connectors, "acme.echo", { n: "seven" }));
    expect(err).toBeInstanceOf(NodeError);
    expect(err.code).toBe("invalid_config");
    expect(err.message).toMatch(/^Invalid config: n:/);
  });

  it("keeps a NodeError's code and retryable flag", async () => {
    const err = await failure(run(connectors, "acme.fail"));
    expect(err).toBeInstanceOf(NodeError);
    expect(err).toMatchObject({ message: "Rate limited", code: "rate_limited", retryable: true });
    const plain = await failure(run(connectors, "acme.plainfail"));
    expect(plain).not.toBeInstanceOf(NodeError);
    expect(plain).toBeInstanceOf(TypeError);
    expect(plain.message).toBe("bad thing");
  });

  it("keeps the last 200 lines of the extension's log, and limits the server log", async () => {
    const before = t.serverLog.length;
    const { lines: nodeLines } = await run(connectors, "acme.spam");
    const lines = t.runtime.log("acme");
    expect(lines).toHaveLength(200);
    expect(lines.at(-1)?.message).toBe("line 249");
    expect(lines.at(-1)?.at).toBeInstanceOf(Date);
    // At most 100 lines a second go on to the server log.
    expect(nodeLines.length + t.serverLog.length - before).toBeLessThanOrEqual(200);
    expect(nodeLines.length).toBeLessThan(250);
  });

  it("refuses results that aren't node results", async () => {
    const err = await failure(run(connectors, "acme.badresult"));
    expect(err).toMatchObject({ code: "invalid_result" });
  });

  it("refuses messages over 16 MB both ways", async () => {
    const err = await failure(run(connectors, "acme.huge"));
    expect(err.message).toMatch(/over the 16 MB limit/);
    const big = await failure(
      run(connectors, "acme.echo", {}, { big: "y".repeat(17 * 1024 * 1024) }),
    );
    expect(big.message).toMatch(/over the 16 MB limit/);
    // The process survived both.
    expect((await run(connectors, "acme.echo")).result).toMatchObject({ exec: "next" });
  });

  it("allows waits for timers and the extension's own events only", async () => {
    const timer = (await run(connectors, "acme.wait", { kind: "timer" })).result as {
      wait: { until: Date };
    };
    expect(timer.wait.until).toEqual(new Date("2030-01-01T00:00:00Z"));
    expect((await run(connectors, "acme.wait", { kind: "own" })).result).toMatchObject({
      wait: { kind: "event", eventType: "acme.done", key: "k1" },
    });
    for (const kind of ["foreign", "approval"]) {
      const err = await failure(run(connectors, "acme.wait", { kind }));
      expect(err).toMatchObject({ code: "invalid_wait" });
    }
  });

  it("resumes nodes that have resume", async () => {
    const spec = nodeOf(connectors, "acme.wait");
    expect(typeof spec.resume).toBe("function");
    expect(nodeOf(connectors, "acme.echo").resume).toBeUndefined();
    const { ctx } = fakeNodeContext();
    const out = await spec.resume?.(ctx, {
      inputs: {},
      config: { kind: "timer" },
      resolution: { kind: "timer" },
    });
    expect(out).toEqual({ exec: "next", outputs: { resolution: { kind: "timer" } } });
  });

  it("runs the connection test", async () => {
    const [acme] = connectors as [AnyConnector];
    const log = fakeNodeContext().ctx.log;
    const signal = AbortSignal.timeout(5_000);
    expect(await acme.test({ credentials: { token: "good" }, config: {}, log, signal })).toEqual({
      ok: true,
      detail: "https://api.acme.test",
    });
    expect(await acme.test({ credentials: { token: "nope" }, config: {}, log, signal })).toEqual({
      ok: false,
      error: "bad token",
    });
  });

  it("matches trigger events, and treats errors and slow matches as no match", async () => {
    const on = nodeOf(connectors, "acme.on");
    expect(on.run).toBeUndefined();
    const event = (v: string) => ({
      type: "acme.thing",
      workspaceId: "ws_1",
      installationId: "ins_1",
      payload: { v },
      at: new Date(),
    });
    expect(await on.trigger?.match(event("yes"), { want: "yes" })).toEqual({
      outputs: { v: "yes", at: true },
    });
    expect(await on.trigger?.match(event("no"), {})).toBeNull();
    expect(await on.trigger?.match(event("throw"), {})).toBeNull();
    expect(
      t.runtime
        .log("acme")
        .map((l) => l.message)
        .join("\n"),
    ).toMatch(/match blew up/);
    const started = Date.now();
    expect(await on.trigger?.match(event("hang"), {})).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(t.runtime.log("acme").at(-1)?.message).toMatch(
      /didn't finish the trigger within 1 second/,
    );
  });

  it("reads installations of its own connectors only", async () => {
    const installations: Record<string, Installation> = {
      ins_own: {
        id: "ins_own",
        connectorId: "acme",
        name: "Mine",
        credentials: { token: "s3cret" },
        config: {},
      },
      ins_discord: {
        id: "ins_discord",
        connectorId: "discord",
        name: "Discord",
        credentials: { token: "discord-token" },
        config: {},
      },
    };
    const own = await run(connectors, "acme.installation", { id: "ins_own" }, {}, installations);
    expect(own.result).toEqual({
      exec: "next",
      outputs: { connectorId: "acme", credentials: { token: "s3cret" } },
    });
    expect(own.secrets.has("s3cret")).toBe(true);
    const other = await failure(
      run(connectors, "acme.installation", { id: "ins_discord" }, {}, installations),
    );
    expect(other).toBeInstanceOf(NodeError);
    expect(other).toMatchObject({ code: "installation_not_allowed" });
    expect(other.message).toMatch(/belongs to discord/);
    const missing = await failure(
      run(connectors, "acme.installation", { id: "ins_none" }, {}, installations),
    );
    expect(missing).toMatchObject({ code: "no_installation" });
  });

  it("aborts a node when the engine cancels it", async () => {
    const fake = fakeNodeContext();
    const pending = nodeOf(connectors, "acme.sleep").run?.(fake.ctx, {
      inputs: {},
      config: { ms: 5_000 },
    }) as Promise<unknown>;
    setTimeout(() => fake.abort.abort(new DOMException("cancelled", "AbortError")), 50);
    const err = await failure(pending);
    expect(err.name).toBe("AbortError");
  });

  it("fetches through the server, to allowed hosts only", async () => {
    const ok = await run(connectors, "acme.fetch", {
      url: `http://api.acme.test:${port}/hello`,
      method: "POST",
      body: "hi",
    });
    expect(ok.result).toMatchObject({
      outputs: { status: 200, type: "application/json", url: `http://api.acme.test:${port}/hello` },
    });
    const body = JSON.parse((ok.result as unknown as { outputs: { body: string } }).outputs.body);
    expect(body).toMatchObject({
      method: "POST",
      body: "hi",
      acme: "1",
      host: `api.acme.test:${port}`,
    });

    const wild = await run(connectors, "acme.fetch", { url: `http://img.cdn.acme.test:${port}/x` });
    expect(wild.result).toMatchObject({ outputs: { status: 200 } });

    const redirected = await run(connectors, "acme.fetch", {
      url: `http://api.acme.test:${port}/redirect`,
    });
    expect(redirected.result).toMatchObject({
      outputs: { status: 200, redirected: true, url: `http://api.acme.test:${port}/landed` },
    });

    ext.configHostSet.add("hooks.example.acme.test");
    const fromConfig = await run(connectors, "acme.fetch", {
      url: `http://hooks.example.acme.test:${port}/c`,
    });
    expect(fromConfig.result).toMatchObject({ outputs: { status: 200 } });

    const refused = await run(connectors, "acme.fetch", { url: `http://evil.test:${port}/` });
    expect(refused.result).toEqual({
      exec: "next",
      outputs: {
        name: "TypeError",
        error: "Sling refused the request: evil.test isn't in this extension's network permissions",
      },
    });
    expect(t.runtime.log("acme").map((l) => l.message)).toContain(
      "Sling refused the request: evil.test isn't in this extension's network permissions",
    );
    expect(t.serverLog.some((l) => l.msg === "refused an extension's network request")).toBe(true);
  });

  it("opens WebSockets through the server", async () => {
    const out = await run(connectors, "acme.ws", { url: `ws://api.acme.test:${port}/socket` });
    expect(out.result).toEqual({
      exec: "next",
      outputs: {
        got: ["hello chat", "ping", [1, 2, 3]],
        code: 1000,
        reason: "done",
        protocol: "chat",
      },
    });
    const refused = await run(connectors, "acme.ws", { url: `ws://evil.test:${port}/socket` });
    expect(refused.result).toMatchObject({
      outputs: {
        got: [
          "error: Sling refused the connection: evil.test isn't in this extension's network permissions",
        ],
        code: 1006,
      },
    });
  });

  it("runs event sources against the real source context", async () => {
    const [acme] = connectors as [AnyConnector];
    const fake = fakeSourceContext({ token: "t" }, { server: "x", mode: "approve" });
    const source = await acme.source?.start(fake.ctx);
    expect(fake.statuses).toEqual([{ status: "connected" }]);
    expect(fake.state.get("cursor")).toBe("41");
    expect(fake.emitted[0]).toEqual({
      type: "acme.thing",
      payload: { v: "yes", cursor: "41" },
      dedupeKey: "d1",
    });
    const report = fake.emitted[1]?.payload as { foreign: string; decided: string };
    expect(report.foreign).toMatch(/Sling refused the event core.manual/);
    // The extension wasn't granted approvals.
    expect(report.decided).toMatch(/doesn't have the approvals permission/);
    expect(fake.decided).toEqual([]);
    await source?.stop();
    // The extension's own stop ran, and logged to the source's log.
    expect(fake.lines).toContainEqual({ level: "info", message: "source stopped" });
  });

  it("gives providers only to extensions granted sandboxes", async () => {
    const [, sandbox] = connectors as [AnyConnector, AnyConnector];
    expect(sandbox.id).toBe("acme.sandbox");
    expect(sandbox.executionProvider).toBeUndefined();
  });
});

describe("bundles that don't load", () => {
  it("says why describe failed", async () => {
    const t = testRuntime();
    await expect(
      fixtureExtension(t.runtime, {
        id: "broken",
        source: `${SDK}\nthrow new Error("boom at load");\n`,
      }),
    ).rejects.toThrow("The extension failed to start: its code failed to load: boom at load");
    await expect(
      fixtureExtension(t.runtime, { id: "broken", source: "export default { hello: 1 };" }),
    ).rejects.toThrow("The bundle's default export isn't defineExtension(...)");
    await expect(
      fixtureExtension(t.runtime, { id: "broken", source: "process.exit(9);" }),
    ).rejects.toThrow("The extension failed to start: it exited with code 9");
  }, 30_000);
});

describe("permissions granted", () => {
  let t: TestRuntime;
  let connectors: AnyConnector[];

  beforeAll(async () => {
    t = testRuntime();
    const ext = await fixtureExtension(t.runtime, {
      id: "acme",
      source: ACME,
      manifest: { permissions: { approvals: true, sandboxes: true } },
    });
    connectors = t.runtime.activate(ext);
  }, 30_000);

  afterAll(async () => {
    await t.runtime.stopAll();
  });

  it("lets a source decide approvals with the approvals permission", async () => {
    const [acme] = connectors as [AnyConnector];
    const fake = fakeSourceContext({ token: "t" }, { mode: "approve" });
    const source = await acme.source?.start(fake.ctx);
    expect(fake.decided).toEqual([
      { approvalId: "apv_1", approve: true, actor: { via: "acme", externalUserId: "u1" } },
    ]);
    expect((fake.emitted[1]?.payload as { decided?: string } | undefined)?.decided).toBe(
      JSON.stringify({ ok: true, message: "Approved." }),
    );
    await source?.stop();
  });

  it("provides sandboxes with the sandboxes permission", async () => {
    const provider = connectors[1]?.executionProvider;
    expect(provider).toBeDefined();
    const log = fakeNodeContext().ctx.log;
    const pctx = {
      installationId: "ins_9",
      workspaceId: "ws_1",
      credentials: { key: "k3y" },
      config: {},
      log,
      signal: AbortSignal.timeout(5_000),
    };
    const spec = {
      sandboxId: "sbx_7",
      workspaceId: "ws_1",
      image: "img",
      env: { SLING_PAIRING_CODE: "123" },
      labels: {},
      lifetimeSeconds: 60,
    };
    expect(await provider?.create(pctx, spec)).toEqual({
      externalId: "ext-sbx_7",
      detail: "3 SLING_PAIRING_CODE",
    });
    expect(await provider?.list(pctx)).toEqual([
      { externalId: "ext-1", sandboxId: "sbx_1" },
      { externalId: "ext-2", sandboxId: "ins_9" },
    ]);
    await expect(provider?.destroy(pctx, "ext-1")).resolves.toBeUndefined();
  });
});

const VERSIONED = (version: string) => `${SDK}
export default defineExtension({
  connectors: [
    defineConnector({
      id: "swap",
      name: "Swap",
      description: "",
      credentialsSchema: z.object({}),
      secretFields: [],
      configSchema: z.object({}),
      async test() { return { ok: true }; },
      nodes: [
        defineNode({
          type: "swap.which",
          version: 1,
          title: "Which",
          description: "",
          category: "action",
          configSchema: z.object({ ms: z.number().default(0) }),
          inputs: [],
          outputs: [],
          execInput: true,
          execOutputs: [{ name: "next" }],
          idempotent: true,
          async run(_ctx, { config }) {
            await new Promise((r) => setTimeout(r, config.ms));
            return { exec: "next", outputs: { version: "${version}" } };
          },
        }),
      ],
      source: {
        async start(ctx) {
          ctx.setStatus("connected");
          return { async stop() {} };
        },
      },
    }),
  ],
});
`;

describe("process lifecycle", () => {
  let t: TestRuntime;
  let v1: FixtureExtension;
  let v2: FixtureExtension;

  beforeAll(async () => {
    t = testRuntime({ timings: { idleMs: 150 } });
    v1 = await fixtureExtension(t.runtime, { id: "swap", source: VERSIONED("1") });
    v2 = await fixtureExtension(t.runtime, {
      id: "swap",
      version: "2.0.0",
      source: VERSIONED("2"),
    });
  }, 30_000);

  afterAll(async () => {
    await t.runtime.stopAll();
  });

  it("starts nothing until the first call, and stops when idle", async () => {
    const connectors = t.runtime.activate(v1);
    expect(t.runtime.host("swap")?.process).toBeNull();
    const out = await run(connectors, "swap.which");
    expect(out.result).toMatchObject({ outputs: { version: "1" } });
    const pid = t.runtime.host("swap")?.process?.pid;
    expect(alive(pid)).toBe(true);
    expect(t.statuses.filter((s) => s.id === "swap").map((s) => s.status)).toEqual([
      "stopped",
      "starting",
      "running",
    ]);
    await waitFor(() => !alive(pid));
    expect(t.runtime.host("swap")?.process).toBeNull();
    expect(t.statuses.at(-1)).toMatchObject({ status: "stopped", detail: null });
    expect(t.crashes).toEqual([]);
  });

  it("keeps a loaded process running past its start timeout", async () => {
    const quick = testRuntime({ timings: { startTimeoutMs: 2000 } });
    try {
      const ext = await fixtureExtension(quick.runtime, { id: "swap", source: VERSIONED("1") });
      const connectors = quick.runtime.activate(ext);
      const fake = fakeSourceContext();
      const source = await connectors[0]?.source?.start(fake.ctx);
      const pid = quick.runtime.host("swap")?.process?.pid;
      await new Promise((r) => setTimeout(r, 2500));
      expect(alive(pid)).toBe(true);
      expect((await run(connectors, "swap.which")).result).toMatchObject({
        outputs: { version: "1" },
      });
      expect(quick.runtime.host("swap")?.process?.pid).toBe(pid);
      expect(quick.crashes).toEqual([]);
      await source?.stop();
    } finally {
      await quick.runtime.stopAll();
    }
  });

  it("stays up while an event source runs", async () => {
    const connectors = t.runtime.activate(v1);
    const fake = fakeSourceContext();
    const source = await connectors[0]?.source?.start(fake.ctx);
    const pid = t.runtime.host("swap")?.process?.pid;
    await new Promise((r) => setTimeout(r, 400));
    expect(alive(pid)).toBe(true);
    await source?.stop();
    await waitFor(() => !alive(pid));
  });

  it("moves new calls to a new version, and stops the old one when its calls finish", async () => {
    const old = t.runtime.activate(v1);
    // Long enough that the old process is still on this call after the swap.
    const slow = run(old, "swap.which", { ms: 2_000 });
    await waitFor(() => Boolean(t.runtime.host("swap")?.process));
    const oldPid = t.runtime.host("swap")?.process?.pid;

    const fresh = t.runtime.activate(v2);
    expect((await run(fresh, "swap.which")).result).toMatchObject({ outputs: { version: "2" } });
    const newPid = t.runtime.host("swap")?.process?.pid;
    expect(newPid).not.toBe(oldPid);
    // Calls through the old proxies go to the new version too.
    expect((await run(old, "swap.which")).result).toMatchObject({ outputs: { version: "2" } });

    // The old process keeps running its call, then stops.
    expect(alive(oldPid)).toBe(true);
    expect((await slow).result).toMatchObject({ outputs: { version: "1" } });
    await waitFor(() => !alive(oldPid));
  });

  it("fails calls in flight and later calls once deactivated", async () => {
    const connectors = t.runtime.activate(v2);
    const pending = run(connectors, "swap.which", { ms: 5_000 });
    await waitFor(() => Boolean(t.runtime.host("swap")?.process));
    const pid = t.runtime.host("swap")?.process?.pid;
    await t.runtime.deactivate("swap");
    expect(alive(pid)).toBe(false);
    const err = await failure(pending);
    expect(err).toBeInstanceOf(NodeError);
    expect(err).toMatchObject({ code: "extension_disabled", message: "The extension is disabled" });
    const later = await failure(run(connectors, "swap.which"));
    expect(later).toMatchObject({
      code: "extension_disabled",
      message: "The extension is disabled",
    });
    expect(t.statuses.at(-1)).toMatchObject({ status: "disabled" });

    // Turned on again: new proxies work, the old ones stay disabled.
    const again = t.runtime.activate(v2);
    expect((await run(again, "swap.which")).result).toMatchObject({ outputs: { version: "2" } });
    expect(await failure(run(connectors, "swap.which"))).toMatchObject({
      code: "extension_disabled",
    });
  });

  it("times out a call that runs past its deadline, and keeps the process", async () => {
    const quick = testRuntime({ deadlines: { run: 150 } });
    const connectors = quick.runtime.activate(v1);
    const err = await failure(run(connectors, "swap.which", { ms: 2_000 }));
    expect(err).toMatchObject({
      code: "extension_timeout",
      message: "The extension didn't finish the node within 150 ms",
    });
    expect((await run(connectors, "swap.which")).result).toMatchObject({
      outputs: { version: "1" },
    });
    await quick.runtime.stopAll();
  });
});

const CRASHY = `${SDK}
const node = (type, run) =>
  defineNode({
    type,
    version: 1,
    title: type,
    description: "",
    category: "action",
    configSchema: z.object({}),
    inputs: [],
    outputs: [],
    execInput: true,
    execOutputs: [{ name: "next" }],
    idempotent: false,
    run,
  });

export default defineExtension({
  connectors: [
    defineConnector({
      id: "crashy",
      name: "Crashy",
      description: "",
      credentialsSchema: z.object({}),
      secretFields: [],
      configSchema: z.object({}),
      async test() { return { ok: true }; },
      source: {
        async start(ctx) {
          ctx.setStatus("connected");
          return { async stop() {} };
        },
      },
      nodes: [
        node("crashy.ok", async () => ({ exec: "next", outputs: { pid: process.pid } })),
        node("crashy.exit", async () => process.exit(3)),
        node("crashy.throw", async () => {
          setTimeout(() => { throw new Error("boom from a timer"); }, 0);
          return new Promise(() => {});
        }),
        node("crashy.loop", async () => { for (;;) {} }),
        node("crashy.oom", async () => {
          const hoard = [];
          for (;;) hoard.push(new Array(100000).fill({ x: hoard.length }));
        }),
      ],
    }),
  ],
});
`;

describe("crashes and hangs", () => {
  let t: TestRuntime;
  let crashyExt: FixtureExtension;
  let crashy: AnyConnector[];
  let steady: AnyConnector[];

  beforeAll(async () => {
    t = testRuntime({
      timings: { heartbeatMs: 50, heartbeatTimeoutMs: 400 },
      network: { resolver },
    });
    crashyExt = await fixtureExtension(t.runtime, {
      id: "crashy",
      source: CRASHY,
      manifest: { memoryMb: 64 },
    });
    const s = await fixtureExtension(t.runtime, { id: "acme", source: ACME });
    crashy = t.runtime.activate(crashyExt);
    steady = t.runtime.activate(s);
  }, 30_000);

  afterAll(async () => {
    await t.runtime.stopAll();
  });

  async function okPid(): Promise<number> {
    const out = (await run(crashy, "crashy.ok")).result as unknown as { outputs: { pid: number } };
    return out.outputs.pid;
  }

  it("doesn't kill a healthy process when the server itself was busy", async () => {
    const pid = await okPid();
    // Block the server's event loop for longer than the heartbeat timeout.
    const until = Date.now() + 1_000;
    while (Date.now() < until) {}
    await new Promise((r) => setTimeout(r, 200));
    expect(await okPid()).toBe(pid);
    expect(t.crashes).toEqual([]);
  });

  it("fails the node when the process exits, and restarts on the next call", async () => {
    const before = await okPid();
    const fake = fakeSourceContext();
    const source = await crashy[0]?.source?.start(fake.ctx);
    const err = await failure(run(crashy, "crashy.exit"));
    expect(err).toBeInstanceOf(NodeError);
    expect(err).toMatchObject({
      code: "extension_crashed",
      message: "The extension stopped responding: it exited with code 3",
    });
    // Its event source reports the error, so the connector runtime restarts it with backoff.
    expect(fake.statuses).toContainEqual({
      status: "error",
      detail: "The extension stopped responding",
    });
    await source?.stop();
    const after = await okPid();
    expect(after).not.toBe(before);
    expect(alive(before)).toBe(false);
    expect(t.crashes.at(-1)).toEqual({ id: "crashy", reason: "it exited with code 3" });
  });

  it("fails the node on an uncaught exception", async () => {
    const err = await failure(run(crashy, "crashy.throw"));
    expect(err).toMatchObject({ code: "extension_crashed" });
    expect(err.message).toMatch(/^The extension stopped responding: it exited with code \d+$/);
    expect(
      t.runtime
        .log("crashy")
        .map((l) => l.message)
        .join("\n"),
    ).toMatch(/boom from a timer/);
    expect(await okPid()).toBeGreaterThan(0);
  });

  it("kills a process that loops forever, and other extensions carry on", async () => {
    const steadyBefore = (await run(steady, "acme.echo")).result;
    const looping = failure(run(crashy, "crashy.loop"));
    // While it spins, another extension still answers.
    await new Promise((r) => setTimeout(r, 100));
    expect((await run(steady, "acme.echo")).result).toEqual(steadyBefore);
    const err = await looping;
    expect(err).toBeInstanceOf(NodeError);
    expect(err).toMatchObject({
      code: "extension_unresponsive",
      message: "The extension stopped responding",
    });
    expect(await okPid()).toBeGreaterThan(0);
  });

  it("goes to error after five crashes, until turned off and on", async () => {
    expect(t.crashes.filter((c) => c.id === "crashy")).toHaveLength(3);
    await failure(run(crashy, "crashy.exit"));
    await failure(run(crashy, "crashy.exit"));
    expect(t.crashes.filter((c) => c.id === "crashy")).toHaveLength(5);
    expect(t.statuses.at(-1)).toMatchObject({ id: "crashy", status: "error" });
    expect(t.statuses.at(-1)?.detail).toBe(
      "The extension crashed 5 times in 10 minutes. Turn it off and on again to restart it.",
    );
    const err = await failure(run(crashy, "crashy.ok"));
    expect(err).toMatchObject({ code: "extension_error" });
    expect(t.runtime.host("crashy")?.process).toBeNull();
    // The other extension never noticed.
    expect((await run(steady, "acme.echo")).result).toMatchObject({ exec: "next" });
    expect(t.runtime.host("crashy")?.state).toBe("error");

    await t.runtime.deactivate("crashy");
    crashy = t.runtime.activate(crashyExt);
    expect(await okPid()).toBeGreaterThan(0);
    expect(t.runtime.host("crashy")?.state).toBe("active");
  });
});

// With the real heartbeat timeout. Near its heap limit V8 collects garbage in
// long pauses, longer than the short timeout above on a slow machine, and the
// process must be reported out of memory, not unresponsive.
describe("running out of memory", () => {
  let t: TestRuntime;
  let crashy: AnyConnector[];

  beforeAll(async () => {
    t = testRuntime({ network: { resolver } });
    const ext = await fixtureExtension(t.runtime, {
      id: "crashy",
      source: CRASHY,
      manifest: { memoryMb: 64 },
    });
    crashy = t.runtime.activate(ext);
  }, 30_000);

  afterAll(async () => {
    await t.runtime.stopAll();
  });

  it("fails the node when the process runs out of memory", async () => {
    const err = await failure(run(crashy, "crashy.oom"));
    expect(err).toMatchObject({
      code: "extension_crashed",
      message: "The extension stopped responding: it ran out of memory",
    });
    expect(t.crashes.at(-1)).toEqual({ id: "crashy", reason: "it ran out of memory" });
  }, 30_000);
});
