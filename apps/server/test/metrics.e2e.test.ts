/**
 * `/metrics` exists only when the operator sets a token, reports a stalled queue and a
 * failing delivery from the real database, and never ties runner connectivity to readiness.
 */
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";

const TOKEN = "metrics-token-that-is-long-enough-for-the-check";
let pg: StartedPostgreSqlContainer;
let server: RunningServer;

function config(extra: Partial<Config> = {}): Config {
  return {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL("http://127.0.0.1:0"),
    secretKey: "e2e-secret-key-that-is-long-enough-1234",
    host: "127.0.0.1",
    port: 0,
    logLevel: "fatal",
    webDist: undefined,
    releaseRepo: "acme/sling",
    ...extra,
  };
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  server = await startServer(config({ metricsToken: TOKEN }), {
    model: new MockLanguageModelV4({}),
    jobs: false,
  });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
});

const scrape = (headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
  fetch(`${server.url}/metrics`, { headers });

it("answers 404 when no token is configured", async () => {
  await server.close();
  const off = await startServer(config(), { model: new MockLanguageModelV4({}), jobs: false });
  try {
    const res = await fetch(`${off.url}/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  } finally {
    await off.close();
  }
  server = await startServer(config({ metricsToken: TOKEN }), {
    model: new MockLanguageModelV4({}),
    jobs: false,
  });
}, 60_000);

it("requires the bearer token", async () => {
  expect((await scrape({})).status).toBe(401);
  expect((await scrape({ authorization: "Bearer wrong" })).status).toBe(401);
  const res = await scrape();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
});

it("reports request durations by route, not by URL", async () => {
  await fetch(`${server.url}/api/tasks/task_secret_123`);
  const text = await (await scrape()).text();
  expect(text).toMatch(
    /sling_http_request_duration_seconds_count\{method="GET",route="\/api\/tasks\/:id",status="401"\} 1/,
  );
  expect(text).not.toContain("task_secret_123");
  expect(text).toContain('sling_scrape_collector_success{collector="database"} 1');
});

it("shows a stalled queue's lag and a failing delivery", async () => {
  const boss = server.ctx.boss;
  if (!boss) throw new Error("no job queue");
  // A queue no worker reads stands in for a stalled worker.
  await boss.createQueue("stalled-for-test");
  await boss.send("stalled-for-test", { n: 1 });
  await server.ctx.db.insert(schema.deliveries).values({
    id: "test-bogus-delivery",
    kind: "test.unknown",
    payload: {},
  });

  let text = "";
  for (let i = 0; i < 50; i++) {
    text = await (await scrape()).text();
    const lag = Number(
      text.match(/sling_job_queue_lag_seconds\{queue="stalled-for-test"\} (\S+)/)?.[1],
    );
    const failures = Number(
      text.match(/sling_delivery_failures_total\{kind="test.unknown"\} (\S+)/)?.[1],
    );
    if (lag >= 1 && failures >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(text).toContain('sling_job_queue_jobs{queue="stalled-for-test",state="waiting"} 1');
  expect(
    Number(text.match(/sling_job_queue_lag_seconds\{queue="stalled-for-test"\} (\S+)/)?.[1]),
  ).toBeGreaterThanOrEqual(1);
  expect(text).toMatch(/sling_delivery_failures_total\{kind="test.unknown"\} [1-9]/);
  expect(text).toContain('sling_deliveries_failing{kind="test.unknown"} 1');
  expect(text).toContain('sling_deliveries_pending{kind="settle.push"} 0');
}, 30_000);

it("keeps the API ready with no runner connected", async () => {
  const text = await (await scrape()).text();
  expect(text).toContain("sling_runners_connected 0");
  const ready = await fetch(`${server.url}/readyz`);
  expect(ready.status).toBe(200);
});
