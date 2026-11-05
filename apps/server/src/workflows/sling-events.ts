import { type ApprovalView, isTerminalAction, isTerminalTask, type TaskView } from "@sling/core";
import { schema } from "@sling/db";
import { SLING_EVENTS } from "@sling/workflow";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { approvalView, taskView } from "../views.ts";

type ConversationRow = typeof schema.conversations.$inferSelect;

/** The `conversation` port type. */
export function conversationObject(c: ConversationRow) {
  return { id: c.id, key: c.externalKey ?? c.id, mode: c.mode, title: c.title };
}

/** The key that addresses a conversation: its external key, or its ID for web chats. */
export function conversationKey(c: ConversationRow): string {
  return c.externalKey ?? c.id;
}

/** The `task` port type. */
export function taskObject(t: TaskView, settleReason: string | null): Record<string, unknown> {
  const pr = t.actions.find((a) => a.kind === "open_pr" && a.url);
  return {
    id: t.id,
    title: t.title,
    state: t.state,
    runnerName: t.runnerName,
    repoName: t.repoName,
    branch: t.branch,
    summary: t.summary,
    error: t.error,
    settleReason: settleReason ?? "",
    prUrl: pr?.url ?? null,
    conversationId: t.conversationId,
    diffStats: t.diffStats,
    actions: t.actions.map((a) => ({
      kind: a.kind,
      state: a.state,
      url: a.url,
      message: a.message,
    })),
  };
}

/** The `approval` port type. */
export function approvalObject(ctx: AppContext, a: ApprovalView): Record<string, unknown> {
  const summary =
    a.kind === "workflow"
      ? summaryText(a.payload?.summary)
      : [a.task?.repoName, a.task?.branch, a.task?.summary].filter(Boolean).join(" · ");
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    summary,
    expiresAt: a.expiresAt,
    url: new URL("/approvals", ctx.config.publicUrl).toString(),
    taskId: a.taskId,
    runId: a.runId,
  };
}

function summaryText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Whether a task has reached a point a waiting workflow should hear about,
 * and why. Null while it's still running or delivering.
 */
export async function taskSettlement(
  ctx: AppContext,
  taskId: string,
): Promise<{ task: Record<string, unknown>; reason: string } | null> {
  const t = await taskView(ctx, taskId);
  if (!t) return null;
  let reason: string | null = null;
  if (t.actions.some((a) => a.state === "awaiting_approval")) reason = "approval_needed";
  else if (isTerminalTask(t.state)) {
    if (t.actions.length === 0) reason = "finished";
    else if (t.actions.every((a) => isTerminalAction(a.state))) reason = "delivered";
  }
  return reason ? { task: taskObject(t, reason), reason } : null;
}

/**
 * Task service hook: wakes runs waiting on the task, then offers
 * `sling.task_settled` and, for new approvals, `sling.approval_requested`.
 */
export async function emitTaskSettled(ctx: AppContext, taskId: string, reason: string) {
  const t = await taskView(ctx, taskId);
  if (!t) return;
  const [row] = await ctx.db
    .select({ workspaceId: schema.tasks.workspaceId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));
  if (!row) return;
  const task = taskObject(t, reason);
  await ctx.engine.onTaskSettled(taskId, task, reason);
  await ctx.events.emit({
    type: SLING_EVENTS.taskSettled,
    workspaceId: row.workspaceId,
    payload: { task, reason },
    dedupeKey: `task:${taskId}:${reason}`,
  });
  if (reason !== "approval_needed") return;
  const pending = await ctx.db
    .select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.taskId, taskId), eq(schema.approvals.state, "pending")));
  for (const p of pending) {
    const view = await approvalView(ctx, p.id);
    if (!view) continue;
    await ctx.events.emit({
      type: SLING_EVENTS.approvalRequested,
      workspaceId: row.workspaceId,
      payload: { approval: approvalObject(ctx, view) },
      dedupeKey: `approval:${p.id}`,
    });
  }
}
