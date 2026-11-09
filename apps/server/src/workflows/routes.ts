import { createHash } from "node:crypto";
import type { RunDetailView } from "@sling/core";
import { schema } from "@sling/db";
import {
  type DraftConflictView,
  parseDefinition,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from "@sling/workflow";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { AdmissionLimit, validWebhookSignature } from "../http/webhook-security.ts";
import { RunBudgetError } from "./engine.ts";
import { webhookConfig } from "./nodes/triggers.ts";
import { DraftConflictError, WorkflowInputError } from "./service.ts";
import { webhookTrigger } from "./triggers.ts";
import { type RunRow, toNodeRunView, toRunView } from "./views.ts";
import { acceptedSecrets, rotateSigningSecret, signingStatus } from "./webhook-secrets.ts";

const Id = z.object({ id: z.string() });

const DraftSave = z.object({
  definition: z.unknown(),
  revision: z.number().int().nonnegative(),
});

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof DraftConflictError) {
    const body: DraftConflictView = {
      error: err.message,
      conflict: {
        revision: err.current.draftRevision,
        draft: WorkflowDefinitionSchema.parse(err.current.draft),
        updatedAt: err.current.updatedAt.toISOString(),
      },
    };
    return reply.code(409).send(body);
  }
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

  // The body is `{ definition, revision }`, which saves only over that
  // revision, or a bare definition, which saves over whatever is there.
  r.put(
    "/api/workflows/:id/draft",
    { schema: { params: Id, body: z.unknown() } },
    async (request, reply) => {
      const wf = await load(request, actorOf(request).workspaceId, reply);
      if (!wf) return reply;
      const conditional = DraftSave.safeParse(request.body);
      const definition = definitionOr400(
        conditional.success ? conditional.data.definition : request.body,
        reply,
      );
      if (!definition) return reply;
      try {
        const row = await wfs.saveDraft(
          wf,
          definition,
          conditional.success ? { revision: conditional.data.revision } : {},
        );
        return wfs.detail(row);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  r.post("/api/workflows/:id/validate", { schema: { params: Id } }, async (request, reply) => {
    const wf = await load(request, actorOf(request).workspaceId, reply);
    if (!wf) return reply;
    return { issues: await wfs.validateDraft(wf) };
  });

  r.post(
    "/api/workflows/:id/publish",
    {
      schema: {
        params: Id,
        body: z
          .object({
            note: z.string().max(500).default(""),
            /** The draft revision the publisher reviewed. A newer draft gets a 409. */
            revision: z.number().int().nonnegative().optional(),
          })
          .default({ note: "" }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const wf = await load(request, actor.workspaceId, reply);
      if (!wf) return reply;
      try {
        const { note, revision } = request.body;
        const result = await wfs.publish(
          actor,
          wf,
          note,
          revision === undefined ? {} : { revision },
        );
        return reply.code(result.ok ? 200 : 422).send(result);
      } catch (err) {
        return sendError(reply, err);
      }
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

  // A webhook trigger's signing secret, in the draft or the active version.
  const HookParams = z.object({ id: z.string(), nodeId: z.string().min(1).max(200) });
  async function webhookNode(wf: NonNullable<Awaited<ReturnType<typeof load>>>, nodeId: string) {
    const draft = parseDefinition(wf.draft);
    const active = wf.activeVersionId ? await ctx.engine.version(wf.activeVersionId) : null;
    const nodes = [
      ...(draft.ok ? draft.definition.nodes : []),
      ...(active?.definition.nodes ?? []),
    ];
    return nodes.some((n) => n.id === nodeId && n.type === "core.webhook");
  }

  r.get(
    "/api/workflows/:id/webhooks/:nodeId/secret",
    { schema: { params: HookParams } },
    async (request, reply) => {
      const wf = await load(request, actorOf(request).workspaceId, reply);
      if (!wf) return reply;
      if (!(await webhookNode(wf, request.params.nodeId))) {
        return reply.code(404).send({ error: "No webhook trigger with that ID." });
      }
      return { signing: await signingStatus(ctx, wf.id, request.params.nodeId) };
    },
  );

  r.post(
    "/api/workflows/:id/webhooks/:nodeId/secret",
    { schema: { params: HookParams } },
    async (request, reply) => {
      const actor = actorOf(request);
      const wf = await load(request, actor.workspaceId, reply);
      if (!wf) return reply;
      if (!(await webhookNode(wf, request.params.nodeId))) {
        return reply.code(404).send({ error: "No webhook trigger with that ID." });
      }
      return rotateSigningSecret(ctx, actor, wf.id, request.params.nodeId);
    },
  );

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
  const rawBodies = new WeakMap<object, Buffer>();
  const limit = new AdmissionLimit();
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (req, raw, done) => {
    const bytes = raw as Buffer;
    rawBodies.set(req, bytes);
    const text = bytes.toString("utf8");
    try {
      const type = req.headers["content-type"]?.split(";")[0]?.trim();
      done(
        null,
        type === "application/json"
          ? JSON.parse(text)
          : type === "application/x-www-form-urlencoded"
            ? Object.fromEntries(new URLSearchParams(text))
            : text,
      );
    } catch {
      done(Object.assign(new Error("Invalid webhook JSON"), { statusCode: 400 }));
    }
  });
  const tooMany = (reply: FastifyReply, error: string) =>
    reply.header("retry-after", "60").code(429).send({ error });
  app.post<{ Params: { token: string } }>("/hooks/:token", async (request, reply) => {
    // Senders that retry on 503 deliver again once automation resumes.
    if (ctx.config.automationPaused) {
      return reply
        .header("retry-after", "300")
        .code(503)
        .send({ error: "Automation is paused on this server" });
    }
    if (!limit.take(`ip:${request.ip}`, (ctx.config.webhookRequestsPerMinute ?? 60) * 2)) {
      return tooMany(reply, "Webhook rate limit exceeded");
    }
    const found = await webhookTrigger(ctx, request.params.token);
    if (!found) return reply.code(404).send({ error: "not found" });
    // The trigger's settings as published. Ones from before it had settings get the defaults.
    const parsed = webhookConfig.safeParse(found.trigger.config ?? {});
    const config = parsed.success ? parsed.data : webhookConfig.parse({});

    // A signed trigger checks its own secrets; any other falls back to the server's, if set.
    const raw = rawBodies.get(request) ?? Buffer.alloc(0);
    const timestamp = String(request.headers["x-sling-timestamp"] ?? "");
    const signature = String(request.headers["x-sling-signature"] ?? "");
    const secrets =
      config.auth === "signed"
        ? await acceptedSecrets(ctx, found.workflow.id, found.trigger.nodeId)
        : ctx.config.webhookSecret
          ? [ctx.config.webhookSecret]
          : null;
    if (secrets && !secrets.some((key) => validWebhookSignature(key, timestamp, signature, raw))) {
      return reply.code(401).send({ error: "Invalid webhook signature" });
    }

    if (
      !limit.take(
        `workspace:${found.workflow.workspaceId}`,
        ctx.config.webhookRequestsPerMinute ?? 60,
      )
    ) {
      return tooMany(reply, "Webhook rate limit exceeded");
    }
    const eventId = config.eventIdHeader
      ? request.headers[config.eventIdHeader.toLowerCase()]
      : undefined;
    if (eventId !== undefined && (typeof eventId !== "string" || eventId.length > 200)) {
      return reply.code(400).send({ error: "Invalid webhook event ID" });
    }
    // Without an event ID, a signed request is told apart by its timestamp and body, so
    // replaying one within its five minutes starts nothing.
    const dedupe =
      eventId ||
      (secrets ? createHash("sha256").update(timestamp).update(raw).digest("hex") : null);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (!DROPPED_HEADERS.has(k) && typeof v === "string") headers[k] = v;
    }
    let run: Awaited<ReturnType<typeof ctx.engine.startRun>>;
    try {
      run = await ctx.engine.startRun({
        workflowId: found.workflow.id,
        workspaceId: found.workflow.workspaceId,
        ownerId: found.workflow.ownerId,
        versionId: found.trigger.versionId,
        triggerNodeId: found.trigger.nodeId,
        dedupeKey: dedupe ? `hook:${found.trigger.nodeId}:${dedupe}` : null,
        maxActiveRuns: config.maxConcurrentRuns,
        outputs: {
          body: request.body ?? null,
          headers,
          query: (request.query ?? {}) as Record<string, unknown>,
        },
      });
    } catch (err) {
      if (err instanceof RunBudgetError) return tooMany(reply, err.message);
      throw err;
    }
    if (!run) return reply.code(409).send({ error: "duplicate" });
    return reply.code(202).send({ runId: run.id });
  });
}
