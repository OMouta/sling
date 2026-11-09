/**
 * Retention pruning against a large backlog of expired task events: it deletes in
 * whole batches, keeps events inside the retention window, resumes after being cut
 * off mid-batch, and leaves the API responsive while it runs.
 *
 * SLING_PRUNE_EVENTS sets the backlog size (default 300,000). Timings are printed.
 */
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src/server.ts";

const EXPIRED = Number(process.env.SLING_PRUNE_EVENTS ?? 300_000);
const FRESH = 20_000;
const TASKS = 1_000;
const BATCH = 1_000;

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let cookie = "";

const ORIGIN = "http://sling.test";

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  server = await startServer(
    {
      databaseUrl: pg.getConnectionUri(),
      publicUrl: new URL(ORIGIN),
      secretKey: "prune-test-secret-key-that-is-long-enough",
      host: "127.0.0.1",
      port: 0,
      logLevel: "fatal",
      webDist: undefined,
    },
    { model: new MockLanguageModelV4({}), jobs: false },
  );
  const res = await fetch(`${server.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ name: "A", email: "a@example.com", password: "correct-horse-battery" }),
  });
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}, 120_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
});

async function count(where: "expired" | "fresh"): Promise<number> {
  const cutoff = sql`now() - interval '30 days'`;
  const { rows } = await server.ctx.db.execute<{ n: number }>(
    where === "expired"
      ? sql`select count(*)::int as n from task_events where at < ${cutoff}`
      : sql`select count(*)::int as n from task_events where at >= ${cutoff}`,
  );
  return rows[0]?.n ?? -1;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

/** Times a task detail request, which reads the table being pruned, until stopped. */
function sampleLatency(taskId: string) {
  const samples: number[] = [];
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      const t = performance.now();
      const res = await fetch(`${server.url}/api/tasks/${taskId}`, {
        headers: { origin: ORIGIN, cookie },
      });
      await res.arrayBuffer();
      if (!res.ok) throw new Error(`task detail answered ${res.status}`);
      samples.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  return async () => {
    stopped = true;
    await done;
    return {
      n: samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      max: Math.max(...samples),
    };
  };
}

it("prunes a large backlog in whole batches and resumes after an interruption", async () => {
  const db = server.ctx.db;
  const [member] = await db.select().from(schema.workspaceMembers).limit(1);
  if (!member) throw new Error("no workspace");
  const loadStarted = performance.now();
  await db.execute(sql`
    insert into tasks (id, workspace_id, owner_id, repo_name, title, objective, mode, branch, state)
    select 'tsk_prune_' || g, ${member.workspaceId}, ${member.userId}, 'repo', 'Task ' || g,
      'objective', 'workspace-write', 'sling/prune-' || g, 'succeeded'
    from generate_series(0, ${TASKS - 1}) g`);
  // Expired events are spread over ten days, the way a backlog builds up after a pause.
  await db.execute(sql`
    insert into task_events (task_id, seq, workspace_id, at, type, payload)
    select 'tsk_prune_' || (g % ${TASKS}), g, ${member.workspaceId},
      now() - interval '40 days' + (g * interval '10 days' / ${EXPIRED}),
      'agent.message', jsonb_build_object('text', repeat('x', 200))
    from generate_series(1, ${EXPIRED}) g`);
  await db.execute(sql`
    insert into task_events (task_id, seq, workspace_id, at, type, payload)
    select 'tsk_prune_' || (g % ${TASKS}), ${EXPIRED} + g, ${member.workspaceId},
      now() - interval '1 day' + (g * interval '1 second'),
      'agent.message', jsonb_build_object('text', repeat('x', 200))
    from generate_series(1, ${FRESH}) g`);
  await db.execute(sql`analyze task_events`);
  const loadMs = performance.now() - loadStarted;
  expect(await count("expired")).toBe(EXPIRED);

  const idle = sampleLatency("tsk_prune_1");
  await new Promise((r) => setTimeout(r, 1_000));
  const baseline = await idle();

  // Cut the prune off mid-batch: once a few batches have committed, a table
  // lock holds its next batch, and that batch's connection is killed while
  // it waits, so the cut always lands inside a batch.
  const admin = server.ctx.db;
  // Its failure is caught right away, so it never counts as unhandled while this waits.
  const interrupted = server.ctx.tasks.pruneEvents().then(
    () => null,
    (err: unknown) => err,
  );
  while ((await count("expired")) > EXPIRED - 2 * BATCH) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`lock table task_events in exclusive mode`);
    for (;;) {
      const { rows } = await admin.execute<{ n: number }>(sql`
        select count(pg_terminate_backend(pid))::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query like '%with batch as%' and pid <> pg_backend_pid()`);
      if ((rows[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  });
  expect(await interrupted).toBeInstanceOf(Error);
  const afterInterrupt = await count("expired");
  // Every batch commits on its own: the cut-off batch rolled back and nothing partial remains.
  expect((EXPIRED - afterInterrupt) % BATCH).toBe(0);
  expect(afterInterrupt).toBeLessThan(EXPIRED);

  const during = sampleLatency("tsk_prune_1");
  const calls: { deleted: number; ms: number }[] = [];
  const started = performance.now();
  for (;;) {
    const t = performance.now();
    const deleted = await server.ctx.tasks.pruneEvents();
    calls.push({ deleted, ms: Math.round(performance.now() - t) });
    if (deleted === 0) break;
  }
  const pruneMs = performance.now() - started;
  const latency = await during();

  expect(await count("expired")).toBe(0);
  expect(await count("fresh")).toBe(FRESH);
  expect(calls.reduce((n, c) => n + c.deleted, 0)).toBe(afterInterrupt);

  const fmt = (l: { n: number; p50: number; p95: number; max: number }) =>
    `p50 ${l.p50.toFixed(1)} ms, p95 ${l.p95.toFixed(1)} ms, max ${l.max.toFixed(1)} ms over ${l.n} requests`;
  console.log(
    [
      `backlog: ${EXPIRED} expired + ${FRESH} fresh events over ${TASKS} tasks, loaded in ${(loadMs / 1000).toFixed(1)} s`,
      `interrupted after ${EXPIRED - afterInterrupt} deletions; ${afterInterrupt} left, a whole number of batches`,
      `resumed: ${afterInterrupt} events in ${(pruneMs / 1000).toFixed(1)} s (${Math.round(afterInterrupt / (pruneMs / 1000))} events/s) over ${calls.length} calls: ${calls.map((c) => `${c.deleted} in ${c.ms} ms`).join(", ")}`,
      `task detail latency idle: ${fmt(baseline)}`,
      `task detail latency while pruning: ${fmt(latency)}`,
    ].join("\n"),
  );
}, 300_000);
