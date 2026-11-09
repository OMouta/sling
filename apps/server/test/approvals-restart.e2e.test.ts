/**
 * A chat's approvals across a restart, on real Postgres: an answer counts
 * once, a late answer hears why it was late, and one that waited while
 * Sling restarted says so instead of doing anything.
 */
import { createServer } from "node:net";
import type { CommandApprovalView, ConversationView } from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";

vi.setConfig({ testTimeout: 60_000 });

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let config: Config;
let cookie = "";
let origin = "";

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(server.url + path, {
    method,
    headers: {
      origin,
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie();
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const start = () => startServer(config, { model: new MockLanguageModelV4({}), jobs: false });

/** Asks for a send's approval the way a turn does, and hands back its ID and outcome. */
async function ask(conversationId: string) {
  const [m] = await server.ctx.db.select().from(schema.workspaceMembers);
  if (!m) throw new Error("no workspace");
  let id = "";
  const decided = server.ctx.commands.approval({
    workspaceId: m.workspaceId,
    conversationId,
    kind: "send",
    summary: "Email ana@example.com: Lunch moved",
    onChange: (v: CommandApprovalView) => {
      id = v.id;
    },
  });
  await vi.waitFor(() => expect(id).not.toBe(""));
  return { id, decided };
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  config = {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL(origin),
    secretKey: "e2e-secret-key-that-is-long-enough-1234",
    host: "127.0.0.1",
    port,
    logLevel: "warn",
    webDist: undefined,
    releaseRepo: "acme/sling",
  };
  server = await start();
  await call("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
});

it("takes an answer once, says why a late one came late, and ends what a restart cut off", async () => {
  const conv = (await call("POST", "/api/conversations")).body as ConversationView;
  const decide = (id: string, decision: "approve" | "deny") =>
    call("POST", `/api/conversations/${conv.id}/commands/${id}`, { decision });

  // Answered once: the send goes ahead; the same answer again does nothing.
  const first = await ask(conv.id);
  expect((await decide(first.id, "approve")).status).toBe(200);
  expect(await first.decided).toBe("approved");
  const again = await decide(first.id, "approve");
  expect(again).toMatchObject({
    status: 409,
    body: { error: "That was already answered.", state: "approved" },
  });

  // Nobody answered in time.
  server.ctx.commands.approvalWaitMs = 50;
  const slow = await ask(conv.id);
  expect(await slow.decided).toBe("expired");
  expect((await decide(slow.id, "approve")).body).toMatchObject({
    error: "Nobody answered in time, so it was cancelled.",
    reason: "timeout",
  });
  server.ctx.commands.approvalWaitMs = 60_000;

  // Sling restarts while one waits: after it, the answer says so, and nothing runs.
  const cut = await ask(conv.id);
  await server.close();
  server = await start();
  const late = await decide(cut.id, "approve");
  expect(late).toMatchObject({
    status: 409,
    body: {
      error: "Sling restarted while this waited, so it was cancelled.",
      state: "expired",
      reason: "restart",
    },
  });
  const [row] = await server.ctx.db
    .select()
    .from(schema.chatApprovals)
    .where(eq(schema.chatApprovals.id, cut.id));
  expect(row).toMatchObject({ state: "expired", reason: "restart" });

  // An answer from another chat learns nothing about this one.
  const other = (await call("POST", "/api/conversations")).body as ConversationView;
  const elsewhere = await call("POST", `/api/conversations/${other.id}/commands/${cut.id}`, {
    decision: "approve",
  });
  expect(elsewhere).toMatchObject({
    status: 409,
    body: { error: "That isn't waiting for an answer anymore." },
  });
  expect(elsewhere.body.reason).toBeUndefined();
});
