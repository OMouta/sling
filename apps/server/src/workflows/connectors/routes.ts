import type { SetupResult } from "@sling/connector-sdk";
import type { ConnectorView } from "@sling/core";
import { schema } from "@sling/db";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../../audit.ts";
import type { AppContext } from "../../context.ts";
import { actorOf, requireActor } from "../../http/session.ts";
import { withSignIn } from "../../oauth/credentials.ts";
import { signInView } from "../../oauth/providers.ts";
import { liveSandboxCount } from "../../sandboxes/routes.ts";
import { toJsonSchema } from "../registry.ts";
import { toInstallationView } from "../views.ts";
import { readCredentials } from "./installations.ts";
import {
  connectorLog,
  createInstallation,
  InstallationError,
  ownedInstallation,
  testConnection,
  updateInstallation,
} from "./manage.ts";
import { runSetup } from "./setup.ts";

const Id = z.object({ id: z.string() });

/** Fields typed into the form. Blank ones mean "keep what's stored". */
function nonEmpty(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== "" && v !== undefined && v !== null),
  );
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof InstallationError) {
    return reply
      .code(err.status)
      .send({ error: err.message, ...(err.check ? { check: err.check } : {}) });
  }
  throw err;
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
            hasSource: c.source !== undefined,
            hasSetup: c.setup !== undefined,
            extension: null,
            signIn: signInView(c),
          },
      ),
  );

  const owned = (workspaceId: string, id: string) => ownedInstallation(ctx, workspaceId, id);

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
          /** Defaults to the connector's name, numbered when it's taken. */
          name: z.string().trim().min(1).max(120).optional(),
          credentials: z.record(z.string(), z.unknown()).default({}),
          config: z.record(z.string(), z.unknown()).default({}),
          enabled: z.boolean().default(true),
          /** Runs the connection test first, and saves nothing if it fails. */
          check: z.boolean().default(false),
        }),
      },
    },
    async (request, reply) => {
      try {
        return await createInstallation(ctx, actorOf(request), request.body);
      } catch (err) {
        return sendError(reply, err);
      }
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
          /** Runs the connection test on the new credentials or config, and saves nothing if it fails. */
          check: z.boolean().default(false),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const row = await owned(actor.workspaceId, request.params.id);
      if (!row) return reply.code(404).send({ error: "not found" });
      try {
        return await updateInstallation(ctx, actor, row, request.body);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  r.post("/api/installations/:id/test", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await owned(actor.workspaceId, request.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    const connector = ctx.registry.connector(row.connectorId);
    if (!connector) return { ok: false, error: `Connector ${row.connectorId} isn't available` };
    try {
      const config = connector.configSchema.parse(row.config);
      const stored = await withSignIn(ctx, row, await readCredentials(ctx, row));
      const credentials = connector.credentialsSchema.parse(stored);
      return await testConnection(ctx, connector, credentials, config, {
        workspaceId: row.workspaceId,
        installationId: row.id,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  r.post(
    "/api/connectors/:id/setup",
    {
      schema: {
        params: Id,
        body: z.object({
          credentials: z.record(z.string(), z.unknown()).default({}),
          config: z.record(z.string(), z.unknown()).default({}),
          /** Editing: the stored credentials fill whatever wasn't typed again. */
          installationId: z.string().optional(),
        }),
      },
    },
    async (request, reply): Promise<SetupResult | undefined> => {
      const actor = actorOf(request);
      const connector = ctx.registry.connector(request.params.id);
      if (!connector) return reply.code(404).send({ error: "not found" });
      const body = request.body;
      let credentials = body.credentials;
      let stored = false;
      if (body.installationId) {
        const row = await owned(actor.workspaceId, body.installationId);
        if (!row || row.connectorId !== connector.id)
          return reply.code(404).send({ error: "not found" });
        credentials = { ...(await readCredentials(ctx, row)), ...nonEmpty(body.credentials) };
        stored = true;
      }
      const result = await runSetup(connector, {
        credentials: await withSignIn(
          ctx,
          {
            ...(stored ? { id: body.installationId } : {}),
            workspaceId: actor.workspaceId,
            connectorId: connector.id,
            config: body.config,
          },
          credentials,
        ),
        config: body.config,
        log: connectorLog(ctx, connector.id, body.installationId),
        workspaceId: actor.workspaceId,
      });
      // Credentials are write-only: a lookup may suggest new ones, never echo a secret or a stored value.
      if (result.credentials) {
        const out = Object.fromEntries(
          Object.entries(result.credentials).filter(
            ([k, v]) => !connector.secretFields.includes(k) && !(stored && credentials[k] === v),
          ),
        );
        if (stored || Object.keys(out).length === 0) delete result.credentials;
        else result.credentials = out;
      }
      return result;
    },
  );

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
