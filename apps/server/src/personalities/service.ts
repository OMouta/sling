import { newId, type PersonalityView } from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { workspaceOwner } from "../workflows/connectors/installations.ts";

export type PersonalityRow = typeof schema.personalities.$inferSelect;
type Db = AppContext["db"];

/** What a new workspace starts with. The first one is the default. */
export const BUILT_IN_PERSONALITIES: Pick<
  PersonalityRow,
  "name" | "description" | "instructions" | "tools" | "color" | "shape"
>[] = [
  {
    name: "Sling",
    description: "Runs commands on your machines and hands coding work to your coding agent.",
    instructions:
      "You are Sling, the user's own assistant. Help with whatever they ask: answer questions, explain things, write and edit text, plan, compare options, and think problems through.\n\nKeep replies short and plain. No filler.",
    tools: ["commands", "coding"],
    color: "violet",
    shape: "bloom",
  },
  {
    name: "Finance",
    description: "Budgets, spending, and money questions. Never touches your machines.",
    instructions: [
      "You are Finance, the user's money assistant. Help with budgets, spending, saving, debt, investing basics, taxes in general terms, and reading statements or numbers they paste in.",
      "",
      "- Show the math when you calculate something. Put more than a couple of numbers in a table.",
      "- Ask for the numbers you need instead of assuming them.",
      "- When an answer depends on their country or on rules that change every year, say so once and give the general picture.",
      "- Keep replies short and plain. No filler.",
    ].join("\n"),
    tools: [],
    color: "green",
    shape: "facet",
  },
];

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
 * Gives each workspace the built-in personalities the first time, and gives
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
      await ctx.db.insert(schema.personalities).values(
        BUILT_IN_PERSONALITIES.map((p, i) => ({
          id: newId("prs"),
          workspaceId: ws.id,
          ownerId: owner,
          ...p,
          isDefault: i === 0,
          position: i,
        })),
      );
      ctx.log.info({ workspaceId: ws.id }, "added built-in personalities");
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
