import {
  GLYPH_SHAPES,
  newId,
  PERSONALITY_COLORS,
  PERSONALITY_DESCRIPTION_MAX,
  PERSONALITY_INSTRUCTIONS_MAX,
  PERSONALITY_NAME_MAX,
  PERSONALITY_TOOLS,
  type PersonalityTemplateView,
  type PersonalityView,
} from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, eq, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { workspaceOwner } from "../workflows/connectors/installations.ts";
import { INSTALLED_TEMPLATES, personalityTemplate } from "./templates.ts";

export type PersonalityRow = typeof schema.personalities.$inferSelect;
type Db = AppContext["db"];

/** What a personality is made of, as the routes and the assistant's setup tools take it. */
export const PersonalityFields = z.object({
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
export type PersonalityFields = z.infer<typeof PersonalityFields>;
/** A change to some fields. Without its default, a description left out stays as it is. */
export const PersonalityPatch = PersonalityFields.extend({
  description: z.string().trim().max(PERSONALITY_DESCRIPTION_MAX),
}).partial();
export type PersonalityPatch = z.infer<typeof PersonalityPatch>;

interface Owner {
  workspaceId: string;
  userId: string;
}

export function publishPersonality(ctx: Pick<AppContext, "hub">, row: PersonalityRow) {
  ctx.hub.publish(row.workspaceId, {
    type: "personality.updated",
    personality: toPersonalityView(row),
  });
}

/** A new personality, last in the switcher. */
export async function insertPersonality(
  ctx: Pick<AppContext, "db">,
  actor: Owner,
  fields: PersonalityFields & { templateKey?: string },
): Promise<PersonalityRow> {
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
      ...fields,
      position: (last?.position ?? -1) + 1,
    })
    .returning();
  if (!row) throw new Error("insert failed");
  return row;
}

/** Adds a personality, audits it, and tells open pages. */
export async function createPersonality(
  ctx: AppContext,
  actor: Owner,
  /** A template's key marks one made from it, however it was changed on the way. */
  fields: PersonalityFields & { templateKey?: string },
): Promise<PersonalityRow> {
  const row = await insertPersonality(ctx, actor, fields);
  await audit(ctx, {
    workspaceId: actor.workspaceId,
    actorType: "user",
    actorId: actor.userId,
    verb: "personality.created",
    subjectType: "personality",
    subjectId: row.id,
    details: {
      name: row.name,
      tools: row.tools,
      ...(fields.templateKey ? { template: fields.templateKey } : {}),
    },
  });
  publishPersonality(ctx, row);
  return row;
}

/**
 * Changes a personality. A change to what the assistant is told or may do
 * bumps its revision, so later replies say which one wrote them.
 */
export async function updatePersonality(
  ctx: AppContext,
  actor: Owner,
  row: PersonalityRow,
  b: PersonalityPatch,
): Promise<PersonalityRow | null> {
  const changesPrompt =
    (b.name !== undefined && b.name !== row.name) ||
    (b.instructions !== undefined && b.instructions !== row.instructions) ||
    (b.tools !== undefined && b.tools.join() !== row.tools.join());
  const [updated] = await ctx.db
    .update(schema.personalities)
    .set({ ...b, ...(changesPrompt ? { revision: row.revision + 1 } : {}) })
    .where(eq(schema.personalities.id, row.id))
    .returning();
  if (!updated) return null;
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
  publishPersonality(ctx, updated);
  return updated;
}

/** The columns a personality made from a template starts with. */
export function fromTemplate(t: PersonalityTemplateView) {
  return {
    name: t.name,
    description: t.description,
    instructions: t.instructions,
    tools: t.tools,
    color: t.color,
    shape: t.shape,
    templateKey: t.key,
  };
}

export function toPersonalityView(row: PersonalityRow): PersonalityView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    tools: row.tools,
    color: row.color,
    shape: row.shape,
    isDefault: row.isDefault,
    position: row.position,
    revision: row.revision,
    templateKey: row.templateKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A workspace's personalities in order, without archived ones. */
export async function listPersonalities(db: Db, workspaceId: string): Promise<PersonalityRow[]> {
  return db
    .select()
    .from(schema.personalities)
    .where(
      and(
        eq(schema.personalities.workspaceId, workspaceId),
        isNull(schema.personalities.archivedAt),
      ),
    )
    .orderBy(asc(schema.personalities.position), asc(schema.personalities.createdAt));
}

export async function defaultPersonality(
  db: Db,
  workspaceId: string,
): Promise<PersonalityRow | null> {
  const [row] = await db
    .select()
    .from(schema.personalities)
    .where(
      and(
        eq(schema.personalities.workspaceId, workspaceId),
        eq(schema.personalities.isDefault, true),
        isNull(schema.personalities.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A personality a new chat may start with: in the workspace and not archived. */
export async function usablePersonality(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<PersonalityRow | null> {
  const [row] = await db
    .select()
    .from(schema.personalities)
    .where(
      and(
        eq(schema.personalities.id, id),
        eq(schema.personalities.workspaceId, workspaceId),
        isNull(schema.personalities.archivedAt),
      ),
    );
  return row ?? null;
}

/**
 * The personality that answers in a conversation. An archived one still
 * answers the chats it started; a conversation without one gets the default.
 */
export async function conversationPersonality(
  db: Db,
  conv: { workspaceId: string; personalityId: string | null },
): Promise<PersonalityRow | null> {
  if (conv.personalityId) {
    const [row] = await db
      .select()
      .from(schema.personalities)
      .where(
        and(
          eq(schema.personalities.id, conv.personalityId),
          eq(schema.personalities.workspaceId, conv.workspaceId),
        ),
      );
    if (row) return row;
  }
  return defaultPersonality(db, conv.workspaceId);
}

/**
 * Gives each workspace the installed personalities the first time, and gives
 * conversations that have none the default, so a later change of default
 * doesn't change who answers in them.
 */
export async function ensurePersonalities(
  ctx: Pick<AppContext, "db" | "log">,
  workspaceId?: string,
): Promise<void> {
  const workspaces = workspaceId
    ? [{ id: workspaceId }]
    : await ctx.db.select({ id: schema.workspaces.id }).from(schema.workspaces);
  for (const ws of workspaces) {
    const [any] = await ctx.db
      .select({ id: schema.personalities.id })
      .from(schema.personalities)
      .where(eq(schema.personalities.workspaceId, ws.id))
      .limit(1);
    if (!any) {
      const owner = await workspaceOwner(ctx, ws.id);
      if (!owner) continue;
      const installed = INSTALLED_TEMPLATES.map(personalityTemplate).filter((t) => t !== undefined);
      await ctx.db.insert(schema.personalities).values(
        installed.map((t, i) => ({
          ...fromTemplate(t),
          id: newId("prs"),
          workspaceId: ws.id,
          ownerId: owner,
          isDefault: i === 0,
          position: i,
        })),
      );
      ctx.log.info({ workspaceId: ws.id }, "added the installed personalities");
    }
    const def = await defaultPersonality(ctx.db, ws.id);
    if (!def) continue;
    await ctx.db
      .update(schema.conversations)
      // Not activity, so the conversation keeps its place in the list.
      .set({ personalityId: def.id, updatedAt: sql`${schema.conversations.updatedAt}` })
      .where(
        and(
          eq(schema.conversations.workspaceId, ws.id),
          isNull(schema.conversations.personalityId),
        ),
      );
  }
}
