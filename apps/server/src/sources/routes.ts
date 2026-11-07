import { SOURCE_MAX_BYTES } from "@sling/core";
import { schema } from "@sling/db";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { type Actor, actorOf, requireActor } from "../http/session.ts";
import { DOCX, HTML, PDF } from "./kinds.ts";
import { SourceInputError } from "./service.ts";
import { type SourceRow, toSourceView } from "./views.ts";

const Id = z.object({ id: z.string().min(1).max(64) });
const Name = z.object({ name: z.string().trim().min(1).max(200) });
/** Text and images can't run script or load anything, even opened on their own. */
const FILE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
const MB = 1024 * 1024;

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof SourceInputError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

/** A file's name for Content-Disposition, safe in a header. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Whether the viewer may open a source: a personality's or a chat's in their
 * workspace, or an upload of their own that isn't sent yet.
 */
function visible(row: SourceRow, actor: Actor): boolean {
  if (row.workspaceId !== actor.workspaceId) return false;
  return Boolean(row.personalityId || row.conversationId || row.ownerId === actor.userId);
}

/** Text kinds whose original reads fine as plain text. */
function plainOriginal(mediaType: string): boolean {
  return (mediaType.startsWith("text/") && mediaType !== HTML) || mediaType === "application/json";
}

export async function sourceRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));
  // Uploads arrive as the file's raw bytes.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: SOURCE_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );
  app.setErrorHandler((err: { code?: string; statusCode?: number }, _request, reply) => {
    if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: `Files are at most ${SOURCE_MAX_BYTES / MB} MB.` });
    }
    throw err;
  });

  const personality = async (actor: Actor, id: string) => {
    const [p] = await ctx.db
      .select({ id: schema.personalities.id })
      .from(schema.personalities)
      .where(
        and(
          eq(schema.personalities.id, id),
          eq(schema.personalities.workspaceId, actor.workspaceId),
          isNull(schema.personalities.archivedAt),
        ),
      );
    return p ?? null;
  };
  const source = async (actor: Actor, id: string) => {
    const [row] = await ctx.db.select().from(schema.sources).where(eq(schema.sources.id, id));
    return row && visible(row, actor) ? row : null;
  };
  const bytesOf = (body: unknown): Uint8Array | null =>
    Buffer.isBuffer(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : null;
  const notBytes = (reply: FastifyReply) =>
    reply.code(415).send({ error: "Send the file's bytes as application/octet-stream." });

  r.get("/api/personalities/:id/sources", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    if (!(await personality(actor, request.params.id))) {
      return reply.code(404).send({ error: "not found" });
    }
    const rows = await ctx.sources.forPersonality(actor.workspaceId, request.params.id);
    return rows.map(toSourceView);
  });

  r.post(
    "/api/personalities/:id/sources",
    {
      bodyLimit: SOURCE_MAX_BYTES,
      schema: { params: Id, querystring: Name, body: z.unknown() },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const data = bytesOf(request.body);
      if (!data) return notBytes(reply);
      try {
        const row = await ctx.sources.addFile(
          actor,
          { personalityId: request.params.id },
          { name: request.query.name, mediaType: "application/octet-stream", data },
        );
        return toSourceView(row);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  r.post(
    "/api/personalities/:id/sources/link",
    {
      schema: {
        params: Id,
        body: z.object({
          url: z.string().trim().min(1).max(2_000),
          name: z.string().trim().max(200).optional(),
        }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      try {
        const row = await ctx.sources.addLink(
          actor,
          request.params.id,
          request.body.url,
          request.body.name || undefined,
        );
        return toSourceView(row);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  r.post(
    "/api/attachments",
    { bodyLimit: SOURCE_MAX_BYTES, schema: { querystring: Name, body: z.unknown() } },
    async (request, reply) => {
      const actor = actorOf(request);
      const data = bytesOf(request.body);
      if (!data) return notBytes(reply);
      try {
        const row = await ctx.sources.addFile(
          actor,
          { attachment: true },
          { name: request.query.name, mediaType: "application/octet-stream", data },
        );
        return toSourceView(row);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  r.delete("/api/sources/:id", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await source(actor, request.params.id);
    // A file sent in a chat goes with its message; only its uploader removes it.
    if (!row || (!row.personalityId && row.ownerId !== actor.userId)) {
      return reply.code(404).send({ error: "not found" });
    }
    await ctx.sources.remove(actor.workspaceId, row.id, actor.userId);
    return reply.code(204).send();
  });

  r.get("/api/sources/:id/file", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await source(actor, request.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    if (row.kind === "link" && row.url) return reply.redirect(row.url);
    const f = await ctx.sources.file(actor.workspaceId, row.id);
    if (!f) return reply.code(404).send({ error: "not found" });
    reply
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=3600");
    // Stored HTML and every other text kind go out as plain text, never as a page.
    let type = row.mediaType;
    let how: "inline" | "attachment" = "inline";
    if (row.kind === "image") {
      reply.header("content-security-policy", FILE_CSP);
    } else if (row.mediaType === DOCX) {
      how = "attachment";
    } else if (row.mediaType !== PDF) {
      type = "text/plain; charset=utf-8";
      reply.header("content-security-policy", FILE_CSP);
    }
    return reply
      .header("content-type", type)
      .header("content-disposition", disposition(how, row.name))
      .send(Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength));
  });

  r.get(
    "/api/sources/:id/view",
    {
      schema: {
        params: Id,
        querystring: z.object({ page: z.coerce.number().int().min(1).max(100_000).optional() }),
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const row = await source(actor, request.params.id);
      if (!row) return reply.code(404).send({ error: "not found" });
      const page = request.query.page;
      const at = page && row.mediaType === PDF ? `#page=${page}` : "";
      if (row.kind === "link" && row.url) return reply.redirect(`${row.url}${at}`);
      if (row.mediaType === PDF || row.kind === "image" || plainOriginal(row.mediaType)) {
        return reply.redirect(`/api/sources/${row.id}/file${at}`);
      }
      // A Word file or a web page reads as the text Sling took from it.
      const text = (await ctx.sources.texts([row.id])).get(row.id) ?? "";
      return reply
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", FILE_CSP)
        .header("content-type", "text/plain; charset=utf-8")
        .send(text);
    },
  );
}
