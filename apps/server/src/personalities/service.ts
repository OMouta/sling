import { newId, type PersonalityTemplateView, type PersonalityView } from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { workspaceOwner } from "../workflows/connectors/installations.ts";
import { INSTALLED_TEMPLATES, personalityTemplate } from "./templates.ts";

export type PersonalityRow = typeof schema.personalities.$inferSelect;
type Db = AppContext["db"];

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
