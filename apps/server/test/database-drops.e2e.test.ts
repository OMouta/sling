/**
 * The database closing the server's idle connections, as it does on a restart, must not crash
 * the server: the pool drops them and the next query opens a new one.
 */
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { startServer } from "../src/server.ts";

it("keeps working after the database closes its idle connections", async () => {
  const pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  const server = await startServer(
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
  try {
    const { db } = server.ctx;
    // A few at once, so the pool keeps more than the one connection the next query takes.
    await Promise.all([1, 2, 3].map(() => db.execute(sql`select pg_sleep(0.1)`)));
    const { rowCount } = await db.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity
           where datname = current_database() and pid <> pg_backend_pid()
             and backend_type = 'client backend'`,
    );
    expect(rowCount).toBeGreaterThan(1);
    await new Promise((ok) => setTimeout(ok, 200));

    const { rows } = await db.execute<{ one: number }>(sql`select 1 as one`);
    expect(rows[0]?.one).toBe(1);
  } finally {
    await server.close();
    await pg.stop();
  }
}, 120_000);
