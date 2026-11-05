import { PgBoss } from "pg-boss";
import type { AppContext } from "./context.ts";

export const QUEUES = {
  sweep: "sweep",
  pruneEvents: "prune-events",
} as const;

/** Durable background jobs. Schedules run once across all server processes. */
export async function startJobs(ctx: AppContext, connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: "pgboss" });
  boss.on("error", (err) => ctx.log.error({ err }, "pg-boss error"));
  await boss.start();

  await boss.createQueue(QUEUES.sweep, { policy: "singleton" });
  await boss.createQueue(QUEUES.pruneEvents, { policy: "singleton" });
  await boss.schedule(QUEUES.sweep, "* * * * *");
  await boss.schedule(QUEUES.pruneEvents, "17 3 * * *");

  await boss.work(QUEUES.sweep, async () => {
    await ctx.tasks.sweep();
  });
  await boss.work(QUEUES.pruneEvents, async () => {
    const n = await ctx.tasks.pruneEvents();
    ctx.log.info({ deleted: n }, "pruned old task events");
  });
  return boss;
}
