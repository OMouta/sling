import {
  GLYPH_SHAPES,
  newId,
  PERSONALITY_COLORS,
  PERSONALITY_DESCRIPTION_MAX,
  PERSONALITY_INSTRUCTIONS_MAX,
  PERSONALITY_NAME_MAX,
  PERSONALITY_TOOLS,
} from "@sling/core";
import { schema } from "@sling/db";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import {
  listPersonalities,
  type PersonalityRow,
  toPersonalityView,
  usablePersonality,
} from "./service.ts";

const Id = z.object({ id: z.string() });

const Fields = z.object({
  name: z.string().trim().min(1).max(PERSONALITY_NAME_MAX),
  description: z.string().trim().max(PERSONALITY_DESCRIPTION_MAX).default(""),
  instructions: z.string().trim().min(1).max(PERSONALITY_INSTRUCTIONS_MAX),
  tools: z
    .array(z.enum(PERSONALITY_TOOLS))
    .max(PERSONALITY_TOOLS.length)
    .transform((t) => PERSONALITY_TOOLS.filter((g) => t.includes(g))),
  color: z.enum(PERSONALITY_COLORS),
  shape: z.enum(GLYPH_SHAPES),
});

export async function personalityRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  const publish = (row: PersonalityRow) =>
    ctx.hub.publish(row.workspaceId, {
      type: "personality.updated",
      personality: toPersonalityView(row),
    });

  r.get("/api/personalities", async (request) => {
    const actor = actorOf(request);
    return (await listPersonalities(ctx.db, actor.workspaceId)).map(toPersonalityView);
  });

  r.post("/api/personalities", { schema: { body: Fields } }, async (request) => {
    const actor = actorOf(request);
    const [last] = await ctx.db
      .select({ position: max(schema.personalities.position) })
      .from(schema.personalities)
      .where(eq(schema.personalities.workspaceId, actor.workspaceId));
    const [row] = await ctx.db
      .insert(schema.personalities)
      .values({
        id: newId("prs"),
        workspaceId: actor.workspaceId,
        ownerId: actor.userId,
        ...request.body,
        position: (last?.position ?? -1) + 1,
      })
      .returning();
    if (!row) throw new Error("insert failed");
    await audit(ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "personality.created",
      subjectType: "personality",
      subjectId: row.id,
      details: { name: row.name, tools: row.tools },
    });
    publish(row);
    return toPersonalityView(row);
  });

  r.patch(
    "/api/personalities/:id",
    { schema: { params: Id, body: Fields.partial() } },
    async (request, reply) => {
      const actor = actorOf(request);
      const row = await usablePersonality(ctx.db, actor.workspaceId, request.params.id);
      if (!row) return reply.code(404).send({ error: "not found" });
      const b = request.body;
      // What the assistant is told or may do changed, so later replies say so.
      const changesPrompt =
        (b.name !== undefined && b.name !== row.name) ||
        (b.instructions !== undefined && b.instructions !== row.instructions) ||
        (b.tools !== undefined && b.tools.join() !== row.tools.join());
      const [updated] = await ctx.db
        .update(schema.personalities)
        .set({ ...b, ...(changesPrompt ? { revision: row.revision + 1 } : {}) })
        .where(eq(schema.personalities.id, row.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: "not found" });
      if (changesPrompt) {
        await audit(ctx, {
          workspaceId: actor.workspaceId,
          actorType: "user",
          actorId: actor.userId,
          verb: "personality.updated",
          subjectType: "personality",
          subjectId: row.id,
          details: {
            revision: updated.revision,
            ...(b.tools !== undefined && b.tools.join() !== row.tools.join()
              ? { tools: { from: row.tools, to: updated.tools } }
              : {}),
          },
        });
      }
      publish(updated);
      return toPersonalityView(updated);
    },
  );

  r.post("/api/personalities/:id/default", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await usablePersonality(ctx.db, actor.workspaceId, request.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    if (row.isDefault) return toPersonalityView(row);
    const changed = await ctx.db.transaction(async (tx) => {
      const old = await tx
        .update(schema.personalities)
        .set({ isDefault: false })
        .where(
          and(
            eq(schema.personalities.workspaceId, actor.workspaceId),
            eq(schema.personalities.isDefault, true),
          ),
        )
        .returning();
      const now = await tx
        .update(schema.personalities)
        .set({ isDefault: true })
        .where(eq(schema.personalities.id, row.id))
        .returning();
      return [...old, ...now];
    });
    await audit(ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "personality.made_default",
      subjectType: "personality",
      subjectId: row.id,
      details: { name: row.name },
    });
    for (const c of changed) publish(c);
    const now = changed.find((c) => c.id === row.id);
    return toPersonalityView(now ?? row);
  });

  // The order of the switcher: every personality's ID, first to last.
  r.put(
    "/api/personalities/order",
    { schema: { body: z.object({ ids: z.array(z.string()).max(500) }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      const rows = await listPersonalities(ctx.db, actor.workspaceId);
      const ids = request.body.ids;
      const known = new Set(rows.map((p) => p.id));
      if (
        ids.length !== rows.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !known.has(id))
      ) {
        return reply.code(400).send({ error: "List every personality exactly once." });
      }
      await ctx.db.transaction(async (tx) => {
        for (const [i, id] of ids.entries()) {
          await tx
            .update(schema.personalities)
            // Order isn't an edit, so updatedAt stays.
            .set({ position: i, updatedAt: sql`${schema.personalities.updatedAt}` })
            .where(eq(schema.personalities.id, id));
        }
      });
      const after = await listPersonalities(ctx.db, actor.workspaceId);
      for (const p of after) publish(p);
      return after.map(toPersonalityView);
    },
  );

  // Archived, not deleted: chats that started with it keep it.
  r.delete("/api/personalities/:id", { schema: { params: Id } }, async (request, reply) => {
    const actor = actorOf(request);
    const row = await usablePersonality(ctx.db, actor.workspaceId, request.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    if (row.isDefault) {
      return reply
        .code(409)
        .send({ error: "This is the default personality. Make another one the default first." });
    }
    await ctx.db
      .update(schema.personalities)
      .set({ archivedAt: new Date() })
      .where(and(eq(schema.personalities.id, row.id), isNull(schema.personalities.archivedAt)));
    await audit(ctx, {
      workspaceId: actor.workspaceId,
      actorType: "user",
      actorId: actor.userId,
      verb: "personality.deleted",
      subjectType: "personality",
      subjectId: row.id,
      details: { name: row.name },
    });
    ctx.hub.publish(actor.workspaceId, { type: "personality.removed", id: row.id });
    return { ok: true };
  });
}
