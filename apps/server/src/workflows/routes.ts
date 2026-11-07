import type { RunDetailView } from "@sling/core";
import { schema } from "@sling/db";
import { parseDefinition, type WorkflowDefinition } from "@sling/workflow";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { WorkflowInputError } from "./service.ts";
import { webhookTrigger } from "./triggers.ts";
import { type RunRow, toNodeRunView, toRunView } from "./views.ts";

const Id = z.object({ id: z.string() });

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof WorkflowInputError) {
    return reply.code(err.status).send({ error: err.message, issues: err.issues });
  }
  throw err;
}

export async function runView(ctx: AppContext, run: RunRow) {
  const version = await ctx.engine.version(run.versionId);
  const [wf] = await ctx.db
    .select({ name: schema.workflows.name })
    .from(schema.workflows)
    .where(eq(schema.workflows.id, run.workflowId));
  return toRunView(run, wf?.name ?? "", version?.number ?? 0);
}

export async function workflowRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));
  const wfs = ctx.workflows;

  async function load(
    request: { params: { id: string } },
    workspaceId: string,
    reply: FastifyReply,
  ) {
    const wf = await wfs.get(workspaceId, request.params.id);
    if (!wf) reply.code(404).send({ error: "not found" });
    return wf;
  }

  function definitionOr400(raw: unknown, reply: FastifyReply): WorkflowDefinition | null {
    const parsed = parseDefinition(raw);
    if (parsed.ok) return parsed.definition;
    reply
      .code(400)
      .send({ error: "That isn't a valid workflow definition.", issues: parsed.issues });
    return null;
  }

  r.get("/api/workflow-nodes", async () => ctx.registry.catalog());

  r.get("/api/templates", async () => wfs.availableTemplates());

  r.get("/api/workflows", async (request) => wfs.list(actorOf(request).workspaceId));

  r.post(
    "/api/workflows",
    {
      schema: {
        body: z.object({
          templateKey: z.string().optional(),
          bindings: z.record(z.string(), z.string()).default({}),
          name: z.string().trim().min(1).max(120).optional(),
          description: z.string().max(2000).optional(),
          definition: z.unknown().optional(),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = request.body;
      try {
        if (body.templateKey) {
          const row = await wfs.install(actor, body.templateKey, body.bindings, {
            ...(body.name ? { name: body.name } : {}),
          });
          return wfs.detail(row);
        }
        let definition: WorkflowDefinition | undefined;
        if (body.definition !== undefined) {
          const d = definitionOr400(body.definition, reply);
          if (!d) return reply;
          definition = d;
        }
        const row = await wfs.create(actor, {
          ...(definition ? { definition } : {}),
          ...(body.name ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
        });
        return wfs.detail(row);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  r.post("/api/workflows/import", { schema: { body: z.unknown() } }, async (request, reply) => {
    const actor = actorOf(request);
    const definition = definitionOr400(request.body, reply);
    if (!definition) return reply;
    const row = await wfs.create(actor, { definition });
    return wfs.detail(row);
  });

  r.get("/api/workflows/:id", { schema: { params: Id } }, async (request, reply) => {
    const wf = await load(request, actorOf(request).workspaceId, reply);
    if (!wf) return reply;
    return wfs.detail(wf);
  });

  r.put(
    "/api/workflows/:id/draft",
    { schema: { params: Id, body: z.unknown() } },
    async (request, reply) => {
      const wf = await load(request, actorOf(request).workspaceId, reply);
      if (!wf) return reply;
      const definition = definitionOr400(request.body, reply);
      if (!definition) return reply;
      return wfs.detail(await wfs.saveDraft(wf, definition));
    },
  );

  r.post("/api/workflows/:id/validate", { schema: { params: Id } }, async (request, reply) => {
    const wf = await load(request, actorOf(request).workspaceId, reply);
    if (!wf) return reply;
    return { issues: wfs.validateDraft(wf) };
  });

  r.post(
    "/api/workflows/:id/publish",
    {
      schema: {
        params: Id,
        body: z.object({ note: z.string().max(500).default("") }).default({ note: "" }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const wf = await load(request, actor.workspaceId, reply);
      if (!wf) return reply;
      const result = await wfs.publish(actor, wf, request.body.note);
      return reply.code(result.ok ? 200 : 422).send(result);
    },
  );

  r.patch(
    "/api/workflows/:id",
    {
      schema: {
        params: Id,
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          description: z.string().max(2000).optional(),
          enabled: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const wf = await load(request, actor.workspaceId, reply);
      if (!wf) return reply;
      try {
        return wfs.detail(await wfs.update(actor, wf, request.body));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  r.delete("/api/workflows/:id", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const wf = await load(request, actor.workspaceId, reply);
    if (!wf) return reply;
    try {
      await wfs.remove(actor, wf);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  r.get("/api/workflows/:id/versions", { schema: { params: Id } }, async (request, reply) => {
    const wf = await load(request, actorOf(request).workspaceId, reply);
    if (!wf) return reply;
    return wfs.versions(wf);
  });

  r.get(
    "/api/workflows/:id/versions/:n",
    { schema: { params: z.object({ id: z.string(), n: z.coerce.number().int().positive() }) } },
    async (request, reply) => {
      const wf = await load(request, actorOf(request).workspaceId, reply);
      if (!wf) return reply;
      const v = await wfs.version(wf, request.params.n);
      if (!v) return reply.code(404).send({ error: "not found" });
      return v;
    },
  );

  r.get(
    "/api/workflows/:id/export",
    {
      schema: {
        params: Id,
        querystring: z.object({ version: z.coerce.number().int().positive().optional() }),
      },
    },
    async (request, reply) => {
      const wf = await load(request, actorOf(request).workspaceId, reply);
      if (!wf) return reply;
      let definition: WorkflowDefinition;
      if (request.query.version) {
        const v = await wfs.version(wf, request.query.version);
        if (!v) return reply.code(404).send({ error: "not found" });
        definition = v.definition;
      } else {
        const detail = await wfs.detail(wf);
        definition = detail.active ?? detail.draft;
      }
      const file = `${wf.name.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase() || "workflow"}.json`;
      return reply.header("content-disposition", `attachment; filename="${file}"`).send(definition);
    },
  );

  r.post(
    "/api/workflows/:id/run",
    {
      schema: {
        params: Id,
        body: z
          .object({ input: z.unknown().optional(), nodeId: z.string().optional() })
          .default({}),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const wf = await load(request, actor.workspaceId, reply);
      if (!wf) return reply;
      if (!wf.activeVersionId) return reply.code(409).send({ error: "Publish a version first." });
      const version = await ctx.engine.version(wf.activeVersionId);
      const manual = version?.definition.nodes.filter((n) => n.type === "core.manual") ?? [];
      const node = request.body.nodeId
        ? manual.find((n) => n.id === request.body.nodeId)
        : manual[0];
      if (!version || !node) {
        return reply.code(409).send({ error: "The active version has no Manual run trigger." });
      }
      const run = await ctx.engine.startRun({
        workflowId: wf.id,
        workspaceId: wf.workspaceId,
        ownerId: wf.ownerId,
        versionId: version.id,
        triggerNodeId: node.id,
        outputs: { input: request.body.input ?? null },
      });
      if (!run) return reply.code(409).send({ error: "The run didn't start." });
      return runView(ctx, run);
    },
  );

  r.get(
    "/api/workflows/:id/runs",
    {
      schema: {
        params: Id,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.iso.datetime().optional(),
        }),
      },
    },
    async (request, reply) => {
      const wf = await load(request, actorOf(request).workspaceId, reply);
      if (!wf) return reply;
      const rows = await ctx.db
        .select()
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.workflowId, wf.id),
            request.query.before
              ? lt(schema.workflowRuns.createdAt, new Date(request.query.before))
              : undefined,
          ),
        )
        .orderBy(desc(schema.workflowRuns.createdAt))
        .limit(request.query.limit);
      return Promise.all(rows.map((row) => runView(ctx, row)));
    },
  );

  async function ownedRun(workspaceId: string, id: string) {
    const [run] = await ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.id, id), eq(schema.workflowRuns.workspaceId, workspaceId)));
    return run ?? null;
  }

  r.get(
    "/api/runs/:id",
    { schema: { params: Id } },
    async (request, reply): Promise<RunDetailView> => {
      const run = await ownedRun(actorOf(request).workspaceId, request.params.id);
      if (!run) return reply.code(404).send({ error: "not found" });
      const nodeRuns = await ctx.db
        .select()
        .from(schema.nodeRuns)
        .where(eq(schema.nodeRuns.runId, run.id))
        .orderBy(asc(schema.nodeRuns.startedAt), asc(schema.nodeRuns.id));
      return { run: await runView(ctx, run), nodeRuns: nodeRuns.map(toNodeRunView) };
    },
  );

  r.post("/api/runs/:id/cancel", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const run = await ctx.engine.cancel(actor.workspaceId, request.params.id);
    if (!run) return reply.code(404).send({ error: "not found" });
    return runView(ctx, run);
  });

  r.post("/api/runs/:id/retry", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const run = await ctx.engine.retry(actor.workspaceId, request.params.id);
    if (!run) return reply.code(404).send({ error: "not found" });
    return runView(ctx, run);
  });
}

const DROPPED_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);

/** `POST /hooks/:token`. No session: the token in the URL is the credential. */
export async function webhookRoutes(app: FastifyInstance, ctx: AppContext) {
  // Webhook senders use all sorts of content types. Anything that isn't JSON arrives as text.
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  app.post<{ Params: { token: string } }>("/hooks/:token", async (request, reply) => {
    const found = await webhookTrigger(ctx, request.params.token);
    if (!found) return reply.code(404).send({ error: "not found" });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (!DROPPED_HEADERS.has(k) && typeof v === "string") headers[k] = v;
    }
    const run = await ctx.engine.startRun({
      workflowId: found.workflow.id,
      workspaceId: found.workflow.workspaceId,
      ownerId: found.workflow.ownerId,
      versionId: found.trigger.versionId,
      triggerNodeId: found.trigger.nodeId,
      outputs: {
        body: request.body ?? null,
        headers,
        query: (request.query ?? {}) as Record<string, unknown>,
      },
    });
    if (!run) return reply.code(409).send({ error: "duplicate" });
    return reply.code(202).send({ runId: run.id });
  });
}
