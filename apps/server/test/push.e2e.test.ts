/**
 * Web Push end to end: real Postgres, the control plane in-process, a fake
 * Runner, a scripted mock model, and a local HTTP server standing in for a
 * push service. Every push is decrypted with the subscription's own private
 * key and auth secret, as the browser would.
 *
 * Needs Docker.
 */
import { createECDH, createPublicKey, type ECDH, randomBytes, verify } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type {
  ConversationView,
  MessageView,
  NotificationSettings,
  PushPayload,
  PushSubscriptionView,
  RunDetailView,
  TaskView,
} from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { Config } from "../src/config.ts";
import { b64u, decryptPayload, encryptPayload, fromB64u } from "../src/push/crypto.ts";
import { topicFor } from "../src/push/payloads.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { withinBudget } from "./fixtures/budget.ts";
import { FakeRunner } from "./fixtures/fake-runner.ts";

vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "http://sling.test";
const SECRET = "push-e2e-secret-key-that-is-long-enough";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** The assistant always answers with the same short text. */
const model = new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: "text" as const, text: "Disk check" }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  }),
  doStream: async () => ({
    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      {
        type: "text-delta",
        id: "t",
        delta: "The disk is 91% full; the logs folder is the biggest.",
      },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
    ]),
  }),
});

// ---------------------------------------------------------------- the push service stand-in

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** performance.now() when the request arrived, in this process's clock. */
  at: number;
}

const received: Received[] = [];
/** Status codes by path. Anything not listed answers 201. */
const answers = new Map<string, number>();
let pushServer: Server;
let pushOrigin = "";

interface Device {
  name: string;
  path: string;
  endpoint: string;
  ecdh: ECDH;
  auth: Buffer;
  keys: { p256dh: string; auth: string };
}

/** A browser's subscription: a P-256 key pair and an auth secret made here. */
function device(name: string): Device {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const path = `/push/${name}`;
  return {
    name,
    path,
    endpoint: pushOrigin + path,
    ecdh,
    auth,
    keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) },
  };
}

function open(r: Received, d: Device): PushPayload {
  return JSON.parse(decryptPayload(r.body, d.ecdh.getPrivateKey(), d.auth).toString());
}

/** Pushes to one device after `mark`, decrypted. */
function pushesTo(d: Device, mark = 0): { r: Received; p: PushPayload }[] {
  return received
    .slice(mark)
    .filter((r) => r.path === d.path)
    .map((r) => ({ r, p: open(r, d) }));
}

async function pushTo(d: Device, mark: number, test: (p: PushPayload) => boolean) {
  try {
    return await until(`a push to ${d.name}`, async () => pushesTo(d, mark).find((x) => test(x.p)));
  } catch (err) {
    const got = pushesTo(d, mark).map((x) => x.p);
    throw new Error(`${(err as Error).message}; it got ${JSON.stringify(got)}`);
  }
}

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let machine: FakeRunner;
let cookie = "";
let workspaceId = "";
let userId = "";
let phone: Device;

async function raw(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(server.url + path, {
    method,
    headers: {
      origin: ORIGIN,
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie();
  if (set.length) cookie = set.map((s) => s.split(";")[0]).join("; ");
  return res;
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await raw(method, path, body);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 15_000,
) {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

const task = (id: string) => api<{ task: TaskView }>("GET", `/api/tasks/${id}`).then((d) => d.task);

async function setCategories(patch: Partial<NotificationSettings>) {
  return api<NotificationSettings>("PUT", "/api/settings/notifications", patch);
}

function jwtOf(headers: IncomingHttpHeaders) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(String(headers.authorization));
  if (!m?.[1] || !m[2]) throw new Error(`no VAPID header: ${headers.authorization}`);
  const [h, c, s] = m[1].split(".") as [string, string, string];
  return {
    header: h,
    claims: JSON.parse(fromB64u(c).toString()),
    signed: `${h}.${c}`,
    sig: fromB64u(s),
    k: m[2],
  };
}

beforeAll(async () => {
  pushServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const path = req.url ?? "/";
    received.push({
      path,
      headers: req.headers,
      body: Buffer.concat(chunks),
      at: performance.now(),
    });
    res.writeHead(answers.get(path) ?? 201).end();
  });
  await new Promise<void>((ok) => pushServer.listen(0, "127.0.0.1", ok));
  pushOrigin = `http://127.0.0.1:${(pushServer.address() as AddressInfo).port}`;

  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  const config: Config = {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL(ORIGIN),
    secretKey: SECRET,
    host: "127.0.0.1",
    port: 0,
    logLevel: "warn",
    webDist: undefined,
    testing: { pushOrigins: [pushOrigin] },
  };
  server = await startServer(config, { model, jobs: false });
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
  const [m] = await server.ctx.db.select().from(schema.workspaceMembers).limit(1);
  if (!m) throw new Error("no workspace");
  workspaceId = m.workspaceId;
  userId = m.userId;

  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  machine = new FakeRunner({
    url: server.url,
    name: "laptop",
    repos: [{ name: "site", remoteUrl: "https://github.com/acme/site.git", defaultBranch: "main" }],
    harnesses: ["codex"],
  });
  await machine.pair(code);
  await machine.connect();
  phone = device("phone");
}, 120_000);

afterAll(async () => {
  machine?.close();
  await server?.close();
  await pg?.stop();
  await new Promise((ok) => pushServer?.close(ok));
});

// ---------------------------------------------------------------- devices

describe("devices", () => {
  it("serves the VAPID public key", async () => {
    const { publicKey } = await api<{ publicKey: string }>("GET", "/api/push/key");
    const key = fromB64u(publicKey);
    expect(key.length).toBe(65);
    expect(key[0]).toBe(4);
    expect(publicKey).toBe(server.ctx.push.publicKey);
  });

  it("refuses endpoints outside the known push services, and keys no browser makes", async () => {
    const keys = device("x").keys;
    for (const endpoint of [
      "https://push.evil.example.com/abc",
      "http://fcm.googleapis.com/fcm/send/abc",
      "http://127.0.0.1:1/push/x",
    ]) {
      const res = await raw("POST", "/api/push/subscriptions", { endpoint, keys, label: "Nope" });
      expect(res.status, endpoint).toBe(400);
    }
    const bad = await raw("POST", "/api/push/subscriptions", {
      endpoint: `${pushOrigin}/push/bad`,
      keys: { p256dh: b64u(Buffer.alloc(65, 4)), auth: keys.auth },
      label: "Bad keys",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/keys/);
    expect(await api<PushSubscriptionView[]>("GET", "/api/push/subscriptions")).toEqual([]);
  });

  it("subscribes a device, and refreshes it when it subscribes again", async () => {
    const first = await api<PushSubscriptionView>("POST", "/api/push/subscriptions", {
      endpoint: phone.endpoint,
      keys: phone.keys,
      label: "Chrome on Android",
    });
    expect(first).toMatchObject({
      label: "Chrome on Android",
      service: "127.0.0.1",
      lastError: null,
    });
    const again = await api<PushSubscriptionView>("POST", "/api/push/subscriptions", {
      endpoint: phone.endpoint,
      keys: phone.keys,
      label: "Chrome on Pixel",
    });
    expect(again.id).toBe(first.id);
    const list = await api<PushSubscriptionView[]>("GET", "/api/push/subscriptions");
    expect(list.map((s) => s.label)).toEqual(["Chrome on Pixel"]);
    const audits = await server.ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.verb, "push.subscribed"));
    expect(audits.length).toBe(2);
  });

  it("sends a test push, encrypted for the device and signed with VAPID", async () => {
    const [sub] = await api<PushSubscriptionView[]>("GET", "/api/push/subscriptions");
    const mark = received.length;
    expect(await api("POST", "/api/push/test", { id: sub?.id })).toEqual({ ok: true, error: null });
    const [got] = pushesTo(phone, mark);
    expect(got?.p).toEqual({
      title: "Notifications work",
      body: "Sling can reach Chrome on Pixel.",
      url: "/settings#notifications",
      tag: `test:${sub?.id}`,
    });
    const h = got?.r.headers ?? {};
    expect(h["content-encoding"]).toBe("aes128gcm");
    expect(h["content-type"]).toBe("application/octet-stream");
    expect(h.ttl).toBe("60");
    expect(h.urgency).toBe("normal");
    expect(h.topic).toBe(topicFor(`test:${sub?.id}`));

    const jwt = jwtOf(h);
    expect(jwt.k).toBe(server.ctx.push.publicKey);
    expect(jwt.claims.aud).toBe(pushOrigin);
    expect(jwt.claims.sub).toBe("mailto:sling@sling.test");
    expect(jwt.claims.exp - Date.now() / 1000).toBeGreaterThan(11.9 * 3600);
    const key = fromB64u(jwt.k);
    const pub = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: b64u(key.subarray(1, 33)), y: b64u(key.subarray(33)) },
      format: "jwk",
    });
    expect(
      verify("sha256", Buffer.from(jwt.signed), { key: pub, dsaEncoding: "ieee-p1363" }, jwt.sig),
    ).toBe(true);

    const [after] = await api<PushSubscriptionView[]>("GET", "/api/push/subscriptions");
    expect(after?.lastDeliveredAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------- what notifies

describe("approvals and tasks", () => {
  it("pushes a task's approval once, then its delivery", async () => {
    const mark = received.length;
    const created = await api<{ id: string }>("POST", "/api/tasks", {
      repo: "site",
      title: "Fix the footer year",
      objective: "Make the footer year dynamic.",
      deliver: "pr",
      mode: "supervised",
    });
    await until("the task to succeed", async () => (await task(created.id)).state === "succeeded");
    const asked = await pushTo(phone, mark, (p) => p.tag === `task:${created.id}`);
    expect(asked.p).toEqual({
      title: "Approve pull request?",
      body: "Fix the footer year",
      url: "/approvals",
      tag: `task:${created.id}`,
      // Push and PR can be answered from the notification.
      answer: { approvalId: expect.stringMatching(/^apv_/), token: expect.any(String) },
    });
    expect(asked.r.headers.urgency).toBe("high");
    expect(asked.r.headers.ttl).toBe(String(24 * 3600));
    expect(asked.r.headers.topic).toBe(topicFor(`task:${created.id}`));
    // Push and PR wait on one answer, so they make one notification.
    await server.ctx.push.idle();
    expect(pushesTo(phone, mark).filter((x) => x.p.tag === `task:${created.id}`)).toHaveLength(1);

    // A machine answers a step after a network round trip. The stand-in Runner
    // answers in the same process, which can beat the server marking the step
    // as sent, so its step requests get the round trip here.
    const send = server.ctx.runners.send.bind(server.ctx.runners);
    server.ctx.runners.send = (runnerId, envelope) => {
      if (envelope.body.case !== "actionRequest") return send(runnerId, envelope);
      setTimeout(() => send(runnerId, envelope), 30);
      return true;
    };
    const next = received.length;
    await api("POST", `/api/tasks/${created.id}/approval`, { decision: "approve" });
    const done = await pushTo(phone, next, (p) => p.title.startsWith("Delivered"));
    expect(done.p).toEqual({
      title: "Delivered: Fix the footer year",
      body: "Opened the pull request.",
      url: `/tasks/${created.id}`,
      tag: `task:${created.id}`,
    });
    expect(done.r.headers.ttl).toBe("3600");
    expect(done.r.headers.urgency).toBe("normal");
    server.ctx.runners.send = send;
  });

  it("pushes a finished task, unless tasks are turned off", async () => {
    let mark = received.length;
    const a = await api<{ id: string }>("POST", "/api/tasks", {
      repo: "site",
      title: "Bump the copyright",
      objective: "Change the footer.",
      deliver: "local",
      mode: "auto",
    });
    const got = await pushTo(phone, mark, (p) => p.tag === `task:${a.id}`);
    expect(got.p).toMatchObject({ title: "Done: Bump the copyright", url: `/tasks/${a.id}` });
    // Neither the summary nor the objective leave Sling.
    expect(JSON.stringify(got.p)).not.toMatch(/footer/i);

    expect(await setCategories({ tasks: false })).toEqual({
      approvals: true,
      tasks: false,
      replies: true,
    });
    const settings = await api<{ notifications: NotificationSettings }>("GET", "/api/settings");
    expect(settings.notifications.tasks).toBe(false);
    mark = received.length;
    const b = await api<{ id: string }>("POST", "/api/tasks", {
      repo: "site",
      title: "Quiet task",
      objective: "Change the footer.",
      deliver: "local",
      mode: "auto",
    });
    await until("the quiet task to succeed", async () => (await task(b.id)).state === "succeeded");
    await server.ctx.push.idle();
    expect(pushesTo(phone, mark)).toEqual([]);
    await setCategories({ tasks: true });
  });

  it("pushes a command waiting in a chat, without the command", async () => {
    const conv = await api<ConversationView>("POST", "/api/conversations", {});
    const mark = received.length;
    let approvalId = "";
    const decision = server.ctx.commands.approval({
      workspaceId,
      conversationId: conv.id,
      machine: "laptop",
      // What the reply's trace does when a command waits on the user.
      onChange: (approval) => {
        approvalId = approval.id;
        server.ctx.hub.publish(workspaceId, {
          type: "agent.tool",
          conversationId: conv.id,
          step: {
            kind: "tool",
            id: "call_1",
            name: "run_command",
            input: { command: "rm -rf ./logs" },
            status: "running",
            output: null,
            approval,
          },
        });
      },
    });
    const got = await pushTo(phone, mark, (p) => p.tag === `conv:${conv.id}`);
    expect(got.p).toEqual({
      title: "Run a command on laptop?",
      body: conv.title,
      url: `/c/${conv.id}`,
      tag: `conv:${conv.id}`,
    });
    expect(JSON.stringify(got.p)).not.toContain("rm -rf");
    expect(got.r.headers.ttl).toBe("300");
    expect(got.r.headers.urgency).toBe("high");
    // Its answer pushes nothing more.
    await api("POST", `/api/conversations/${conv.id}/commands/${approvalId}`, { decision: "deny" });
    expect(await decision).toBe("denied");
    await server.ctx.push.idle();
    expect(pushesTo(phone, mark)).toHaveLength(1);
  });
});

describe("replies", () => {
  let conv: ConversationView;

  async function say(text: string) {
    const before = await api<{ messages: MessageView[] }>("GET", `/api/conversations/${conv.id}`);
    const count = before.messages.filter((m) => m.role === "assistant").length;
    await api("POST", `/api/conversations/${conv.id}/messages`, { text });
    await until("the reply", async () => {
      const d = await api<{ messages: MessageView[] }>("GET", `/api/conversations/${conv.id}`);
      return d.messages.filter((m) => m.role === "assistant").length > count;
    });
    await server.ctx.push.idle();
  }

  it("pushes a reply only when no visible window shows the chat", async () => {
    conv = await api<ConversationView>("POST", "/api/conversations", {});
    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/ws`, {
      headers: { origin: ORIGIN, cookie },
    });
    await new Promise((ok, fail) => {
      ws.once("open", ok);
      ws.once("error", fail);
    });
    ws.send(JSON.stringify({ type: "presence", conversationId: conv.id, visible: true }));
    await until("presence", async () => server.ctx.push.showing(userId, conv.id));

    let mark = received.length;
    await say("How full is the disk?");
    expect(pushesTo(phone, mark).filter((x) => x.p.tag === `conv:${conv.id}`)).toEqual([]);

    // The window goes to the background: the next reply is pushed.
    ws.send(JSON.stringify({ type: "presence", conversationId: conv.id, visible: false }));
    await until("presence", async () => !server.ctx.push.showing(userId, conv.id));
    mark = received.length;
    await say("And now?");
    const [got] = pushesTo(phone, mark).filter((x) => x.p.tag === `conv:${conv.id}`);
    const title = (
      await api<{ conversation: ConversationView }>("GET", `/api/conversations/${conv.id}`)
    ).conversation.title;
    expect(got?.p).toEqual({
      title,
      body: "Sling replied.",
      url: `/c/${conv.id}`,
      tag: `conv:${conv.id}`,
    });
    // The reply's text never leaves Sling.
    expect(JSON.stringify(got?.p)).not.toMatch(/91%|logs/);
    expect(got?.r.headers.ttl).toBe("600");

    // A closed window shows nothing either.
    ws.send(JSON.stringify({ type: "presence", conversationId: conv.id, visible: true }));
    await until("presence", async () => server.ctx.push.showing(userId, conv.id));
    ws.close();
    await until(
      "the socket to be forgotten",
      async () => !server.ctx.push.showing(userId, conv.id),
    );
  });

  it("follows the replies setting", async () => {
    await setCategories({ replies: false });
    const mark = received.length;
    await say("Anything else?");
    expect(pushesTo(phone, mark)).toEqual([]);
    await setCategories({ replies: true });
  });
});

describe("app.notify", () => {
  it("always sends, whatever the categories say", async () => {
    await setCategories({ approvals: false, tasks: false, replies: false });
    const definition = {
      schema: "sling.workflow/v1",
      name: "Site down alert",
      description: "",
      nodes: [
        { id: "t", type: "core.manual", version: 1, position: { x: 0, y: 0 }, config: {} },
        {
          id: "n",
          type: "app.notify",
          version: 1,
          position: { x: 0, y: 0 },
          config: {
            title: "Website is down: 502",
            body: "Since 14:02.",
            open: "/?draft=Website%20is%20down&personality=incident",
            urgency: "high",
            ttlMinutes: 5,
          },
        },
      ],
      edges: [
        {
          id: "e1",
          kind: "exec",
          from: { node: "t", port: "next" },
          to: { node: "n", port: "in" },
        },
      ],
    };
    const wf = await api<{ id: string }>("POST", "/api/workflows", { definition });
    await api("POST", `/api/workflows/${wf.id}/publish`, { note: "test" });
    const mark = received.length;
    const run = await api<{ id: string }>("POST", `/api/workflows/${wf.id}/run`, { input: null });
    const detail = await until("the run", async () => {
      const r = await api<RunDetailView>("GET", `/api/runs/${run.id}`);
      return ["succeeded", "failed"].includes(r.run.status) ? r : null;
    });
    expect(detail.run.status).toBe("succeeded");
    expect(detail.nodeRuns.find((n) => n.nodeId === "n")?.outputs).toEqual({ delivered: 1 });
    const [got] = pushesTo(phone, mark);
    expect(got?.p).toEqual({
      title: "Website is down: 502",
      body: "Since 14:02.",
      url: "/?draft=Website%20is%20down&personality=incident",
      tag: `run:${run.id}:n`,
    });
    expect(got?.r.headers.urgency).toBe("high");
    expect(got?.r.headers.ttl).toBe("300");
    await setCategories({ approvals: true, tasks: true, replies: true });
  });
});

// ---------------------------------------------------------------- dropping devices

describe("dropping devices", () => {
  async function subscribe(d: Device) {
    return api<PushSubscriptionView>("POST", "/api/push/subscriptions", {
      endpoint: d.endpoint,
      keys: d.keys,
      label: d.name,
    });
  }

  it("removes a device the push service reports gone", async () => {
    const tablet = device("tablet");
    const sub = await subscribe(tablet);
    answers.set(tablet.path, 410);
    const res = await api<{ ok: boolean; error: string }>("POST", "/api/push/test", { id: sub.id });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/410/);
    const list = await api<PushSubscriptionView[]>("GET", "/api/push/subscriptions");
    expect(list.map((s) => s.id)).not.toContain(sub.id);
    const [gone] = await server.ctx.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.verb, "push.removed"), eq(schema.auditEvents.subjectId, sub.id)),
      );
    expect(gone?.details).toMatchObject({ reason: "gone", status: 410 });
  });

  it("counts other failures, and removes a device after ten in a row", async () => {
    const laptop = device("laptop");
    const sub = await subscribe(laptop);
    answers.set(laptop.path, 503);
    await api("POST", "/api/push/test", { id: sub.id });
    let [row] = await server.ctx.db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.id, sub.id));
    expect(row?.failures).toBe(1);
    expect(row?.lastError).toMatch(/503/);
    await server.ctx.db
      .update(schema.pushSubscriptions)
      .set({ failures: 9 })
      .where(eq(schema.pushSubscriptions.id, sub.id));
    await api("POST", "/api/push/test", { id: sub.id });
    [row] = await server.ctx.db
      .select()
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.id, sub.id));
    expect(row).toBeUndefined();
  });

  it("stops pushing to a device once it's removed", async () => {
    const watch = device("watch");
    const sub = await subscribe(watch);
    await api("DELETE", `/api/push/subscriptions/${sub.id}`);
    expect((await raw("DELETE", `/api/push/subscriptions/${sub.id}`)).status).toBe(404);
    const mark = received.length;
    const n = await server.ctx.push.notify(workspaceId, userId, {
      title: "Hello",
      body: "",
      url: "/",
      tag: "hello",
    });
    expect(n).toBe(1);
    expect(pushesTo(watch, mark)).toEqual([]);
    expect(pushesTo(phone, mark)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- budgets

describe("budgets", () => {
  it("measures event to request at the push service, and encryption", async () => {
    const conv = await api<ConversationView>("POST", "/api/conversations", {});
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      const mark = received.length;
      const t0 = performance.now();
      server.ctx.hub.publish(workspaceId, {
        type: "message.created",
        message: {
          id: `msg_bench_${i}`,
          conversationId: conv.id,
          role: "assistant",
          text: "ok",
          taskIds: [],
          attachments: [],
          personalityId: null,
          research: false,
          feedback: null,
          replaceable: false,
          createdAt: new Date().toISOString(),
          trace: null,
        },
      });
      const got = await until("the bench push", async () => pushesTo(phone, mark)[0]);
      times.push(got.r.at - t0);
    }
    const sorted = times.slice(5).sort((a, b) => a - b);
    const p = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    console.log(`push event to request: p50 ${p(0.5).toFixed(2)} ms, p95 ${p(0.95).toFixed(2)} ms`);
    withinBudget(p(0.95), 30);

    const payload = Buffer.from(
      JSON.stringify({
        title: "Approve deployment of Website?",
        body: "Fix the 500",
        url: "/approvals",
        tag: "task:tsk_1",
      }),
    );
    const ua = fromB64u(phone.keys.p256dh);
    for (let i = 0; i < 200; i++) encryptPayload(payload, ua, phone.auth);
    const n = 2000;
    const start = performance.now();
    for (let i = 0; i < n; i++) encryptPayload(payload, ua, phone.auth);
    const each = (performance.now() - start) / n;
    console.log(`push encryption: ${(each * 1000).toFixed(1)} µs per message`);
    withinBudget(each, 1);
  });
});
