import { schema } from "@sling/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { actorOf, requireActor } from "../http/session.ts";
import {
  createPersonality,
  fromTemplate,
  insertPersonality,
  listPersonalities,
  PersonalityFields,
  PersonalityPatch,
  type PersonalityRow,
  publishPersonality,
  toPersonalityView,
  updatePersonality,
  usablePersonality,
} from "./service.ts";
import { PERSONALITY_TEMPLATES, personalityTemplate } from "./templates.ts";

const Id = z.object({ id: z.string() });

export async function personalityRoutes(app: FastifyInstance, ctx: AppContext) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("preHandler", requireActor(ctx));

  const publish = (row: PersonalityRow) => publishPersonality(ctx, row);

  r.get("/api/personalities", async (request) => {
    const actor = actorOf(request);
    return (await listPersonalities(ctx.db, actor.workspaceId)).map(toPersonalityView);
  });

  r.get("/api/personalities/templates", async () => PERSONALITY_TEMPLATES);

  // Adds a ready-made personality. One that's already there comes back as it is.
  r.post(
    "/api/personalities/templates/:key",
    { schema: { params: z.object({ key: z.string() }) } },
    async (request, reply) => {
      const actor = actorOf(request);
      const t = personalityTemplate(request.params.key);
      if (!t) return reply.code(404).send({ error: "no such template" });
      const [existing] = await ctx.db
        .select()
        .from(schema.personalities)
        .where(
          and(
            eq(schema.personalities.workspaceId, actor.workspaceId),
            eq(schema.personalities.templateKey, t.key),
            isNull(schema.personalities.archivedAt),
          ),
        )
        .limit(1);
      if (existing) return toPersonalityView(existing);
      const row = await insertPersonality(ctx, actor, fromTemplate(t));
      await audit(ctx, {
        workspaceId: actor.workspaceId,
        actorType: "user",
        actorId: actor.userId,
        verb: "personality.created",
        subjectType: "personality",
        subjectId: row.id,
        details: { name: row.name, tools: row.tools, template: t.key },
      });
      publish(row);
      return toPersonalityView(row);
    },
  );

  r.post("/api/personalities", { schema: { body: PersonalityFields } }, async (request) => {
    const row = await createPersonality(ctx, actorOf(request), request.body);
    return toPersonalityView(row);
  });

  r.patch(
    "/api/personalities/:id",
    { schema: { params: Id, body: PersonalityPatch } },
    async (request, reply) => {
      const actor = actorOf(request);
      const row = await usablePersonality(ctx.db, actor.workspaceId, request.params.id);
      if (!row) return reply.code(404).send({ error: "not found" });
      const updated = await updatePersonality(ctx, actor, row, request.body);
      if (!updated) return reply.code(404).send({ error: "not found" });
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
