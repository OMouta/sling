import type { AgentChoice, AssistantChoice } from "@sling/core";
import { schema } from "@sling/db";
import { and, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { conversationPersonality, type PersonalityRow } from "../personalities/service.ts";
import { effectiveChat } from "./chat-settings.ts";

type ConversationRow = typeof schema.conversations.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;
type AgentSession = NonNullable<ConversationRow["agentSession"]>;
type Db = AppContext["db"];

/** Who answers a turn. */
export interface TurnPersonality {
  /** The personality this turn runs as: the one the latest user message mentions, else `own`. */
  row: PersonalityRow | null;
  /** The chat's own personality. */
  own: PersonalityRow | null;
}

/**
 * Picks who answers a turn. A user message that @mentions another
 * personality hands it that one turn; the message after it goes back to
 * the chat's own. An archived personality still answers a mention sent
 * before it was deleted.
 */
export async function turnPersonality(
  db: Db,
  conv: ConversationRow,
  rows: readonly MessageRow[],
): Promise<TurnPersonality> {
  const own = await conversationPersonality(db, conv);
  const id = rows.findLast((r) => r.role === "user")?.meta?.personalityId;
  if (!id || id === own?.id) return { row: own, own };
  const [mentioned] = await db
    .select()
    .from(schema.personalities)
    .where(
      and(eq(schema.personalities.id, id), eq(schema.personalities.workspaceId, conv.workspaceId)),
    );
  return { row: mentioned ?? own, own };
}

/**
 * The model a turn runs on: a mentioned personality's own model when it has
 * one, else the chat's (its own choice, its personality's, or the default).
 * `picked` is false when it's the workspace default.
 */
export async function turnChat(
  ctx: Pick<AppContext, "db">,
  conv: ConversationRow,
  turn: TurnPersonality,
): Promise<{ assistant: AssistantChoice | null; agent: AgentChoice; picked: boolean }> {
  const chat = await effectiveChat(ctx, conv.workspaceId, conv.id, turn.own);
  const mentioned = turn.row !== turn.own ? turn.row : null;
  if (mentioned?.assistant) return { ...chat, assistant: mentioned.assistant, picked: true };
  return { ...chat, picked: Boolean(conv.settings?.assistant || turn.own?.assistant) };
}

/**
 * The CLI session a turn may resume: only one that answered as the same
 * personality, since its instructions and tools are part of the session.
 * Sessions saved before mentions existed answered as the chat's own.
 */
export function turnSession(
  session: AgentSession | null | undefined,
  turn: TurnPersonality,
): AgentSession | null {
  if (!session) return null;
  const answeredAs = session.personalityId ?? turn.own?.id ?? null;
  return answeredAs === (turn.row?.id ?? null) ? session : null;
}

/**
 * Who wrote each reply, by message ID, for the history a new CLI session
 * reads. Null while only one personality answers in the chat, counting
 * this turn's: then every reply is just the assistant's.
 */
export async function replyLabels(
  db: Db,
  workspaceId: string,
  rows: readonly MessageRow[],
  answering: string | null,
): Promise<Map<string, string> | null> {
  const ids = new Set<string>();
  for (const r of rows) {
    const id = r.trace?.personality?.id;
    if (r.role === "assistant" && id) ids.add(id);
  }
  if (answering) ids.add(answering);
  if (ids.size < 2) return null;
  const named = await db
    .select({ id: schema.personalities.id, name: schema.personalities.name })
    .from(schema.personalities)
    .where(
      and(
        eq(schema.personalities.workspaceId, workspaceId),
        inArray(schema.personalities.id, [...ids]),
      ),
    );
  const names = new Map(named.map((p) => [p.id, p.name]));
  // A turn's earlier steps carry no trace; they belong to the reply that ends it.
  const labels = new Map<string, string>();
  let current: string | undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r) continue;
    if (r.role === "user" || r.role === "system") {
      current = undefined;
      continue;
    }
    const id = r.trace?.personality?.id;
    if (id) current = names.get(id);
    if (r.role === "assistant" && current) labels.set(r.id, current);
  }
  return labels;
}
