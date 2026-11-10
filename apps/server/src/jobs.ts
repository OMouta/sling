import { PgBoss } from "pg-boss";
import type { AppContext } from "./context.ts";
import { pruneDeliveries, reconcileSettlements } from "./deliveries.ts";

export const QUEUES = {
  sweep: "sweep",
  pruneEvents: "prune-events",
} as const;

/**
 * Durable background jobs. The workflow engine always needs the instance;
 * `schedules: false` skips the sweep and prune schedules (tests call them
 * directly). Schedules run once across all server processes.
 */
export async function startJobs(
  ctx: AppContext,
  connectionString: string,
  opts: { schedules: boolean },
): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: "pgboss", useListenNotify: true });
  boss.on("error", (err) => ctx.log.error({ err }, "pg-boss error"));
  try {
    await boss.start();
    if (opts.schedules) await schedule(ctx, boss);
  } catch (err) {
    // The caller never gets this instance, so it can't stop it.
    await boss.stop({ graceful: false }).catch(() => {});
    throw err;
  }
  return boss;
}

async function schedule(ctx: AppContext, boss: PgBoss) {
  await boss.createQueue(QUEUES.sweep, { policy: "singleton" });
  await boss.createQueue(QUEUES.pruneEvents, { policy: "singleton" });
  await boss.schedule(QUEUES.sweep, "* * * * *");
  await boss.schedule(QUEUES.pruneEvents, "17 3 * * *");

  await boss.work(QUEUES.sweep, async () => {
    await ctx.tasks.sweep();
    await ctx.sandboxes.sweep();
    await ctx.deploys.sweep();
    await reconcileSettlements(ctx);
    await ctx.engine.reconcile();
  });
  await boss.work(QUEUES.pruneEvents, async () => {
    const n = await ctx.tasks.pruneEvents();
    const payloads = await ctx.engine.prunePayloads();
    await ctx.commands.pruneOutcomes();
    await pruneDeliveries(ctx);
    ctx.log.info(
      { deleted: n, nodeRunPayloads: payloads },
      "pruned old task events and node run payloads",
    );
  });
}
