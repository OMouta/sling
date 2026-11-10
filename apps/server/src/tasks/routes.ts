import {
  APPROVAL_KINDS,
  APPROVAL_STATES,
  type ApprovalListKind,
  type ApprovalPage,
  DELIVERY_KINDS,
  HARNESSES,
  isPermissionMode,
  TASK_VIEWS,
  type TaskListView,
  type TaskPage,
  type TaskState,
} from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, desc, eq, gte, inArray, lt, ne, or, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { decodeCursor, encodeCursor } from "../http/cursor.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { ENVIRONMENTS } from "../routing/router.ts";
import { approvalViews, taskViews, toEventView } from "../views.ts";
import { TaskInputError, TaskRoutingError } from "./service.ts";

const Decision = z.object({ decision: z.enum(["approve", "reject"]) });

export async function taskRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  // Tasks, newest first, a page at a time. The filters apply before the
  // limit, and the first page carries counts and totals for all that match.
  r.get(
    "/api/tasks",
    {
      schema: {
        querystring: z.object({
          conversationId: z.string().optional(),
          view: z.enum(TASK_VIEWS).default("all"),
          harness: z.enum(HARNESSES).optional(),
          environment: z.enum(["machine", "sandbox"]).optional(),
          cursor: z.string().max(64).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (request): Promise<TaskPage> => {
      const actor = actorOf(request);
      const { conversationId, view, harness, environment, cursor, limit } = request.query;
      const t = schema.tasks;
      const scope = and(
        eq(t.workspaceId, actor.workspaceId),
        conversationId ? eq(t.conversationId, conversationId) : undefined,
        harness ? eq(t.harness, harness) : undefined,
        environment ? eq(t.environment, environment) : undefined,
      );
      const views = taskViewFilters();
      const shown = views[view];
      // IDs start with their creation time, so they order tasks newest first
      // exactly, where a cursor on the timestamp would round it.
      const rows = await ctx.db
        .select()
        .from(t)
        .where(and(scope, shown, cursor ? lt(t.id, cursor) : undefined))
        .orderBy(desc(t.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      let counts: TaskPage["counts"] = null;
      let stats: TaskPage["stats"] = null;
      if (!cursor) {
        const inView = shown ?? sql`true`;
        const [totals] = await ctx.db
          .select({
            active: sql<number>`(count(*) filter (where ${views.active}))::int`,
            attention: sql<number>`(count(*) filter (where ${views.attention}))::int`,
            total: sql<number>`(count(*) filter (where ${inView}))::int`,
            insertions: sql<number>`coalesce(sum((${t.diffStats}->>'insertions')::bigint) filter (where ${inView}), 0)::bigint`,
            deletions: sql<number>`coalesce(sum((${t.diffStats}->>'deletions')::bigint) filter (where ${inView}), 0)::bigint`,
            succeeded: sql<number>`(count(*) filter (where ${inView} and ${t.state} = 'succeeded'))::int`,
            failed: sql<number>`(count(*) filter (where ${inView} and ${t.state} = 'failed'))::int`,
          })
          .from(t)
          .where(scope);
        if (totals) {
          counts = { active: totals.active, attention: totals.attention };
          stats = {
            total: totals.total,
            insertions: Number(totals.insertions),
            deletions: Number(totals.deletions),
            succeeded: totals.succeeded,
            failed: totals.failed,
          };
        }
      }
      return {
        items: await taskViews(ctx, page),
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
        counts,
        stats,
      };
    },
  );

  async function ownedTask(workspaceId: string, id: string) {
    const [row] = await ctx.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.workspaceId, workspaceId)));
    return row ?? null;
  }

  // A task with its latest events. With `from`, every event from that one
  // on, so a refresh keeps the earlier events a reader already opened.
  r.get(
    "/api/tasks/:id",
    {
      schema: {
        params: z.object({ id: z.string() }),
        querystring: z.object({ from: z.coerce.number().int().min(0).optional() }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const row = await ownedTask(actor.workspaceId, request.params.id);
      if (!row) return reply.code(404).send({ error: "not found" });
      const [task] = await taskViews(ctx, [row]);
      const page = await eventPage(ctx, row.id, { from: request.query.from });
      return { task, events: page.events.map(toEventView), olderCursor: page.olderCursor };
    },
  );

  // The events before `before`, for showing earlier ones. Without it, the
  // newest. `limit` and `types` keep it to the few a summary shows.
  r.get(
    "/api/tasks/:id/events",
    {
      schema: {
        params: z.object({ id: z.string() }),
        querystring: z.object({
          before: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().min(1).max(EVENT_PAGE).optional(),
          types: z
            .string()
            .transform((s) => s.split(",").filter(Boolean))
            .optional(),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const row = await ownedTask(actor.workspaceId, request.params.id);
      if (!row) return reply.code(404).send({ error: "not found" });
      const { before, limit, types } = request.query;
      const page = await eventPage(ctx, row.id, { before, limit, types });
      return { events: page.events.map(toEventView), olderCursor: page.olderCursor };
    },
  );

  // Starts a task directly, without the assistant. Used by tests and the CLI.
  r.post(
    "/api/tasks",
    {
      schema: {
        body: z.object({
          repo: z.string().min(1),
          title: z.string().min(1).max(120),
          objective: z.string().min(1).max(20_000),
          deliver: z.enum(DELIVERY_KINDS).default("pr"),
          conversationId: z.string().optional(),
          mode: z.string().optional(),
          /** Defaults to `auto`, where `machineId` is a preference. `machine` makes it the only choice. */
          environment: z.enum(ENVIRONMENTS).optional(),
          machineId: z.string().optional(),
          /** The same as `machineId` with `environment: "machine"`. Kept for older clients. */
          runnerId: z.string().optional(),
          providerInstallationId: z.string().optional(),
          harness: z.enum(HARNESSES).optional(),
          labels: z.array(z.string().min(1).max(64)).max(16).optional(),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = request.body;
      let mode = body.mode;
      if (body.conversationId) {
        const [c] = await ctx.db
          .select({ mode: schema.conversations.mode })
          .from(schema.conversations)
          .where(
            and(
              eq(schema.conversations.id, body.conversationId),
              eq(schema.conversations.workspaceId, actor.workspaceId),
            ),
          );
        if (!c) return reply.code(404).send({ error: "conversation not found" });
        mode = c.mode;
      }
      if (!mode) {
        const [w] = await ctx.db
          .select({ mode: schema.workspaces.defaultMode })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, actor.workspaceId));
        mode = w?.mode ?? "supervised";
      }
      if (!isPermissionMode(mode)) return reply.code(400).send({ error: "bad mode" });
      const machineId = body.machineId ?? body.runnerId ?? null;
      try {
        const created = await ctx.tasks.create({
          workspaceId: actor.workspaceId,
          ownerId: actor.userId,
          conversationId: body.conversationId ?? null,
          repo: body.repo,
          title: body.title,
          objective: body.objective,
          mode,
          deliver: body.deliver,
          environment: body.environment ?? (body.runnerId ? "machine" : "auto"),
          machineId,
          providerInstallationId: body.providerInstallationId ?? null,
          harness: body.harness ?? null,
          labels: body.labels ?? [],
        });
        return {
          id: created.task.id,
          state: created.task.state,
          harness: created.task.harness,
          model: created.task.agentModel,
          effort: created.task.agentEffort,
          environment: created.task.environment,
          routing: created.routing,
          approvalId: created.approvalId,
        };
      } catch (err) {
        if (err instanceof TaskRoutingError) {
          return reply
            .code(400)
            .send({ error: err.message, reasons: err.reasons, routing: err.routing });
        }
        if (err instanceof TaskInputError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  r.post(
    "/api/tasks/:id/cancel",
    { schema: { params: z.object({ id: z.string() }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      const task = await ctx.tasks.cancel(actor.workspaceId, request.params.id, actor.userId);
      if (!task) return reply.code(404).send({ error: "not found" });
      return { ok: true };
    },
  );

  r.post(
    "/api/tasks/:id/approval",
    { schema: { params: z.object({ id: z.string() }), body: Decision } },
    async (request) => {
      const actor = actorOf(request);
      const n = await ctx.tasks.decideTask(
        actor.workspaceId,
        request.params.id,
        actor.userId,
        request.body.decision === "approve",
      );
      return { decided: n };
    },
  );

  // Approvals a page at a time, filtered by what they're for before the
  // limit. Pending ones list soonest to expire first unless asked for the
  // newest; the first page of pending ones counts every decision waiting.
  r.get(
    "/api/approvals",
    {
      schema: {
        querystring: z.object({
          state: z.enum(APPROVAL_STATES).default("pending"),
          kind: z.enum(APPROVAL_KINDS).default("all"),
          taskId: z.string().max(64).optional(),
          order: z.enum(["expiring", "newest"]).optional(),
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (request, reply): Promise<ApprovalPage> => {
      const actor = actorOf(request);
      const { state, kind, taskId, cursor, limit } = request.query;
      const order = request.query.order ?? (state === "pending" ? "expiring" : "newest");
      const a = schema.approvals;
      const kinds = approvalKindFilters();
      const scope = and(
        eq(a.workspaceId, actor.workspaceId),
        eq(a.state, state),
        taskId ? eq(a.taskId, taskId) : undefined,
      );
      let after: SQL | undefined;
      if (cursor && order === "expiring") {
        const at = decodeCursor(cursor);
        if (!at) return reply.code(400).send({ error: "bad cursor" });
        after = sql`(${a.expiresAt}, ${a.id}) > (${at.at}::timestamptz, ${at.id})`;
      } else if (cursor) {
        after = lt(a.id, cursor);
      }
      const rows = await ctx.db
        .select({ id: a.id, expiresAt: a.expiresAt })
        .from(a)
        .where(and(scope, kinds[kind], after))
        .orderBy(...(order === "expiring" ? [asc(a.expiresAt), asc(a.id)] : [desc(a.id)]))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      let counts: ApprovalPage["counts"] = null;
      if (!cursor && state === "pending") {
        const [n] = await ctx.db
          .select({
            tasks: sql<number>`(count(distinct ${a.taskId}) filter (where ${kinds.tasks}))::int`,
            workflows: sql<number>`(count(*) filter (where ${kinds.workflows}))::int`,
            sandboxes: sql<number>`(count(*) filter (where ${kinds.sandboxes}))::int`,
          })
          .from(a)
          .where(scope);
        counts = n ?? null;
      }
      return {
        items: await approvalViews(
          ctx,
          page.map((r) => r.id),
        ),
        nextCursor:
          rows.length > limit && last
            ? order === "expiring"
              ? encodeCursor(last.expiresAt, last.id)
              : last.id
            : null,
        counts,
      };
    },
  );

  r.post(
    "/api/approvals/:id",
    { schema: { params: z.object({ id: z.string() }), body: Decision } },
    async (request, reply) => {
      const actor = actorOf(request);
      const ok = await ctx.tasks.decide(
        actor.workspaceId,
        request.params.id,
        actor.userId,
        request.body.decision === "approve",
      );
      if (!ok) return reply.code(409).send({ error: "This approval is no longer pending." });
      return { ok: true };
    },
  );
}

const ACTIVE_STATES: TaskState[] = ["queued", "dispatched", "running"];
const PROBLEM_STATES: TaskState[] = ["failed", "rejected", "interrupted"];

/** What each task view matches, as a condition on a tasks row. */
function taskViewFilters(): Record<TaskListView, SQL | undefined> {
  const t = schema.tasks;
  const x = schema.actions;
  return {
    all: undefined,
    active: inArray(t.state, ACTIVE_STATES),
    attention: or(
      inArray(t.state, PROBLEM_STATES),
      sql`${t.id} in (select ${x.taskId} from ${x} where ${x.state} = 'awaiting_approval')`,
    ),
    done: eq(t.state, "succeeded"),
  };
}

/**
 * What each approval kind matches, the way the Approvals page groups them:
 * sandbox fallbacks, a task's steps, and everything else, which waits in a
 * workflow.
 */
function approvalKindFilters(): Record<ApprovalListKind, SQL | undefined> {
  const a = schema.approvals;
  const tasks = and(eq(a.kind, "task_action"), sql`${a.taskId} is not null`) as SQL;
  return {
    all: undefined,
    sandboxes: eq(a.kind, "sandbox_fallback"),
    tasks,
    workflows: and(ne(a.kind, "sandbox_fallback"), sql`not (${tasks})`) as SQL,
  };
}

/** Events a page of a task's timeline holds at most. */
export const EVENT_PAGE = 500;
/** Roughly how many bytes of event payloads a page holds; it always has at least one. */
export const EVENT_PAGE_BYTES = 1024 * 1024;
/** Most events a refresh from a loaded event returns before it falls back to the latest page. */
const EVENT_FROM_MAX = 20_000;

/**
 * A page of a task's events, oldest first: the newest ones before `before`
 * (or the newest of all), cut by count and size, or with `from` every event
 * from that sequence number on.
 */
export async function eventPage(
  ctx: AppContext,
  taskId: string,
  opts: { before?: number; from?: number; limit?: number; types?: string[] | undefined },
): Promise<{ events: (typeof schema.taskEvents.$inferSelect)[]; olderCursor: number | null }> {
  const e = schema.taskEvents;
  const limit = opts.limit ?? EVENT_PAGE;
  if (opts.from !== undefined) {
    const since = await ctx.db
      .select()
      .from(e)
      .where(and(eq(e.taskId, taskId), gte(e.seq, opts.from)))
      .orderBy(asc(e.seq))
      .limit(EVENT_FROM_MAX + 1);
    if (since.length <= EVENT_FROM_MAX) {
      const [older] = await ctx.db
        .select({ seq: e.seq })
        .from(e)
        .where(and(eq(e.taskId, taskId), lt(e.seq, opts.from)))
        .limit(1);
      return { events: since, olderCursor: older && since[0] ? since[0].seq : null };
    }
  }
  const newest = await ctx.db
    .select()
    .from(e)
    .where(
      and(
        eq(e.taskId, taskId),
        opts.before !== undefined ? lt(e.seq, opts.before) : undefined,
        opts.types ? inArray(e.type, opts.types) : undefined,
      ),
    )
    .orderBy(desc(e.seq))
    .limit(limit + 1);
  const kept: (typeof schema.taskEvents.$inferSelect)[] = [];
  let bytes = 0;
  for (const row of newest.slice(0, limit)) {
    bytes += JSON.stringify(row.payload).length;
    if (kept.length > 0 && bytes > EVENT_PAGE_BYTES) break;
    kept.push(row);
  }
  const more = newest.length > kept.length;
  kept.reverse();
  return { events: kept, olderCursor: more && kept[0] ? kept[0].seq : null };
}
