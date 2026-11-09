import { createHash } from "node:crypto";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { AppContext } from "./context.ts";
import { NO_CHAT_WORKFLOW } from "./conversations/routes.ts";
import type { SettleReason } from "./tasks/service.ts";
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

/** Separate receipts prevent one failed consumer from suppressing the others. */
export async function enqueueSettlement(ctx: AppContext, taskId: string, reason: SettleReason) {
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
  if (!task) return;
  const actions = await ctx.db
    .select({ id: schema.actions.id, state: schema.actions.state })
    .from(schema.actions)
    .where(eq(schema.actions.taskId, taskId))
    .orderBy(schema.actions.id);
  const version = createHash("sha256")
    .update(JSON.stringify([task.state, actions]))
    .digest("hex");
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
