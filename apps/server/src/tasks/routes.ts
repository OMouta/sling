import { DELIVERY_KINDS, HARNESSES, isPermissionMode } from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { ENVIRONMENTS } from "../routing/router.ts";
import { approvalView, taskViews, toEventView } from "../views.ts";
import { TaskInputError, TaskRoutingError } from "./service.ts";

const Decision = z.object({ decision: z.enum(["approve", "reject"]) });

export async function taskRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  r.get(
    "/api/tasks",
    { schema: { querystring: z.object({ conversationId: z.string().optional() }) } },
    async (request) => {
      const actor = actorOf(request);
      const where = request.query.conversationId
        ? and(
            eq(schema.tasks.workspaceId, actor.workspaceId),
            eq(schema.tasks.conversationId, request.query.conversationId),
          )
        : eq(schema.tasks.workspaceId, actor.workspaceId);
      const rows = await ctx.db
        .select()
        .from(schema.tasks)
        .where(where)
        .orderBy(desc(schema.tasks.createdAt))
        .limit(100);
      return taskViews(ctx, rows);
    },
  );

  r.get(
    "/api/tasks/:id",
    { schema: { params: z.object({ id: z.string() }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      const [row] = await ctx.db
        .select()
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.id, request.params.id),
            eq(schema.tasks.workspaceId, actor.workspaceId),
          ),
        );
      if (!row) return reply.code(404).send({ error: "not found" });
      const [task] = await taskViews(ctx, [row]);
      const events = await ctx.db
        .select()
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.taskId, row.id))
        .orderBy(asc(schema.taskEvents.seq));
      return { task, events: events.map(toEventView) };
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

  r.get(
    "/api/approvals",
    { schema: { querystring: z.object({ state: z.string().default("pending") }) } },
    async (request) => {
      const actor = actorOf(request);
      const rows = await ctx.db
        .select({ id: schema.approvals.id })
        .from(schema.approvals)
        .where(
          and(
            eq(schema.approvals.workspaceId, actor.workspaceId),
            eq(schema.approvals.state, request.query.state as "pending"),
          ),
        )
        .orderBy(desc(schema.approvals.createdAt))
        .limit(100);
      const views = await Promise.all(rows.map((a) => approvalView(ctx, a.id)));
      return views.filter((v) => v !== null);
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
