import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NodeContext } from "@sling/connector-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import extension, { connector, ntfySetup } from "./index.ts";
import { publish } from "./publish.ts";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let base: string;
let seen: Seen[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  seen = [];
  answer = { status: 200, body: { id: "msg1", time: 1_700_000_000, event: "message", topic: "t" } };
});

function ctx(
  config: Record<string, unknown> = {},
  credentials: Record<string, unknown> = {},
  connectorId = "ntfy",
): NodeContext {
  return {
    signal: AbortSignal.timeout(5000),
    idempotencyKey: "run:node:0",
    log: { info() {}, warn() {}, error() {} },
    installation: async (id: string) => ({
      id,
      connectorId,
      name: "Phone",
      credentials,
      config: { server: base, ...config },
    }),
  } as unknown as NodeContext;
}

async function run(config: Record<string, unknown>, c: NodeContext = ctx(), inputs = {}) {
  return publish.run?.(c, { inputs, config: { installationId: "ins_1", ...config } as never });
}

describe("ntfy.publish", () => {
  it("posts the message as JSON to the server's root", async () => {
    const result = await run({
      topic: "alerts",
      message: "Build done",
      title: "CI",
      priority: 4,
      tags: "white_check_mark, ci",
      click: "https://example.com/run/1",
      markdown: true,
    });
    expect(result).toEqual({ exec: "next", outputs: { id: "msg1", topic: "alerts" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("/");
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      topic: "alerts",
      message: "Build done",
      title: "CI",
      priority: 4,
      tags: ["white_check_mark", "ci"],
      click: "https://example.com/run/1",
      markdown: true,
    });
  });

  it("sends the access token, uses the default topic, and takes the message input", async () => {
    await run(
      { message: "from config" },
      ctx({ defaultTopic: "fallback", server: `${base}/` }, { accessToken: "tk_secret" }),
      { message: "from input" },
    );
    expect(seen[0]?.headers.authorization).toBe("Bearer tk_secret");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      topic: "fallback",
      message: "from input",
      priority: 3,
    });
  });

  it("explains a missing or invalid topic", async () => {
    await expect(run({ message: "x" })).rejects.toMatchObject({ code: "no_topic" });
    await expect(run({ topic: "has space" })).rejects.toMatchObject({ code: "invalid_topic" });
    expect(seen).toHaveLength(0);
  });

  it("refuses another connector's installation", async () => {
    await expect(run({ topic: "t" }, ctx({}, {}, "discord"))).rejects.toMatchObject({
      code: "wrong_installation",
    });
  });

  it("turns ntfy's errors into node errors", async () => {
    answer = { status: 403, body: { code: 40301, http: 403, error: "forbidden" } };
    await expect(run({ topic: "t" })).rejects.toMatchObject({
      code: "ntfy_forbidden",
      message: expect.stringContaining("(forbidden)"),
    });
    answer = { status: 429, body: { error: "limit reached" } };
    await expect(run({ topic: "t" })).rejects.toMatchObject({
      code: "ntfy_rate_limited",
      retryable: true,
    });
    answer = { status: 502, body: "bad gateway" };
    await expect(run({ topic: "t" })).rejects.toMatchObject({
      code: "ntfy_unavailable",
      retryable: true,
    });
  });

  it("reports an unreachable server", async () => {
    await expect(run({ topic: "t" }, ctx({ server: "http://127.0.0.1:1" }))).rejects.toMatchObject({
      code: "ntfy_unreachable",
    });
  });
});

describe("connection test", () => {
  const test = (config: Record<string, unknown> = {}, credentials = {}) =>
    connector.test({
      credentials,
      config: { server: base, topics: [], ...config },
      log: { info() {}, warn() {}, error() {} },
      signal: AbortSignal.timeout(5000),
    });

  it("checks /v1/health", async () => {
    answer = { status: 200, body: { healthy: true } };
    expect(await test({ topics: ["a", "b"] })).toEqual({
      ok: true,
      detail: `${new URL(base).host} is up. Watching a, b.`,
    });
    expect(seen.map((s) => s.url)).toEqual(["/v1/health"]);
  });

  it("checks the access token when there is one", async () => {
    answer = { status: 200, body: { healthy: true } };
    expect(await test({}, { accessToken: "tk_1" })).toMatchObject({
      ok: true,
      detail: expect.stringContaining("accepted the access token"),
    });
    expect(seen.map((s) => [s.url, s.headers.authorization])).toEqual([
      ["/v1/health", undefined],
      ["/v1/account", "Bearer tk_1"],
    ]);
  });

  it("explains a server that isn't ntfy, or isn't reachable", async () => {
    answer = { status: 404, body: {} };
    expect(await test()).toMatchObject({ ok: false, error: expect.stringContaining("404") });
    expect(await test({ server: "http://127.0.0.1:1" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Couldn't reach"),
    });
  });
});

describe("the extension", () => {
  it("describes one connector with its nodes, source, and config hosts", () => {
    const d = extension.describe();
    expect(d.connectors).toHaveLength(1);
    const c = d.connectors[0];
    expect(c?.id).toBe("ntfy");
    expect(c?.hasSource).toBe(true);
    expect(c?.secretFields).toEqual(["accessToken"]);
    expect(Object.keys(c?.configSchema.properties as object)).toEqual([
      "defaultTopic",
      "server",
      "topics",
    ]);
    expect(c?.nodes.map((n) => [n.type, n.idempotent, n.trigger])).toEqual([
      ["ntfy.publish", false, null],
      ["ntfy.message_received", true, { event: "ntfy.message" }],
    ]);
    expect(c?.hasSetup).toBe(true);
  });
});

describe("the setup lookup", () => {
  it("suggests a long random topic first", () => {
    const out = ntfySetup({});
    expect(out.config?.defaultTopic).toMatch(/^sling-[a-z0-9]{12}$/);
    expect(ntfySetup({}).config?.defaultTopic).not.toBe(out.config?.defaultTopic);
    expect(out.notes).toBeUndefined();
  });

  it("links to the topic, so the phone can subscribe", () => {
    expect(ntfySetup({ defaultTopic: "sling-abc" }).notes).toEqual([
      expect.objectContaining({
        field: "defaultTopic",
        link: { label: "Open it", url: "https://ntfy.sh/sling-abc" },
      }),
    ]);
    const own = ntfySetup({ defaultTopic: "alerts", server: "https://ntfy.example.com/" });
    expect(own.name).toBe("ntfy.example.com");
    expect(own.notes?.[0]?.link?.url).toBe("https://ntfy.example.com/alerts");
  });
});
