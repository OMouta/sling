import { createHmac } from "node:crypto";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { SLING_EVENTS } from "@sling/workflow";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { AppContext } from "../context.ts";
import { deriveKey, sha256Hex } from "../crypto.ts";
import { workspaceTimeZone } from "../timezone.ts";
import { oneTimeAt, oneTimeInstant } from "./one-time.ts";

export const SCHEDULE_QUEUE = "workflow-schedule";

interface ScheduleJob {
  triggerId: string;
}

/**
 * A webhook trigger's token. It's derived from the server secret, the
 * workflow, and the node, so the URL stays the same across publishes and can
 * be shown again without storing the token. Only its hash is stored, for lookup.
 */
export function webhookToken(ctx: AppContext, workflowId: string, nodeId: string): string {
  const key = deriveKey(ctx.config.secretKey, "webhook-token-v1");
  return createHmac("sha256", key).update(`${workflowId}:${nodeId}`).digest("base64url");
}

export function webhookUrl(ctx: AppContext, workflowId: string, nodeId: string): string {
  return new URL(
    `/hooks/${webhookToken(ctx, workflowId, nodeId)}`,
    ctx.config.publicUrl,
  ).toString();
}

/**
 * Rebuilds a workflow's trigger subscriptions from its active version: one
 * row per trigger node while the workflow is enabled, none otherwise.
 * Schedules follow the rows, and connector sources are started or stopped to
 * match.
 */
export async function syncTriggers(ctx: AppContext, workflowId: string): Promise<void> {
  const [wf] = await ctx.db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.id, workflowId));
  const version =
    wf?.enabled && wf.activeVersionId ? await ctx.engine.version(wf.activeVersionId) : null;

  const rows: (typeof schema.workflowTriggers.$inferInsert)[] = [];
  if (wf && version) {
    for (const node of version.definition.nodes) {
      const spec = ctx.registry.get(node.type, node.version);
      if (!spec?.trigger) continue;
      const field = spec.installationFields?.[0];
      const inst = field ? node.config[field] : null;
      rows.push({
        id: newId("trg"),
        workspaceId: wf.workspaceId,
        workflowId: wf.id,
        versionId: version.id,
        nodeId: node.id,
        event: spec.trigger.event,
        config: node.config,
        installationId: typeof inst === "string" && inst ? inst : null,
        webhookTokenHash:
          spec.trigger.event === SLING_EVENTS.webhook
            ? sha256Hex(webhookToken(ctx, wf.id, node.id))
            : null,
      });
    }
  }

  const old = await ctx.db.transaction(async (tx) => {
    const removed = await tx
      .delete(schema.workflowTriggers)
      .where(eq(schema.workflowTriggers.workflowId, workflowId))
      .returning();
    if (rows.length > 0) await tx.insert(schema.workflowTriggers).values(rows);
    return removed;
  });

  const boss = ctx.boss;
  if (boss) {
    for (const o of old) {
      // A one-time job left behind finds its trigger gone, and does nothing.
      if (o.event === SLING_EVENTS.schedule && !oneTimeAt(o.config)) {
        await boss.unschedule(SCHEDULE_QUEUE, o.id);
      }
    }
    let workspaceZone: string | null = null;
    for (const r of rows) {
      if (r.event !== SLING_EVENTS.schedule) continue;
      let tz = scheduleZone(r.config);
      if (!tz) {
        workspaceZone ??= await workspaceTimeZone(ctx, r.workspaceId);
        tz = workspaceZone;
      }
      await schedule(ctx, r, tz);
    }
  }
  if (wf) await ctx.connectors.reconcile(wf.workspaceId);
}

/** A schedule's own time zone. Null when it's empty, which follows the workspace's. */
function scheduleZone(config: Record<string, unknown> | null | undefined): string | null {
  const tz = config?.timezone;
  return typeof tz === "string" && tz.trim() ? tz.trim() : null;
}

async function schedule(
  ctx: AppContext,
  r: { id: string; workflowId: string; nodeId: string; config?: Record<string, unknown> | null },
  tz: string,
) {
  if (oneTimeAt(r.config)) {
    // A job that starts then. Moving it to another zone sends another, and the stale one does nothing.
    const at = oneTimeInstant(r.config ?? {}, tz);
    if (!at) {
      ctx.log.warn(
        { workflowId: r.workflowId, nodeId: r.nodeId },
        "couldn't read a one-time schedule",
      );
      return;
    }
    await ctx.boss?.send(SCHEDULE_QUEUE, { triggerId: r.id }, { startAfter: at });
    return;
  }
  const cron = String(r.config?.cron ?? "");
  try {
    await ctx.boss?.schedule(SCHEDULE_QUEUE, cron, { triggerId: r.id }, { key: r.id, tz });
  } catch (err) {
    ctx.log.warn(
      { err, workflowId: r.workflowId, nodeId: r.nodeId },
      "couldn't schedule a trigger",
    );
  }
}

/**
 * Moves the workspace's schedules that follow its time zone to the new one.
 * Schedules with a zone of their own stay as they are.
 */
export async function followWorkspaceZone(ctx: AppContext, workspaceId: string): Promise<void> {
  if (!ctx.boss) return;
  const rows = await ctx.db
    .select()
    .from(schema.workflowTriggers)
    .where(
      and(
        eq(schema.workflowTriggers.workspaceId, workspaceId),
        eq(schema.workflowTriggers.event, SLING_EVENTS.schedule),
      ),
    );
  const following = rows.filter((r) => !scheduleZone(r.config));
  if (following.length === 0) return;
  const tz = await workspaceTimeZone(ctx, workspaceId);
  for (const r of following) await schedule(ctx, r, tz);
}

/** Starts the scheduler queue's worker. */
export async function startScheduleWorker(ctx: AppContext, boss: PgBoss): Promise<void> {
  await boss.createQueue(SCHEDULE_QUEUE);
  await boss.work<ScheduleJob>(SCHEDULE_QUEUE, async (jobs) => {
    // While automation is paused, ticks are dropped, as they are while the server is
    // down. Kept, they would all fire at once when it resumes.
    if (ctx.config.automationPaused) return;
    for (const job of jobs) await fireSchedule(ctx, job.data.triggerId, job.id);
  });
}

/**
 * Starts a run for a schedule trigger. A schedule left behind by a removed
 * trigger is dropped. A one-time schedule runs once, then turns its
 * workflow off.
 */
export async function fireSchedule(ctx: AppContext, triggerId: string, jobId: string) {
  const [row] = await ctx.db
    .select({ trigger: schema.workflowTriggers, workflow: schema.workflows })
    .from(schema.workflowTriggers)
    .innerJoin(schema.workflows, eq(schema.workflows.id, schema.workflowTriggers.workflowId))
    .where(
      and(
        eq(schema.workflowTriggers.id, triggerId),
        eq(schema.workflowTriggers.event, SLING_EVENTS.schedule),
      ),
    );
  if (!row?.workflow.enabled) {
    await ctx.boss?.unschedule(SCHEDULE_QUEUE, triggerId);
    return null;
  }
  const once = oneTimeAt(row.trigger.config);
  if (once) {
    // A job from before the workspace changed zones may come early. The one sent for the new zone runs.
    const at = oneTimeInstant(
      row.trigger.config,
      await workspaceTimeZone(ctx, row.workflow.workspaceId),
    );
    if (!at || at.getTime() > Date.now() + 1_000) return null;
  }
  const run = await ctx.engine.startRun({
    workflowId: row.workflow.id,
    workspaceId: row.workflow.workspaceId,
    ownerId: row.workflow.ownerId,
    versionId: row.trigger.versionId,
    triggerNodeId: row.trigger.nodeId,
    outputs: { firedAt: new Date().toISOString() },
    dedupeKey: once ? `once:${triggerId}` : `schedule:${jobId}`,
  });
  if (once) await ctx.workflows.ranOnce(row.workflow);
  return run;
}

/** Finds the enabled webhook trigger for a token. */
export async function webhookTrigger(ctx: AppContext, token: string) {
  const [row] = await ctx.db
    .select({ trigger: schema.workflowTriggers, workflow: schema.workflows })
    .from(schema.workflowTriggers)
    .innerJoin(schema.workflows, eq(schema.workflows.id, schema.workflowTriggers.workflowId))
    .where(eq(schema.workflowTriggers.webhookTokenHash, sha256Hex(token)));
  if (!row?.workflow.enabled) return null;
  return row;
}
