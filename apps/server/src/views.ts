import type {
  ActionView,
  ApprovalView,
  ConversationView,
  RunnerView,
  TaskEventType,
  TaskEventView,
  TaskView,
} from "@sling/core";
import { isHarness, remoteKey } from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AppContext } from "./context.ts";

type RunnerRow = typeof schema.runners.$inferSelect;
type RepoRow = typeof schema.repos.$inferSelect;
type TaskRow = typeof schema.tasks.$inferSelect;
type ActionRow = typeof schema.actions.$inferSelect;
type EventRow = typeof schema.taskEvents.$inferSelect;
type ConversationRow = typeof schema.conversations.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toRunnerView(r: RunnerRow, repos: RepoRow[]): RunnerView {
  return {
    id: r.id,
    name: r.name,
    online: r.online,
    lastSeenAt: iso(r.lastSeenAt),
    version: r.version,
    os: r.os,
    arch: r.arch,
    hostname: r.hostname,
    capabilities: r.capabilities,
    maxMode: r.maxMode,
    maxConcurrentTasks: r.maxConcurrentTasks,
    pairedAt: r.pairedAt.toISOString(),
    revokedAt: iso(r.revokedAt),
    repos: repos
      .filter((p) => p.runnerId === r.id && !p.removedAt)
      .map((p) => ({
        id: p.id,
        name: p.name,
        defaultBranch: p.defaultBranch,
        remoteUrl: p.remoteUrl,
        network: p.network,
        remoteKey: remoteKey(p.remoteUrl),
      })),
    labels: [],
    ephemeral: false,
    sandboxId: null,
  };
}

export async function runnerViews(ctx: AppContext, workspaceId: string): Promise<RunnerView[]> {
  const rows = await ctx.db
    .select()
    .from(schema.runners)
    .where(and(eq(schema.runners.workspaceId, workspaceId), isNull(schema.runners.revokedAt)))
    .orderBy(asc(schema.runners.pairedAt));
  if (rows.length === 0) return [];
  const repos = await ctx.db
    .select()
    .from(schema.repos)
    .where(
      inArray(
        schema.repos.runnerId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map((r) => toRunnerView(r, repos));
}

export async function runnerView(ctx: AppContext, runnerId: string): Promise<RunnerView | null> {
  const [row] = await ctx.db.select().from(schema.runners).where(eq(schema.runners.id, runnerId));
  if (!row) return null;
  const repos = await ctx.db.select().from(schema.repos).where(eq(schema.repos.runnerId, runnerId));
  return toRunnerView(row, repos);
}

export function toActionView(a: ActionRow, approvalId: string | null): ActionView {
  return {
    id: a.id,
    taskId: a.taskId,
    kind: a.kind,
    state: a.state,
    requiresApproval: a.requiresApproval,
    url: a.url,
    message: a.message,
    approvalId,
  };
}

async function actionsFor(ctx: AppContext, taskIds: string[]): Promise<Map<string, ActionView[]>> {
  const out = new Map<string, ActionView[]>();
  if (taskIds.length === 0) return out;
  const rows = await ctx.db
    .select()
    .from(schema.actions)
    .where(inArray(schema.actions.taskId, taskIds))
    .orderBy(asc(schema.actions.position));
  const approvals = rows.length
    ? await ctx.db
        .select({ id: schema.approvals.id, actionId: schema.approvals.actionId })
        .from(schema.approvals)
        .where(
          inArray(
            schema.approvals.actionId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  const approvalByAction = new Map(approvals.map((a) => [a.actionId, a.id]));
  for (const row of rows) {
    const list = out.get(row.taskId) ?? [];
    list.push(toActionView(row, approvalByAction.get(row.id) ?? null));
    out.set(row.taskId, list);
  }
  return out;
}

function toTaskView(t: TaskRow, runnerName: string | null, actions: ActionView[]): TaskView {
  return {
    id: t.id,
    conversationId: t.conversationId,
    runnerId: t.runnerId,
    runnerName,
    harness: isHarness(t.harness) ? t.harness : "codex",
    environment: { kind: "machine", sandboxId: null, sandboxState: null, providerName: null },
    routing: null,
    repoName: t.repoName,
    title: t.title,
    objective: t.objective,
    mode: t.mode,
    deliver: t.deliver,
    state: t.state,
    branch: t.branch,
    commitSha: t.commitSha,
    diffStats: t.diffStats ?? null,
    summary: t.summary,
    error: t.error,
    harnessVersion: t.harnessVersion,
    runnerOffline: t.runnerOfflineSince !== null,
    cancelRequested: t.cancelRequestedAt !== null,
    createdAt: t.createdAt.toISOString(),
    startedAt: iso(t.startedAt),
    finishedAt: iso(t.finishedAt),
    actions,
  };
}

export async function taskViews(ctx: AppContext, rows: TaskRow[]): Promise<TaskView[]> {
  if (rows.length === 0) return [];
  const runnerIds = [...new Set(rows.flatMap((t) => (t.runnerId ? [t.runnerId] : [])))];
  const runners = runnerIds.length
    ? await ctx.db
        .select({ id: schema.runners.id, name: schema.runners.name })
        .from(schema.runners)
        .where(inArray(schema.runners.id, runnerIds))
    : [];
  const names = new Map(runners.map((r) => [r.id, r.name]));
  const actions = await actionsFor(
    ctx,
    rows.map((t) => t.id),
  );
  return rows.map((t) =>
    toTaskView(
      t,
      t.runnerId ? (names.get(t.runnerId) ?? "unknown") : null,
      actions.get(t.id) ?? [],
    ),
  );
}

export async function taskView(ctx: AppContext, taskId: string): Promise<TaskView | null> {
  const [row] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
  if (!row) return null;
  const [view] = await taskViews(ctx, [row]);
  return view ?? null;
}

export function toEventView(e: EventRow): TaskEventView {
  return {
    taskId: e.taskId,
    seq: e.seq,
    at: e.at.toISOString(),
    type: e.type as TaskEventType,
    payload: e.payload as Record<string, unknown>,
  };
}

export function toConversationView(c: ConversationRow): ConversationView {
  return {
    id: c.id,
    title: c.title,
    mode: c.mode,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function approvalView(
  ctx: AppContext,
  approvalId: string,
): Promise<ApprovalView | null> {
  const [row] = await ctx.db
    .select({
      approval: schema.approvals,
      action: schema.actions,
      task: schema.tasks,
      runnerName: schema.runners.name,
      remoteUrl: schema.repos.remoteUrl,
    })
    .from(schema.approvals)
    .leftJoin(schema.actions, eq(schema.actions.id, schema.approvals.actionId))
    .leftJoin(schema.tasks, eq(schema.tasks.id, schema.approvals.taskId))
    .leftJoin(schema.runners, eq(schema.runners.id, schema.tasks.runnerId))
    .leftJoin(schema.repos, eq(schema.repos.id, schema.tasks.repoId))
    .where(eq(schema.approvals.id, approvalId));
  if (!row) return null;
  const { approval, action, task } = row;
  const title =
    approval.title ??
    (action && task
      ? `${action.kind === "open_pr" ? "Open a pull request" : "Push"}: ${task.title}`
      : "Approval");
  return {
    id: approval.id,
    kind: approval.kind,
    title,
    state: approval.state,
    expiresAt: approval.expiresAt.toISOString(),
    createdAt: approval.createdAt.toISOString(),
    taskId: task?.id ?? null,
    actionId: action?.id ?? null,
    actionKind: action?.kind ?? null,
    task: task
      ? {
          title: task.title,
          repoName: task.repoName,
          runnerName: row.runnerName ?? "unknown",
          branch: task.branch,
          remoteUrl: row.remoteUrl ?? "",
          diffStats: task.diffStats ?? null,
          summary: task.summary,
          conversationId: task.conversationId,
        }
      : null,
    prTitle: action?.prTitle ?? null,
    prBody: action?.prBody ?? null,
    runId: approval.runId,
    payload: approval.payload ?? null,
  };
}
