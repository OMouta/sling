import type { ConnectorView } from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../../audit.ts";
import type { AppContext } from "../../context.ts";
import { actorOf, requireActor } from "../../http/session.ts";
import { liveSandboxCount } from "../../sandboxes/routes.ts";
import { toJsonSchema } from "../registry.ts";
import { toInstallationView } from "../views.ts";
import { readCredentials, writeCredentials } from "./installations.ts";

const Id = z.object({ id: z.string() });
const TEST_TIMEOUT_MS = 30_000;

function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "value"}: ${i.message}`)
    .join("; ");
}

export async function connectorRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  r.get(
    "/api/connectors",
    async (): Promise<ConnectorView[]> =>
      ctx.registry.connectors().map(
        (c) =>
          // Extension connectors use the schemas they described at install.
          ctx.extensions.connectorView(c.id) ?? {
            id: c.id,
            name: c.name,
            description: c.description,
            setupHelp: c.setupHelp ?? null,
            credentialsSchema: toJsonSchema(c.credentialsSchema),
            secretFields: c.secretFields,
            configSchema: toJsonSchema(c.configSchema),
            nodeTypes: c.nodes.map((n) => n.type),
            isExecutionProvider: c.executionProvider !== undefined,
            extension: null,
          },
      ),
  );

  async function owned(workspaceId: string, id: string) {
    const [row] = await ctx.db
      .select()
      .from(schema.connectorInstallations)
      .where(
        and(
          eq(schema.connectorInstallations.id, id),
          eq(schema.connectorInstallations.workspaceId, workspaceId),
        ),
      );
    return row ?? null;
  }

  function publish(row: typeof schema.connectorInstallations.$inferSelect) {
    const view = toInstallationView(row);
    ctx.hub.publish(row.workspaceId, { type: "installation.updated", installation: view });
    return view;
  }

  r.get("/api/installations", async (request) => {
    const actor = actorOf(request);
    const rows = await ctx.db
      .select()
      .from(schema.connectorInstallations)
      .where(eq(schema.connectorInstallations.workspaceId, actor.workspaceId))
      .orderBy(asc(schema.connectorInstallations.createdAt));
    return rows.map(toInstallationView);
  });

  r.post(
    "/api/installations",
    {
      schema: {
        body: z.object({
          connectorId: z.string().min(1),
          name: z.string().trim().min(1).max(120),
          credentials: z.record(z.string(), z.unknown()).default({}),
          config: z.record(z.string(), z.unknown()).default({}),
          enabled: z.boolean().default(true),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = request.body;
      const connector = ctx.registry.connector(body.connectorId);
      if (!connector)
        return reply.code(400).send({ error: `Unknown connector ${body.connectorId}` });
      const creds = connector.credentialsSchema.safeParse(body.credentials);
      if (!creds.success)
        return reply.code(400).send({ error: `Credentials: ${issuesOf(creds.error)}` });
      const config = connector.configSchema.safeParse(body.config);
      if (!config.success)
        return reply.code(400).send({ error: `Config: ${issuesOf(config.error)}` });
      const id = newId("ins");
      const row = await ctx.db.transaction(async (tx) => {
        const credentialId = await writeCredentials(
          ctx,
          tx,
          { workspaceId: actor.workspaceId, ownerId: actor.userId },
          null,
          creds.data as Record<string, unknown>,
        );
        const [created] = await tx
          .insert(schema.connectorInstallations)
          .values({
            id,
            workspaceId: actor.workspaceId,
            ownerId: actor.userId,
            connectorId: connector.id,
            name: body.name,
            credentialId,
            config: config.data as Record<string, unknown>,
            enabled: body.enabled,
            status: body.enabled ? "idle" : "disabled",
          })
          .returning();
        return created;
      });
      if (!row) throw new Error("insert failed");
      await audit(ctx, {
        workspaceId: actor.workspaceId,
        actorType: "user",
        actorId: actor.userId,
        verb: "installation.created",
        subjectType: "installation",
        subjectId: id,
        details: { connectorId: connector.id, name: body.name },
      });
      // Before the source starts, so it may already reach the host in its config.
      await ctx.extensions.installationsChanged(connector.id);
      await ctx.connectors.reconcile(actor.workspaceId);
      const fresh = (await owned(actor.workspaceId, id)) ?? row;
      return publish(fresh);
    },
  );

  r.patch(
    "/api/installations/:id",
    {
      schema: {
        params: Id,
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          /** Merged over the stored credentials. Never returned. */
          credentials: z.record(z.string(), z.unknown()).optional(),
          config: z.record(z.string(), z.unknown()).optional(),
          enabled: z.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const row = await owned(actor.workspaceId, request.params.id);
      if (!row) return reply.code(404).send({ error: "not found" });
      const connector = ctx.registry.connector(row.connectorId);
      if (!connector)
        return reply.code(409).send({ error: `Connector ${row.connectorId} isn't available` });
      const body = request.body;
      let creds: Record<string, unknown> | null = null;
      if (body.credentials) {
        const merged = { ...(await readCredentials(ctx, row)), ...body.credentials };
        const parsed = connector.credentialsSchema.safeParse(merged);
        if (!parsed.success)
          return reply.code(400).send({ error: `Credentials: ${issuesOf(parsed.error)}` });
        creds = parsed.data as Record<string, unknown>;
      }
      let config: Record<string, unknown> | null = null;
      if (body.config) {
        const parsed = connector.configSchema.safeParse(body.config);
        if (!parsed.success)
          return reply.code(400).send({ error: `Config: ${issuesOf(parsed.error)}` });
        config = parsed.data as Record<string, unknown>;
      }
      await ctx.db.transaction(async (tx) => {
        const credentialId = creds
          ? await writeCredentials(
              ctx,
              tx,
              { workspaceId: row.workspaceId, ownerId: row.ownerId },
              row.credentialId,
              creds,
            )
          : row.credentialId;
        await tx
          .update(schema.connectorInstallations)
          .set({
            ...(body.name ? { name: body.name } : {}),
            ...(config ? { config } : {}),
            ...(body.enabled !== undefined
              ? { enabled: body.enabled, status: body.enabled ? "idle" : "disabled" }
              : {}),
            credentialId,
          })
          .where(eq(schema.connectorInstallations.id, row.id));
      });
      await audit(ctx, {
        workspaceId: actor.workspaceId,
        actorType: "user",
        actorId: actor.userId,
        verb: "installation.updated",
        subjectType: "installation",
        subjectId: row.id,
        details: {
          fields: Object.keys(body).filter((k) => k !== "credentials"),
          credentialsChanged: Boolean(creds),
        },
      });
      if (config) await ctx.extensions.installationsChanged(row.connectorId);
      // New credentials or config only take effect in a fresh source.
      if (creds || config || body.enabled !== undefined) await ctx.connectors.restart(row.id);
      const fresh = await owned(actor.workspaceId, row.id);
      if (!fresh) return reply.code(404).send({ error: "not found" });
      return publish(fresh);
    },
  );

  r.post("/api/installations/:id/test", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await owned(actor.workspaceId, request.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const connector = ctx.registry.connector(row.connectorId);
    if (!connector) return { ok: false, error: `Connector ${row.connectorId} isn't available` };
    const log = ctx.log.child({ installationId: row.id, connector: connector.id });
    try {
      const config = connector.configSchema.parse(row.config);
      const credentials = connector.credentialsSchema.parse(await readCredentials(ctx, row));
      return await connector.test({
        credentials,
        config,
        log: {
          info: (m, d) => log.info(d ?? {}, m),
          warn: (m, d) => log.warn(d ?? {}, m),
          error: (m, d) => log.error(d ?? {}, m),
        },
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  r.delete("/api/installations/:id", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await owned(actor.workspaceId, request.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const live = await liveSandboxCount(ctx, row.id);
    if (live > 0) {
      return reply.code(409).send({
        error: `${row.name} still has ${live} ${live === 1 ? "sandbox" : "sandboxes"}. Destroy ${live === 1 ? "it" : "them"} on the Sandboxes page first.`,
      });
    }
    await ctx.db.transaction(async (tx) => {
      await tx
        .delete(schema.connectorInstallations)
        .where(eq(schema.connectorInstallations.id, row.id));
      if (row.credentialId) {
        await tx.delete(schema.credentials).where(eq(schema.credentials.id, row.credentialId));
      }
    });
    await ctx.connectors.reconcile(actor.workspaceId);
    await ctx.extensions.installationsChanged(row.connectorId);
    await audit(ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "installation.deleted",
      subjectType: "installation",
      subjectId: row.id,
      details: { connectorId: row.connectorId, name: row.name },
    });
    return { ok: true };
  });
}
