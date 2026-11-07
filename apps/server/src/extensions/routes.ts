import { EXTENSION_ID_PATTERN, EXTENSION_KINDS } from "@sling/connector-sdk";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import { MAX_PACKAGE_BYTES } from "./catalogs.ts";
import { ExtensionError } from "./errors.ts";

const Id = z.object({ id: z.string().min(1).max(100) });
const CatalogRef = z.object({
  catalogId: z.string().min(1).max(100),
  extensionId: z.string().min(1).max(40),
  version: z.string().min(1).max(60),
});
/** Icons can't run script or load anything, even opened on their own. */
const ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ExtensionError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

export async function extensionRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));
  // Uploaded packages arrive as raw bytes.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_PACKAGE_BYTES },
    (_req, body, done) => done(null, body),
  );
  const ext = ctx.extensions;

  r.get("/api/extensions", async (request) => ext.list(actorOf(request).workspaceId));

  r.get(
    "/api/extensions/discover",
    {
      schema: {
        querystring: z.object({
          q: z.string().max(200).optional(),
          kind: z.enum(EXTENSION_KINDS).optional(),
        }),
      },
    },
    async (request) => ext.discover(request.query),
  );

  r.get("/api/extensions/:id", { schema: { params: Id } }, async (request, reply) => {
    const view = await ext.detail(actorOf(request).workspaceId, request.params.id);
    if (!view) return reply.code(404).send({ error: "not found" });
    return view;
  });

  r.get("/api/extensions/:id/icon", { schema: { params: Id } }, async (request, reply) => {
    const icon = ext.icon(request.params.id);
    const etag = `"${ext.digestOf(request.params.id) ?? ""}"`;
    if (!icon) return reply.code(404).send({ error: "not found" });
    reply
      .header("content-security-policy", ICON_CSP)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-cache")
      .header("etag", etag);
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    return reply.header("content-type", icon.type).send(Buffer.from(icon.bytes));
  });

  r.post(
    "/api/extensions/preview",
    { bodyLimit: MAX_PACKAGE_BYTES, schema: { body: z.unknown() } },
    async (request, reply) => {
      const actor = actorOf(request);
      try {
        if (Buffer.isBuffer(request.body)) {
          const bytes = new Uint8Array(request.body);
          return await ext.preview(actor, { bytes });
        }
        const ref = CatalogRef.safeParse(request.body);
        if (!ref.success) {
          return reply.code(400).send({
            error: "Send a package file, or { catalogId, extensionId, version }.",
          });
        }
        return await ext.preview(actor, ref.data);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  r.post(
    "/api/extensions/install",
    {
      schema: {
        body: z
          .object({
            stagingId: z.string().min(1).max(100),
            digest: z.string().min(1).max(100),
            /** The preview's `permissionsKey`. */
            permissions: z.string().max(100).optional(),
            permissionsKey: z.string().max(100).optional(),
            trustPublisher: z.boolean().default(false),
          })
          .refine((b) => b.permissions !== undefined || b.permissionsKey !== undefined, {
            message: "permissions is required",
          }),
      },
    },
    async (request, reply) => {
      const b = request.body;
      try {
        return await ext.install(actorOf(request), {
          stagingId: b.stagingId,
          digest: b.digest,
          permissions: b.permissions ?? b.permissionsKey ?? "",
          trustPublisher: b.trustPublisher,
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  r.post(
    "/api/extensions/:id/update/preview",
    {
      schema: {
        params: Id,
        body: z
          .object({ version: z.string().min(1).max(60).optional() })
          .nullish()
          .transform((b) => b ?? {}),
      },
    },
    async (request, reply) => {
      try {
        return await ext.previewUpdate(actorOf(request), request.params.id, request.body.version);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  r.patch(
    "/api/extensions/:id",
    { schema: { params: Id, body: z.object({ enabled: z.boolean() }) } },
    async (request, reply) => {
      try {
        return await ext.setEnabled(actorOf(request), request.params.id, request.body.enabled);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  r.delete("/api/extensions/:id", { schema: { params: Id } }, async (request, reply) => {
    try {
      await ext.remove(actorOf(request), request.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ------------------------------------------------------------- catalogs

  r.get("/api/extension-catalogs", async () => ext.listCatalogs());

  r.post(
    "/api/extension-catalogs",
    { schema: { body: z.object({ url: z.string().trim().min(1).max(2000) }) } },
    async (request, reply) => {
      try {
        return await ext.addCatalog(actorOf(request), request.body.url);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  r.post(
    "/api/extension-catalogs/preview",
    { schema: { body: z.object({ url: z.string().trim().min(1).max(2000) }) } },
    async (request, reply) => {
      try {
        return await ext.previewCatalog(actorOf(request), request.body.url);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  r.post(
    "/api/extension-catalogs/:id/refresh",
    { schema: { params: Id } },
    async (request, reply) => {
      try {
        return await ext.refreshCatalog(actorOf(request), request.params.id);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  r.delete("/api/extension-catalogs/:id", { schema: { params: Id } }, async (request, reply) => {
    try {
      await ext.removeCatalog(actorOf(request), request.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ------------------------------------------------------------- publishers

  r.get("/api/extension-publishers", async () => ext.listPublishers());

  r.delete(
    "/api/extension-publishers/:keyId",
    { schema: { params: z.object({ keyId: z.string().regex(/^[0-9a-f]{16}$/) }) } },
    async (request, reply) => {
      try {
        await ext.removePublisher(actorOf(request), request.params.keyId);
        return { ok: true };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // ------------------------------------------------------------- workflow packages

  r.post(
    "/api/workflows/:id/export-package",
    {
      schema: {
        params: Id,
        body: z.object({
          id: z.string().regex(EXTENSION_ID_PATTERN, "must be 3 to 40 characters: a-z, 0-9, -"),
          version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "must look like 1.0.0"),
          name: z.string().trim().min(1).max(80),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const wf = await ctx.workflows.get(actor.workspaceId, request.params.id);
      if (!wf) return reply.code(404).send({ error: "not found" });
      try {
        const out = await ext.exportWorkflow(actor, wf, request.body);
        return reply
          .header("content-type", "application/octet-stream")
          .header("content-disposition", `attachment; filename="${out.filename}"`)
          .send(Buffer.from(out.bytes));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
