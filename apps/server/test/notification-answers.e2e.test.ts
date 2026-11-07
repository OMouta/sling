/**
 * Allow and Deny from a notification, end to end: real Postgres, the control
 * plane in-process, a fake Runner, a scripted mock model, and a local HTTP
 * server standing in for a push service. Each push is decrypted with the
 * device's own keys, and every answer is posted with no session, as the
 * service worker posts it.
 *
 * Needs Docker.
 */
import { createECDH, type ECDH, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { defineConnector, type NodeSpec } from "@sling/connector-sdk";
import type {
  ApprovalView,
  CommandApprovalView,
  ConversationView,
  MessageView,
  NotificationAnswerResult,
  PermissionMode,
  PushPayload,
  TaskView,
  ToolStep,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Config } from "../src/config.ts";
import { answerKey, answerToken } from "../src/push/answers.ts";
import { b64u, decryptPayload } from "../src/push/crypto.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { FakeRunner } from "./fixtures/fake-runner.ts";

vi.setConfig({ testTimeout: 30_000 });

const ORIGIN = "http://sling.test";
const SECRET = "answers-e2e-secret-key-that-is-long-enough";
const KEY = answerKey(SECRET);

// ---------------------------------------------------------------- a node that sends

/** What the sending node was asked to post. */
const posted: string[] = [];

const post: NodeSpec<{ installationId: string; text: string }> = {
  type: "bench.post",
  version: 1,
  title: "Bench post",
  description: "Posts its text.",
  category: "action",
  connector: "bench",
  configSchema: z.object({ installationId: z.string().min(1), text: z.string().default("") }),
  installationFields: ["installationId"],
  inputs: [],
  outputs: [{ name: "echo", type: "string" }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: false,
  assistant: { sends: true, summary: "Post {text}" },
  async run(_ctx, { config }) {
    posted.push(config.text);
    return { exec: "next", outputs: { echo: config.text } };
  },
};

const bench = defineConnector({
  id: "bench",
  name: "Bench",
  description: "A connector that posts.",
  credentialsSchema: z.object({}),
  secretFields: [],
  configSchema: z.object({}),
  test: async () => ({ ok: true }),
  nodes: [post],
});

// ---------------------------------------------------------------- mock model

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function respond(parts: LanguageModelV4StreamPart[], reason: "stop" | "tool-calls") {
  return {
    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
      { type: "stream-start", warnings: [] },
      ...parts,
      { type: "finish", finishReason: { unified: reason, raw: undefined }, usage },
    ]),
  };
}

const say = (t: string) =>
  respond(
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: t },
      { type: "text-end", id: "t" },
    ],
    "stop",
  );

/** The tool call the assistant makes for the next user message. */
const plan: { tool: string; input: Record<string, unknown> }[] = [];

const model = new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: "text" as const, text: "Post" }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  }),
  doStream: async (options: LanguageModelV4CallOptions) => {
    if (options.prompt.at(-1)?.role === "tool") return say("Done.");
    const next = plan.shift();
    if (!next) return say("Nothing to do.");
    return respond(
      [
        {
          type: "tool-call",
          toolCallId: `call_${newId("c")}`,
          toolName: next.tool,
          input: JSON.stringify(next.input),
        },
      ],
      "tool-calls",
    );
  },
});

// ---------------------------------------------------------------- the push service stand-in

const received: { path: string; body: Buffer }[] = [];
let pushServer: Server;
let pushOrigin = "";

interface Device {
  path: string;
  endpoint: string;
  ecdh: ECDH;
  auth: Buffer;
}

function device(name: string): Device {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const path = `/push/${name}`;
  return { path, endpoint: pushOrigin + path, ecdh, auth: randomBytes(16) };
}

function pushesTo(d: Device, mark = 0): PushPayload[] {
  return received
    .slice(mark)
    .filter((r) => r.path === d.path)
    .map((r) => JSON.parse(decryptPayload(r.body, d.ecdh.getPrivateKey(), d.auth).toString()));
}

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let machine: FakeRunner;
let cookie = "";
let workspaceId = "";
let userId = "";
let phone: Device;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
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
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** What the service worker sends: no cookie, no session. */
async function answerFrom(
  answer: { approvalId: string; token: string },
  decision: "allow" | "deny",
): Promise<{ status: number; body: NotificationAnswerResult & { error?: string } }> {
  const res = await fetch(
    `${server.url}/api/approvals/${encodeURIComponent(answer.approvalId)}/notification-answer`,
    {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ token: answer.token, answer: decision }),
    },
  );
  return { status: res.status, body: (await res.json()) as NotificationAnswerResult };
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

async function pushTo(d: Device, mark: number, test: (p: PushPayload) => boolean) {
  return until("a push", async () => pushesTo(d, mark).find(test));
}

const task = (id: string) => api<{ task: TaskView }>("GET", `/api/tasks/${id}`).then((d) => d.task);

const detail = (id: string) =>
  api<{ messages: MessageView[]; live: { steps: ToolStep[] } | null }>(
    "GET",
    `/api/conversations/${id}`,
  );

async function conversation(mode: PermissionMode) {
  const conv = await api<ConversationView>("POST", "/api/conversations", {});
  await api("PATCH", `/api/conversations/${conv.id}`, { mode });
  return conv;
}

/** Asks the assistant to post `text`, and resolves once it waits for an answer. */
async function askToPost(convId: string, text: string) {
  plan.push({ tool: "bench_post", input: { text } });
  await api("POST", `/api/conversations/${convId}/messages`, { text: `Post ${text}` });
}

/** The assistant's reply once it's saved, and its tool step. */
async function replyStep(convId: string, count: number): Promise<ToolStep> {
  const reply = await until("the reply", async () => {
    const d = await detail(convId);
    const replies = d.messages.filter((m) => m.role === "assistant");
    return replies.length > count ? replies.at(-1) : null;
  });
  const step = reply.trace?.steps.find((s): s is ToolStep => s.kind === "tool");
  if (!step) throw new Error(`no tool step in: ${reply.text}`);
  return step;
}

async function audits(verb: string) {
  return server.ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.verb, verb));
}

/** A command waiting in a chat, published as the reply's trace publishes it. */
function waitForCommand(conversationId: string, onPending: (a: CommandApprovalView) => void) {
  return server.ctx.commands.approval({
    workspaceId,
    conversationId,
    machine: "laptop",
    onChange: (approval) => {
      if (approval.state === "pending") onPending(approval);
      server.ctx.hub.publish(workspaceId, {
        type: "agent.tool",
        conversationId,
        step: {
          kind: "tool",
          id: "call_1",
          name: "run_command",
          input: {},
          status: "running",
          output: null,
          approval,
        },
      });
    },
  });
}

beforeAll(async () => {
  pushServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    received.push({ path: req.url ?? "/", body: Buffer.concat(chunks) });
    res.writeHead(201).end();
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
  server = await startServer(config, { model, jobs: false, connectors: [bench] });
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
  const [m] = await server.ctx.db.select().from(schema.workspaceMembers).limit(1);
  if (!m) throw new Error("no workspace");
  workspaceId = m.workspaceId;
  userId = m.userId;

  await api("POST", "/api/installations", {
    connectorId: "bench",
    name: "Bench",
    credentials: {},
    config: {},
  });

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
  await api("POST", "/api/push/subscriptions", {
    endpoint: phone.endpoint,
    keys: { p256dh: b64u(phone.ecdh.getPublicKey()), auth: b64u(phone.auth) },
    label: "Chrome on Android",
  });

  // A machine answers a step after a network round trip. The stand-in Runner
  // answers in the same process, which can beat the server marking the step
  // as sent, so its step requests get the round trip here.
  const send = server.ctx.runners.send.bind(server.ctx.runners);
  server.ctx.runners.send = (runnerId, envelope) => {
    if (envelope.body.case !== "actionRequest") return send(runnerId, envelope);
    setTimeout(() => send(runnerId, envelope), 30);
    return true;
  };
}, 120_000);

afterAll(async () => {
  machine?.close();
  await server?.close();
  await pg?.stop();
  await new Promise((ok) => pushServer?.close(ok));
});

// ---------------------------------------------------------------- chat sends

describe("a send in a chat", () => {
  it("gets Allow and Deny, and Allow sends it without a session, once", async () => {
    const conv = await conversation("supervised");
    const mark = received.length;
    await askToPost(conv.id, "standup moved to 10:00");
    const push = await pushTo(phone, mark, (p) => p.tag === `conv:${conv.id}`);
    expect(push).toMatchObject({
      title: "Approve: Post standup moved to 10:00?",
      url: `/c/${conv.id}`,
      answer: { approvalId: expect.stringMatching(/^cap_/), token: expect.any(String) },
    });
    const answer = push.answer as NonNullable<PushPayload["answer"]>;
    // The token is bound to the approval, so it answers no other one.
    expect(
      (
        await answerFrom(
          { approvalId: "cap_000000000000000000000000", token: answer.token },
          "allow",
        )
      ).status,
    ).toBe(403);

    const t0 = performance.now();
    expect(await answerFrom(answer, "allow")).toEqual({
      status: 200,
      body: { outcome: "allowed" },
    });
    const ms = performance.now() - t0;
    const step = await replyStep(conv.id, 0);
    expect(step.approval).toMatchObject({ kind: "send", state: "approved" });
    expect(posted).toContain("standup moved to 10:00");
    expect(JSON.parse(step.output ?? "{}")).toMatchObject({
      output: { echo: "standup moved to 10:00" },
    });

    // The second device's copy of the same push answers nothing.
    expect(await answerFrom(answer, "deny")).toEqual({
      status: 200,
      body: { outcome: "already_answered" },
    });
    expect(posted.filter((p) => p === "standup moved to 10:00")).toHaveLength(1);

    // The audit says the user answered, and where; the send is audited as from the app.
    const [said] = (await audits("approval.approved")).filter(
      (a) => (a.details as { approvalId?: string }).approvalId === answer.approvalId,
    );
    expect(said).toMatchObject({
      actorType: "user",
      actorId: userId,
      subjectType: "conversation",
      subjectId: conv.id,
      details: { kind: "send", via: "notification" },
    });
    const action = (await audits("assistant.action")).find(
      (a) => (a.details as { conversationId?: string }).conversationId === conv.id,
    );
    expect(action?.details).toMatchObject({ decision: "approved", ok: true });
    console.log(`chat send answered from a notification in ${ms.toFixed(1)} ms`);
  });

  it("sends nothing on Deny", async () => {
    const conv = await conversation("auto");
    const mark = received.length;
    await askToPost(conv.id, "the deny one");
    const push = await pushTo(phone, mark, (p) => p.tag === `conv:${conv.id}`);
    const answer = push.answer as NonNullable<PushPayload["answer"]>;
    expect(await answerFrom(answer, "deny")).toEqual({ status: 200, body: { outcome: "denied" } });
    const step = await replyStep(conv.id, 0);
    expect(step.approval?.state).toBe("denied");
    expect(posted).not.toContain("the deny one");
    expect(JSON.parse(step.output ?? "{}").error).toMatch(/declined/);
  });

  it("says already answered after the chat's card answered it", async () => {
    const conv = await conversation("supervised");
    const mark = received.length;
    await askToPost(conv.id, "answered in the app");
    const push = await pushTo(phone, mark, (p) => p.tag === `conv:${conv.id}`);
    const answer = push.answer as NonNullable<PushPayload["answer"]>;
    await api("POST", `/api/conversations/${conv.id}/commands/${answer.approvalId}`, {
      decision: "approve",
    });
    await replyStep(conv.id, 0);
    expect(await answerFrom(answer, "deny")).toEqual({
      status: 200,
      body: { outcome: "already_answered" },
    });
  });

  it("says expired once the approval ran out", async () => {
    const conv = await conversation("supervised");
    server.ctx.commands.approvalWaitMs = 400;
    try {
      const mark = received.length;
      await askToPost(conv.id, "too late");
      const push = await pushTo(phone, mark, (p) => p.tag === `conv:${conv.id}`);
      const step = await replyStep(conv.id, 0);
      expect(step.approval?.state).toBe("expired");
      const answer = push.answer as NonNullable<PushPayload["answer"]>;
      expect(await answerFrom(answer, "allow")).toEqual({
        status: 200,
        body: { outcome: "expired" },
      });
      expect(posted).not.toContain("too late");
    } finally {
      server.ctx.commands.approvalWaitMs = 5 * 60_000;
    }
  });

  it("says expired when its turn ended before its time ran out", async () => {
    const conv = await conversation("supervised");
    const mark = received.length;
    const stop = new AbortController();
    const decision = server.ctx.commands.approval({
      workspaceId,
      conversationId: conv.id,
      kind: "send",
      summary: "Post the stopped one",
      signal: stop.signal,
      // What the reply's trace does with each state.
      onChange: (approval) =>
        server.ctx.hub.publish(workspaceId, {
          type: "agent.tool",
          conversationId: conv.id,
          step: {
            kind: "tool",
            id: "call_stop",
            name: "bench_post",
            input: {},
            status: "running",
            output: null,
            approval,
          },
        }),
    });
    const push = await pushTo(phone, mark, (p) => p.tag === `conv:${conv.id}`);
    stop.abort();
    expect(await decision).toBe("expired");
    expect(await answerFrom(push.answer as NonNullable<PushPayload["answer"]>, "allow")).toEqual({
      status: 200,
      body: { outcome: "expired" },
    });
  });

  it("isn't asked in Read-only or Full access, so there's nothing to answer", async () => {
    for (const mode of ["read-only", "full-access"] as const) {
      const conv = await conversation(mode);
      const mark = received.length;
      await askToPost(conv.id, `in ${mode}`);
      const step = await replyStep(conv.id, 0);
      expect(step.approval).toBeUndefined();
      await server.ctx.push.idle();
      expect(pushesTo(phone, mark).filter((p) => p.tag === `conv:${conv.id}` && p.answer)).toEqual(
        [],
      );
    }
    expect(posted).not.toContain("in read-only");
    expect(posted).toContain("in full-access");
  });

  it("puts no buttons on a command, and refuses an answer to one", async () => {
    const conv = await conversation("supervised");
    const mark = received.length;
    let approval: CommandApprovalView | null = null;
    const decision = waitForCommand(conv.id, (a) => {
      approval = a;
    });
    const push = await pushTo(phone, mark, (p) => p.tag === `conv:${conv.id}`);
    expect(push.title).toBe("Run a command on laptop?");
    expect(push).not.toHaveProperty("answer");
    const id = (approval as CommandApprovalView | null)?.id ?? "";
    // Even with a token Sling signed, a command opens Sling.
    const forged = answerToken(KEY, id, {
      workspaceId,
      userId,
      expiresAt: Date.now() + 60_000,
      conversationId: conv.id,
    });
    const res = await answerFrom({ approvalId: id, token: forged }, "allow");
    expect(res.status).toBe(409);
    expect(server.ctx.commands.waiting(id)?.kind).toBe("command");
    await api("POST", `/api/conversations/${conv.id}/commands/${id}`, { decision: "deny" });
    expect(await decision).toBe("denied");
  });
});

// ---------------------------------------------------------------- task steps

/** A task delivered as a PR in Supervised, once its push and PR wait on the user. */
async function prTask(title: string) {
  const mark = received.length;
  const created = await api<{ id: string }>("POST", "/api/tasks", {
    repo: "site",
    title,
    objective: "Change the footer.",
    deliver: "pr",
    mode: "supervised",
  });
  await until("the task to succeed", async () => (await task(created.id)).state === "succeeded");
  const push = await pushTo(phone, mark, (p) => p.tag === `task:${created.id}`);
  return { id: created.id, push };
}

async function approvalsOf(taskId: string) {
  return server.ctx.db
    .select({
      id: schema.approvals.id,
      state: schema.approvals.state,
      via: schema.approvals.decidedVia,
      by: schema.approvals.decidedBy,
      kind: schema.actions.kind,
    })
    .from(schema.approvals)
    .innerJoin(schema.actions, eq(schema.actions.id, schema.approvals.actionId))
    .where(eq(schema.approvals.taskId, taskId))
    .orderBy(schema.actions.position);
}

describe("a task's push and PR", () => {
  it("get Allow and Deny, and Allow approves both and delivers", async () => {
    const t = await prTask("Fix the footer year");
    expect(t.push).toMatchObject({ title: "Approve pull request?", body: "Fix the footer year" });
    const answer = t.push.answer as NonNullable<PushPayload["answer"]>;
    const before = await approvalsOf(t.id);
    expect(before.map((a) => a.kind)).toEqual(["push", "open_pr"]);
    expect(answer.approvalId).toBe(before[0]?.id);

    const mark = received.length;
    const t0 = performance.now();
    expect(await answerFrom(answer, "allow")).toEqual({
      status: 200,
      body: { outcome: "allowed" },
    });
    const ms = performance.now() - t0;
    const after = await approvalsOf(t.id);
    expect(after.map((a) => [a.kind, a.state, a.via, a.by])).toEqual([
      ["push", "approved", "notification", userId],
      ["open_pr", "approved", "notification", userId],
    ]);
    const done = await pushTo(phone, mark, (p) => p.title.startsWith("Delivered"));
    expect(done.tag).toBe(`task:${t.id}`);
    const audited = (await audits("approval.approved")).filter(
      (a) => (a.details as { taskId?: string }).taskId === t.id,
    );
    expect(audited.map((a) => a.details)).toEqual([
      expect.objectContaining({ via: "notification" }),
      expect.objectContaining({ via: "notification" }),
    ]);
    expect(audited[0]?.details).not.toHaveProperty("externalUserId");

    expect(await answerFrom(answer, "allow")).toEqual({
      status: 200,
      body: { outcome: "already_answered" },
    });
    console.log(`push and PR answered from a notification in ${ms.toFixed(1)} ms`);
  });

  it("Deny rejects the push, and the PR with it", async () => {
    const t = await prTask("Rename the header");
    const answer = t.push.answer as NonNullable<PushPayload["answer"]>;
    expect(await answerFrom(answer, "deny")).toEqual({ status: 200, body: { outcome: "denied" } });
    await until("the steps to settle", async () =>
      (await task(t.id)).actions.every((a) => a.state !== "awaiting_approval"),
    );
    const after = await approvalsOf(t.id);
    expect(after[0]).toMatchObject({ kind: "push", state: "rejected", via: "notification" });
    expect((await task(t.id)).actions.map((a) => a.state)).not.toContain("succeeded");
  });

  it("says already answered after the app answered", async () => {
    const t = await prTask("Answered in the app");
    await api("POST", `/api/tasks/${t.id}/approval`, { decision: "approve" });
    expect(await answerFrom(t.push.answer as NonNullable<PushPayload["answer"]>, "deny")).toEqual({
      status: 200,
      body: { outcome: "already_answered" },
    });
  });

  it("says expired once the approval has, and changes nothing", async () => {
    const t = await prTask("Left too long");
    const answer = t.push.answer as NonNullable<PushPayload["answer"]>;
    // Past its expiry, before the sweep has marked it.
    await server.ctx.db
      .update(schema.approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.approvals.taskId, t.id));
    expect(await answerFrom(answer, "allow")).toEqual({
      status: 200,
      body: { outcome: "expired" },
    });
    // And a token past its own expiry, whatever the approval says.
    const old = answerToken(KEY, answer.approvalId, {
      workspaceId,
      userId,
      expiresAt: Date.now() - 1000,
    });
    expect(await answerFrom({ approvalId: answer.approvalId, token: old }, "allow")).toEqual({
      status: 200,
      body: { outcome: "expired" },
    });
    expect((await approvalsOf(t.id)).map((a) => a.state)).toEqual(["pending", "pending"]);
    const used = await server.ctx.db
      .select()
      .from(schema.notificationAnswers)
      .where(eq(schema.notificationAnswers.approvalId, answer.approvalId));
    expect(used).toEqual([]);
  });

  it("refuses a token that was changed, or made with another key", async () => {
    const t = await prTask("Tampered with");
    const answer = t.push.answer as NonNullable<PushPayload["answer"]>;
    const [body = "", sig = ""] = answer.token.split(".");
    const later = answerToken(KEY, answer.approvalId, {
      workspaceId,
      userId,
      expiresAt: Date.now() + 365 * 86_400_000,
    }).split(".")[0];
    const other = answerToken(
      answerKey("someone-elses-secret-key-long-enough"),
      answer.approvalId,
      {
        workspaceId,
        userId,
        expiresAt: Date.now() + 60_000,
      },
    );
    for (const token of [`${later}.${sig}`, `${body}.${sig.slice(1)}`, other, "nope"]) {
      const res = await answerFrom({ approvalId: answer.approvalId, token }, "allow");
      expect(res.status, token).toBe(403);
    }
    expect((await approvalsOf(t.id)).map((a) => a.state)).toEqual(["pending", "pending"]);
    // The real one still works.
    expect(await answerFrom(answer, "deny")).toEqual({ status: 200, body: { outcome: "denied" } });
  });
});

// ---------------------------------------------------------------- what opens Sling

describe("approvals that open Sling", () => {
  it("put no buttons on a deployment, and refuse an answer to a merge, a deploy, a workflow step, or a sandbox run", async () => {
    const [someTask] = await server.ctx.db.select().from(schema.tasks).limit(1);
    if (!someTask) throw new Error("no task");
    // A task with no steps, for the sandbox run, so no other approval rides along.
    const plain = await api<{ id: string }>("POST", "/api/tasks", {
      repo: "site",
      title: "Nothing to deliver",
      objective: "Look around.",
      deliver: "local",
      mode: "auto",
    });
    await until("the plain task", async () => (await task(plain.id)).state === "succeeded");
    await server.ctx.push.idle();
    const mark = received.length;
    const ids: Record<string, string> = {};
    for (const kind of ["merge", "deploy"] as const) {
      const actionId = newId("act");
      await server.ctx.db.insert(schema.actions).values({
        id: actionId,
        workspaceId,
        ownerId: userId,
        taskId: someTask.id,
        kind,
        position: kind === "merge" ? 10 : 11,
        state: "awaiting_approval",
        requiresApproval: true,
      });
      ids[kind] = newId("apv");
      await server.ctx.db.insert(schema.approvals).values({
        id: ids[kind],
        workspaceId,
        ownerId: userId,
        actionId,
        taskId: someTask.id,
        title: `${kind}: ${someTask.title}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    }
    ids.workflow = newId("apv");
    ids.sandbox = newId("apv");
    await server.ctx.db.insert(schema.approvals).values([
      {
        id: ids.workflow,
        workspaceId,
        ownerId: userId,
        kind: "workflow",
        title: "Send the invoice?",
        payload: {},
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        id: ids.sandbox,
        workspaceId,
        ownerId: userId,
        kind: "sandbox_fallback",
        taskId: plain.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ]);
    // As the task service announces a new approval.
    for (const id of Object.values(ids)) {
      server.ctx.hub.publish(workspaceId, {
        type: "approval.updated",
        approval: { id, state: "pending" } as ApprovalView,
      });
      await server.ctx.push.idle();
    }
    const pushes = pushesTo(phone, mark);
    expect(pushes.map((p) => p.title).sort()).toEqual(
      [
        `Approve deployment of ${someTask.repoName}?`,
        "Run in a sandbox?",
        "Send the invoice?",
      ].sort(),
    );
    for (const p of pushes) expect(p, p.title).not.toHaveProperty("answer");

    for (const [kind, id] of Object.entries(ids)) {
      const token = answerToken(KEY, id, { workspaceId, userId, expiresAt: Date.now() + 60_000 });
      const res = await answerFrom({ approvalId: id, token }, "allow");
      expect(res.status, kind).toBe(409);
    }
    for (const id of Object.values(ids)) {
      const [row] = await server.ctx.db
        .select({ state: schema.approvals.state })
        .from(schema.approvals)
        .where(eq(schema.approvals.id, id));
      expect(row?.state).toBe("pending");
    }
  });
});

// ---------------------------------------------------------------- budget

describe("budget", () => {
  it("resolves a send's approval within 100 ms of the answer, p95", async () => {
    const conv = await conversation("supervised");
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      let id = "";
      const decision = server.ctx.commands.approval({
        workspaceId,
        conversationId: conv.id,
        kind: "send",
        summary: `Post ${i}`,
        onChange: (a) => {
          if (a.state === "pending") id = a.id;
        },
      });
      const answer = server.ctx.push.answers.forChat(id, userId);
      if (!answer) throw new Error("no answer for a send");
      const t0 = performance.now();
      const res = await answerFrom(answer, i % 2 ? "allow" : "deny");
      expect(res.status).toBe(200);
      await decision;
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] ?? Infinity;
    console.log(`notification answer to resolved, p95 ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(100);
  });
});
