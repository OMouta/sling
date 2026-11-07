import {
  GLYPH_SHAPES,
  PERSONALITY_COLORS,
  PERSONALITY_DESCRIPTION_MAX,
  PERSONALITY_EXPORT_FORMAT,
  PERSONALITY_INSTRUCTIONS_MAX,
  PERSONALITY_MAX_SOURCES,
  PERSONALITY_NAME_MAX,
  PERSONALITY_TOOLS,
  type PersonalityExport,
  type PersonalityExportSource,
  type PersonalityImportView,
  SOURCE_MAX_BYTES,
} from "@sling/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { modelCatalog } from "../agent/catalog.ts";
import { AssistantChoiceSchema } from "../agent/chat-settings.ts";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { type Actor, actorOf, requireActor } from "../http/session.ts";
import {
  insertPersonality,
  type PersonalityRow,
  publishPersonality,
  toPersonalityView,
  usablePersonality,
} from "./service.ts";

/** Largest personality file accepted, its sources' files included. */
export const IMPORT_MAX_BYTES = 100 * 1024 * 1024;

/** Base64 of the largest source file, padding included. */
const SOURCE_MAX_BASE64 = Math.ceil(SOURCE_MAX_BYTES / 3) * 4;

const FileSource = z.object({
  kind: z.literal("file"),
  name: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().min(1).max(200),
  data: z.base64().max(SOURCE_MAX_BASE64, "The file is bigger than 25 MB."),
});

const LinkSource = z.object({
  kind: z.literal("link"),
  name: z.string().trim().max(255).default(""),
  url: z.url({ protocol: /^https?$/ }).max(2_000),
});

/**
 * A personality file as it's read. Tool groups this Sling doesn't know are
 * dropped, so a file from a newer one still imports.
 */
export const PersonalityFile = z.object({
  format: z.literal(PERSONALITY_EXPORT_FORMAT),
  name: z.string().trim().min(1).max(PERSONALITY_NAME_MAX),
  description: z.string().trim().max(PERSONALITY_DESCRIPTION_MAX).default(""),
  instructions: z.string().trim().min(1).max(PERSONALITY_INSTRUCTIONS_MAX),
  tools: z
    .array(z.string().max(40))
    .max(50)
    .default([])
    .transform((t) => PERSONALITY_TOOLS.filter((g) => t.includes(g))),
  color: z.enum(PERSONALITY_COLORS),
  shape: z.enum(GLYPH_SHAPES),
  assistant: AssistantChoiceSchema.nullable().default(null),
  sources: z
    .array(z.discriminatedUnion("kind", [FileSource, LinkSource]))
    .max(PERSONALITY_MAX_SOURCES)
    .default([]),
});
export type PersonalityFile = z.infer<typeof PersonalityFile>;

const NOT_A_PERSONALITY = "This file isn't a Sling personality.";

/** Reads an uploaded file, or says in words why it isn't one. */
export function readPersonalityFile(
  body: unknown,
): { ok: true; file: PersonalityFile } | { ok: false; error: string } {
  let data = body;
  if (Buffer.isBuffer(body)) {
    try {
      data = JSON.parse(body.toString("utf8"));
    } catch {
      return { ok: false, error: NOT_A_PERSONALITY };
    }
  }
  const format = (data as { format?: unknown } | null)?.format;
  if (typeof format !== "string" || !format.startsWith("sling.personality/")) {
    return { ok: false, error: NOT_A_PERSONALITY };
  }
  if (format !== PERSONALITY_EXPORT_FORMAT) {
    return { ok: false, error: "This personality file is from a newer Sling. Update Sling first." };
  }
  const parsed = PersonalityFile.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.map(String).join(".");
    return {
      ok: false,
      error: `This personality file has a problem: ${where ? `${where}: ` : ""}${issue?.message ?? "it doesn't match the format"}`,
    };
  }
  return { ok: true, file: parsed.data };
}

/** A personality as a file: its fields, its model, and its sources with their files. */
export async function exportPersonality(
  ctx: AppContext,
  row: PersonalityRow,
): Promise<PersonalityExport> {
  const sources: PersonalityExportSource[] = [];
  for (const s of await ctx.sources.forPersonality(row.workspaceId, row.id)) {
    if (s.kind === "link" && s.url) {
      sources.push({ kind: "link", name: s.name, url: s.url });
    } else if (s.kind === "file") {
      const f = await ctx.sources.file(row.workspaceId, s.id);
      if (!f) continue;
      sources.push({
        kind: "file",
        name: s.name,
        mediaType: s.mediaType,
        data: Buffer.from(f.data).toString("base64"),
      });
    }
  }
  return {
    format: PERSONALITY_EXPORT_FORMAT,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    tools: row.tools,
    color: row.color,
    shape: row.shape,
    assistant: row.assistant ?? null,
    sources,
  };
}

/**
 * Adds a personality from a file, last in the switcher, then its sources,
 * which process like any new source. A model this workspace can't run is
 * left out, so its chats start on the workspace default.
 */
export async function importPersonality(
  ctx: AppContext,
  actor: Pick<Actor, "workspaceId" | "userId">,
  file: PersonalityFile,
): Promise<PersonalityImportView> {
  let assistant = file.assistant;
  if (assistant) {
    const catalog = await modelCatalog(ctx, actor.workspaceId);
    const provider = catalog.assistant.find((p) => p.provider === assistant?.provider);
    if (!provider?.connected) assistant = null;
  }
  const row = await insertPersonality(ctx, actor, {
    name: file.name,
    description: file.description,
    instructions: file.instructions,
    tools: file.tools,
    color: file.color,
    shape: file.shape,
    assistant,
  });
  publishPersonality(ctx, row);
  let failed = 0;
  for (const s of file.sources) {
    try {
      if (s.kind === "file") {
        await ctx.sources.addFile(
          actor,
          { personalityId: row.id },
          { name: s.name, mediaType: s.mediaType, data: Buffer.from(s.data, "base64") },
        );
      } else {
        await ctx.sources.addLink(actor, row.id, s.url, s.name || undefined);
      }
    } catch (err) {
      failed++;
      ctx.log.warn({ err, personalityId: row.id, source: s.name }, "imported source not added");
    }
  }
  await audit(ctx, {
    workspaceId: actor.workspaceId,
    actorType: "user",
    actorId: actor.userId,
    verb: "personality.imported",
    subjectType: "personality",
    subjectId: row.id,
    details: {
      name: row.name,
      tools: row.tools,
      sources: file.sources.length - failed,
      ...(failed ? { sourcesFailed: failed } : {}),
    },
  });
  return { personality: toPersonalityView(row), sourcesFailed: failed };
}

/** A file name for the download, kept to characters every browser saves as they are. */
function fileName(name: string): string {
  return `${name.replace(/[^A-Za-z0-9 ._-]+/g, "-").trim() || "personality"}.sling-personality.json`;
}

export async function personalityTransferRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));
  // A file with its sources is bigger than JSON bodies may be, so it comes as raw bytes.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: IMPORT_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );
  app.setErrorHandler((err, _request, reply) => {
    if ((err as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({ error: "This file is bigger than 100 MB." });
    }
    return reply.send(err);
  });

  r.get(
    "/api/personalities/:id/export",
    { schema: { params: z.object({ id: z.string() }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      const row = await usablePersonality(ctx.db, actor.workspaceId, request.params.id);
      if (!row) return reply.code(404).send({ error: "not found" });
      const file = await exportPersonality(ctx, row);
      await audit(ctx, {
        workspaceId: actor.workspaceId,
        actorType: "user",
        actorId: actor.userId,
        verb: "personality.exported",
        subjectType: "personality",
        subjectId: row.id,
        details: { name: row.name, sources: file.sources.length },
      });
      const name = `${row.name}.sling-personality.json`;
      return reply
        .header("content-type", "application/json; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="${fileName(row.name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        )
        .send(JSON.stringify(file, null, 2));
    },
  );

  r.post(
    "/api/personalities/import",
    { bodyLimit: IMPORT_MAX_BYTES, schema: { body: z.unknown() } },
    async (request, reply) => {
      const read = readPersonalityFile(request.body);
      if (!read.ok) return reply.code(400).send({ error: read.error });
      return importPersonality(ctx, actorOf(request), read.file);
    },
  );
}
