/**
 * Startup that fails partway, and shutdown that gets stuck, must still release the
 * database: the pool's connections and the advisory lock that makes this process the
 * only control plane. Otherwise a restarted server can't take over.
 */

import { createDatabase, type Database } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { recordNode } from "./fixtures/nodes.ts";

let container: StartedPostgreSqlContainer;
let admin: Database["pool"];

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  admin = createDatabase(container.getConnectionUri(), 1).pool;
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await container?.stop();
});

async function freshDatabase(name: string): Promise<string> {
  await admin.query(`create database ${name}`);
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${name}`;
  return url.toString();
}

function config(databaseUrl: string, extra: Partial<Config> = {}): Config {
  return {
    databaseUrl,
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

async function sql(url: string, statement: string) {
  const database = createDatabase(url, 1);
  try {
    await database.pool.query(statement);
  } finally {
    await database.close();
  }
}

const opts = () => ({ model: new MockLanguageModelV4({}), jobs: false });

/** Connections other sessions hold to a database, once closed ones have gone. */
async function connectionsTo(name: string): Promise<number> {
  let count = -1;
  for (let i = 0; i < 40; i++) {
    const res = await admin.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = $1 and pid <> pg_backend_pid() and backend_type = 'client backend'`,
      [name],
    );
    count = res.rows[0]?.n ?? -1;
    if (count === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return count;
}

it("releases the database when migrations fail", async () => {
  const url = await freshDatabase("broken_migration");
  // The first migration creates this table, so it fails partway.
  await sql(url, "create table accounts (id text)");

  await expect(startServer(config(url), opts())).rejects.toThrow();
  expect(await connectionsTo("broken_migration")).toBe(0);

  await sql(url, "drop table accounts");
  // Another control plane holding the lock would make this fail.
  const server = await startServer(config(url), opts());
  await server.close();
  expect(await connectionsTo("broken_migration")).toBe(0);
}, 120_000);

it("releases the database when initialization fails after migrating", async () => {
  const url = await freshDatabase("broken_init");
  await expect(
    startServer(config(url), { ...opts(), nodes: [recordNode, recordNode] }),
  ).rejects.toThrow("registered twice");
  expect(await connectionsTo("broken_init")).toBe(0);

  const server = await startServer(config(url), opts());
  await server.close();
}, 120_000);

it("stops cleanly when startup is aborted", async () => {
  const url = await freshDatabase("aborted_start");
  const abort = new AbortController();
  abort.abort(new Error("stopped"));
  await expect(startServer(config(url), { ...opts(), signal: abort.signal })).rejects.toThrow(
    "stopped",
  );
  expect(await connectionsTo("aborted_start")).toBe(0);
}, 120_000);

it("bounds a stuck drain by the shutdown deadline and runs cleanup once", async () => {
  const url = await freshDatabase("stuck_drain");
  const server = await startServer(config(url, { shutdownTimeoutMs: 2_000 }), opts());
  const stopEngine = vi.spyOn(server.ctx.engine, "stop");
  server.ctx.sandboxes.idle = () => new Promise(() => {});

  const started = performance.now();
  const first = server.close();
  const second = server.close();
  expect(second).toBe(first);
  await expect(first).rejects.toThrow("Server shutdown failed");
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(1_400);
  expect(elapsed).toBeLessThan(3_000);
  expect(stopEngine).toHaveBeenCalledTimes(1);

  const readiness = await fetch(`${server.url}/readyz`).catch(() => null);
  expect(readiness?.ok ?? false).toBe(false);
  expect(await connectionsTo("stuck_drain")).toBe(0);
  const next = await startServer(config(url), opts());
  await next.close();
}, 120_000);
