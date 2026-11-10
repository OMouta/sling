/**
 * Tasks, approvals, and machines recover from what an interrupted process or
 * connection left behind: steps whose approval was decided, tasks that ended
 * here while the machine still runs them, cancels made while it was away, a
 * connect that failed halfway, and a stop that never marked anything offline.
 */
import { createServer } from "node:net";
import { newId } from "@sling/core";
import { createDatabase, schema } from "@sling/db";
import type { Envelope } from "@sling/runner-protocol";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Config } from "../src/config.ts";
import type { RunnerSession } from "../src/runners/gateway.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { FakeRunner } from "./fixtures/fake-runner.ts";

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let config: Config;
let userId = "";
let workspaceId = "";
const runners: FakeRunner[] = [];

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  const port = await freePort();
  config = {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL(`http://127.0.0.1:${port}`),
    secretKey: "e2e-secret-key-that-is-long-enough-1234",
    host: "127.0.0.1",
    port,
    logLevel: "fatal",
    webDist: undefined,
  };
  server = await startServer(config, { model: new MockLanguageModelV4({}), jobs: false });
}, 120_000);

afterAll(async () => {
  for (const r of runners) r.close();
  await server?.close();
  await pg?.stop();
});

const taskRow = async (id: string) =>
  (await server.ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0];

async function addRunner(name: string) {
  const fake = new FakeRunner({ url: server.url, name, repos: [{ name: "site", remoteUrl: "" }] });
  fake.runnerId = newId("run");
  await server.ctx.db.insert(schema.runners).values({
    id: fake.runnerId,
    workspaceId,
    ownerId: userId,
    name,
    publicKey: fake.publicKey,
  });
  runners.push(fake);
  return fake;
}

async function addTask(values: Partial<typeof schema.tasks.$inferInsert>) {
  const id = newId("tsk");
  await server.ctx.db.insert(schema.tasks).values({
    id,
    workspaceId,
    ownerId: userId,
    repoName: "site",
    title: id,
    objective: "Do it",
    mode: "supervised",
    branch: `sling/${id}`,
    ...values,
  });
  return id;
}

/** Records what the server sends to machines, connected or not. */
function recordSends() {
  const sent: { runnerId: string; envelope: Envelope }[] = [];
  const gateway = server.ctx.runners;
  const original = gateway.send.bind(gateway);
  gateway.send = (runnerId, envelope) => {
    sent.push({ runnerId, envelope });
    return original(runnerId, envelope);
  };
  return {
    sent,
    restore: () => {
      gateway.send = original;
    },
  };
}

function sessionOf(runnerId: string): RunnerSession {
  return {
    runnerId,
    workspaceId,
    ownerId: userId,
    connectedAt: Date.now(),
    lastMessageAt: Date.now(),
    send: () => true,
    close: () => {},
  };
}

it("rate limits and records sign-in under the address the server sees, not one the client sends", async () => {
  const res = await fetch(`${server.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      origin: config.publicUrl.origin,
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.9",
      "x-sling-client-ip": "198.51.100.7",
    },
    body: JSON.stringify({
      name: "Ana",
      email: "ana@example.com",
      password: "correct-horse-battery",
    }),
  });
  expect(res.status).toBe(200);
  const [session] = await server.ctx.db.select().from(schema.sessions);
  userId = session?.userId ?? "";
  const [member] = await server.ctx.db.select().from(schema.workspaceMembers);
  workspaceId = member?.workspaceId ?? "";
  expect(workspaceId).not.toBe("");
  expect(session?.ipAddress).toBe("127.0.0.1");
}, 30_000);
