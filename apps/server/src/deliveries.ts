import { createHash } from "node:crypto";
import { type ActionState, isTerminalAction, newId } from "@sling/core";
import { schema } from "@sling/db";
import { and, desc, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { AppContext } from "./context.ts";
import { NO_CHAT_WORKFLOW } from "./conversations/routes.ts";
import { currentSteps, type SettleReason } from "./tasks/service.ts";
import type { BusEvent } from "./workflows/events.ts";
import { emitTaskSettled } from "./workflows/sling-events.ts";

/** One active control plane owns this loop. Rows survive process restarts. */
export function startDeliveries(ctx: AppContext) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = Promise.resolve();
  const run = () => {
    active = drainDeliveries(ctx)
      .catch((err) => ctx.log.error({ err }, "delivery sweep failed"))
      .then(() => {
        if (!stopped) timer = setTimeout(run, 1000);
      });
  };
  run();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await active;
  };
}

export async function drainDeliveries(ctx: AppContext) {
  const rows = await ctx.db
    .select()
    .from(schema.deliveries)
    .where(
      and(isNull(schema.deliveries.completedAt), lte(schema.deliveries.availableAt, new Date())),
    )
    .orderBy(schema.deliveries.availableAt)
    .limit(20);
  for (const row of rows) {
    try {
      if (row.kind === "chat") {
        let matched = false;
        await ctx.events.emit(row.payload.event as unknown as BusEvent, {
          strict: true,
          onMatch: () => {
            matched = true;
          },
        });
        if (!matched) {
          const [conv] = await ctx.db
            .select()
            .from(schema.conversations)
            .where(eq(schema.conversations.id, String(row.payload.conversationId)));
          if (conv)
            await ctx.agent.addMessage(
              conv,
              "assistant",
              { role: "assistant", content: NO_CHAT_WORKFLOW },
              null,
              null,
              null,
              { id: String(row.payload.fallbackId) },
            );
        }
      } else {
        const taskId = String(row.payload.taskId);
        const reason = row.payload.reason as SettleReason;
        switch (row.kind) {
          case "settle.sandbox":
            await ctx.sandboxes.onTaskSettled(taskId);
            break;
          case "settle.agent":
            await ctx.agent.onTaskSettled(taskId, reason, String(row.payload.noteId));
            break;
          case "settle.workflow":
            await emitTaskSettled(ctx, taskId, reason, true);
            break;
          case "settle.push":
            ctx.push.taskSettled(taskId, reason);
            break;
          default:
            throw new Error("Unknown delivery kind");
        }
      }
      await ctx.db
        .update(schema.deliveries)
        .set({ completedAt: new Date() })
        .where(eq(schema.deliveries.id, row.id));
    } catch (err) {
      ctx.log.error(
        { err, deliveryId: row.id, attempts: row.attempts + 1 },
        "delivery failed; retrying",
      );
      await ctx.db
        .update(schema.deliveries)
        .set({
          attempts: sql`${schema.deliveries.attempts} + 1`,
          availableAt: new Date(
            Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 9)),
          ),
        })
        .where(eq(schema.deliveries.id, row.id));
    }
  }
}

type TaskRow = typeof schema.tasks.$inferSelect;
type StepState = { id: string; kind: string; state: ActionState };

/** What a settlement is about: the task's state and its steps', so a new state settles again. */
function settlementVersion(task: TaskRow, steps: { id: string; state: string }[]): string {
  return createHash("sha256")
    .update(JSON.stringify([task.state, steps.map((s) => ({ id: s.id, state: s.state }))]))
    .digest("hex");
}

async function stepsOf(ctx: AppContext, taskId: string): Promise<StepState[]> {
  return ctx.db
    .select({ id: schema.actions.id, kind: schema.actions.kind, state: schema.actions.state })
    .from(schema.actions)
    .where(eq(schema.actions.taskId, taskId))
    .orderBy(schema.actions.id);
}

/** A task's steps in the order they run, for working out where it stands. */
async function orderedSteps(ctx: AppContext, taskId: string) {
  return ctx.db
    .select({ kind: schema.actions.kind, state: schema.actions.state })
    .from(schema.actions)
    .where(eq(schema.actions.taskId, taskId))
    .orderBy(schema.actions.position);
}

/** Separate receipts prevent one failed consumer from suppressing the others. */
export async function enqueueSettlement(ctx: AppContext, taskId: string, reason: SettleReason) {
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
  if (!task) return;
  const version = settlementVersion(task, await stepsOf(ctx, taskId));
  await ctx.db
    .insert(schema.deliveries)
    .values(
      ["sandbox", "agent", "workflow", "push"].map((consumer) => ({
        id: `settle:${taskId}:${reason}:${version}:${consumer}`,
        kind: `settle.${consumer}`,
        payload: { taskId, reason, noteId: newId("msg") },
      })),
    )
    .onConflictDoNothing();
}

/**
 * Why a finished task would settle where it stands, or null when it's
 * between settle points: a step still on its way. A task that didn't
 * succeed settles as finished; a succeeded one with steps settles when one
 * waits for approval or when they've all ended.
 */
export function settleReasonOf(
  state: string,
  ordered: { kind: string; state: ActionState }[],
): SettleReason | null {
  if (state !== "succeeded") return "finished";
  const steps = currentSteps(ordered);
  if (steps.length === 0) return "finished";
  for (const step of steps) {
    if (isTerminalAction(step.state)) {
      if (step.state !== "succeeded") return "delivered";
      continue;
    }
    return step.state === "awaiting_approval" ? "approval_needed" : null;
  }
  return "delivered";
}

const SETTLE_REASONS: SettleReason[] = ["finished", "approval_needed", "delivered"];

/** Completed deliveries are kept this long, well past the reconcile's look back. */
const KEEP_DONE_MS = 30 * 24 * 60 * 60_000;

/** Forgets deliveries that completed more than a month ago, in the daily prune. */
export async function pruneDeliveries(ctx: AppContext, now = new Date()): Promise<number> {
  const gone = await ctx.db
    .delete(schema.deliveries)
    .where(lt(schema.deliveries.completedAt, new Date(now.getTime() - KEEP_DONE_MS)))
    .returning({ id: schema.deliveries.id });
  return gone.length;
}

/** How long a task must sit unchanged before the reconcile looks at it. */
const QUIET_MS = 2 * 60_000;
/** How far back the reconcile looks for tasks that ended. */
const LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Queues the settlement of tasks whose last change was saved but whose
 * settlement wasn't, as when the process stopped between the two. It looks
 * only at tasks that ended in the last day and haven't changed for two
 * minutes, so the ordinary path has long since queued theirs, and only at
 * settle points, so a step on its way isn't announced.
 */
export async function reconcileSettlements(ctx: AppContext, now = new Date()): Promise<number> {
  const quiet = new Date(now.getTime() - QUIET_MS);
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const t = schema.tasks;
  const a = schema.actions;
  const candidates = await ctx.db
    .select()
    .from(t)
    .where(
      and(
        gt(t.finishedAt, since),
        lt(t.updatedAt, quiet),
        sql`not exists (select 1 from ${a} where ${a.taskId} = ${t.id} and ${a.updatedAt} >= ${quiet})`,
      ),
    )
    .orderBy(desc(t.finishedAt))
    .limit(200);
  let queued = 0;
  for (const task of candidates) {
    const steps = await stepsOf(ctx, task.id);
    const reason = settleReasonOf(task.state, await orderedSteps(ctx, task.id));
    if (!reason) continue;
    const version = settlementVersion(task, steps);
    // Settled already under any reason: the IDs are exact, so the lookup uses the key.
    const ids = SETTLE_REASONS.map((r) => `settle:${task.id}:${r}:${version}:sandbox`);
    const [settled] = await ctx.db
      .select({ id: schema.deliveries.id })
      .from(schema.deliveries)
      .where(inArray(schema.deliveries.id, ids))
      .limit(1);
    if (settled) continue;
    ctx.log.warn({ taskId: task.id, reason }, "queued a settlement that was never queued");
    await enqueueSettlement(ctx, task.id, reason);
    queued++;
  }
  return queued;
}
