/**
 * A task whose last change was saved but whose settlement wasn't queued, as
 * when the process stops between the two, gets settled by the reconcile on
 * real Postgres: once, at a settle point, and never while it's still moving.
 */
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MockLanguageModelV4 } from "ai/test";
import { like } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { enqueueSettlement, reconcileSettlements } from "../src/deliveries.ts";
import { type RunningServer, startServer } from "../src/server.ts";

let pg: StartedPostgreSqlContainer;
let server: RunningServer;

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  server = await startServer(
    {
      databaseUrl: pg.getConnectionUri(),
      publicUrl: new URL("http://127.0.0.1:0"),
      secretKey: "e2e-secret-key-that-is-long-enough-1234",
      host: "127.0.0.1",
      port: 0,
      logLevel: "fatal",
      webDist: undefined,
      releaseRepo: "acme/sling",
    },
    { model: new MockLanguageModelV4({}), jobs: false },
  );
}, 120_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
});

it("queues a settlement that was lost, once, and leaves the rest alone", async () => {
  const { db } = server.ctx;
  // The delivery loop may run what's queued; the rows stay, so this counts them.
  const now = new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  await db.insert(schema.users).values({ id: "usr_1", name: "Ana", email: "ana@example.com" });
  await db.insert(schema.workspaces).values({ id: "wsp_1", name: "Ana" });
  const task = async (
    state: "succeeded" | "failed",
    changed: Date,
    steps: { kind: string; state: string }[] = [],
  ) => {
    const id = newId("tsk");
    await db.insert(schema.tasks).values({
      id,
      workspaceId: "wsp_1",
      ownerId: "usr_1",
      repoName: "site",
      title: id,
      objective: "Do it",
      mode: "auto",
      branch: `sling/${id}`,
      state,
      finishedAt: changed,
      updatedAt: changed,
    });
    for (const [position, s] of steps.entries()) {
      await db.insert(schema.actions).values({
        id: newId("act"),
        taskId: id,
        workspaceId: "wsp_1",
        ownerId: "usr_1",
        kind: s.kind as "push",
        state: s.state as "queued",
        position,
        requiresApproval: true,
        updatedAt: changed,
      } as typeof schema.actions.$inferInsert);
    }
    return id;
  };
  const queuedFor = async (taskId: string) =>
    db
      .select({ id: schema.deliveries.id, kind: schema.deliveries.kind })
      .from(schema.deliveries)
      .where(like(schema.deliveries.id, `settle:${taskId}:%`));

  const lost = await task("failed", ago(10));
  const waiting = await task("succeeded", ago(10), [{ kind: "push", state: "awaiting_approval" }]);
  const settled = await task("succeeded", ago(10));
  await enqueueSettlement(server.ctx, settled, "finished");
  const recent = await task("failed", ago(0.5));
  const moving = await task("succeeded", ago(10), [{ kind: "push", state: "sent" }]);
  const old = await task("failed", ago(60 * 48));

  expect(await reconcileSettlements(server.ctx, now)).toBe(2);
  const forLost = await queuedFor(lost);
  expect(forLost.map((d) => d.kind).sort()).toEqual(
    ["settle.agent", "settle.push", "settle.sandbox", "settle.workflow"].sort(),
  );
  expect(forLost.every((d) => d.id.startsWith(`settle:${lost}:finished:`))).toBe(true);
  expect((await queuedFor(waiting)).every((d) => d.id.includes(":approval_needed:"))).toBe(true);
  expect(await queuedFor(settled)).toHaveLength(4);
  expect(await queuedFor(recent)).toHaveLength(0);
  expect(await queuedFor(moving)).toHaveLength(0);
  expect(await queuedFor(old)).toHaveLength(0);

  // A second pass finds nothing left to queue.
  expect(await reconcileSettlements(server.ctx, now)).toBe(0);
});
