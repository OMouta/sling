import type { FeedbackItemView, FeedbackRating, FeedbackSummaryView } from "@sling/core";
import { schema } from "@sling/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { textOf } from "../agent/history.ts";
import type { AppContext } from "../context.ts";
import { conversationPersonality, type PersonalityRow } from "../personalities/service.ts";

export const FEEDBACK_REASON_MAX = 500;
/** Downvotes the personality's page lists. */
const RECENT_DOWNVOTES = 10;
const EXCERPT_CHARS = 160;

export const FeedbackInput = z.object({
  rating: z.enum(["up", "down"]),
  reason: z.string().trim().max(FEEDBACK_REASON_MAX).optional(),
});
export type FeedbackInput = z.infer<typeof FeedbackInput>;

interface Viewer {
  workspaceId: string;
  userId: string;
}

/** The start of a message's text, on one line, without Markdown's marks or code. */
export function excerpt(content: unknown, chars = EXCERPT_CHARS): string {
  const flat = textOf((content as { content?: unknown })?.content)
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, "")
    .replace(/\*\*|__|`|~~/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
}

/**
 * A reply the viewer may rate: an assistant reply in a chat they own. Null
 * when there's none, "forbidden" when it's someone else's chat.
 */
async function ratable(ctx: AppContext, viewer: Viewer, messageId: string) {
  const [row] = await ctx.db
    .select({ message: schema.messages, conversation: schema.conversations })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
    .where(
      and(
        eq(schema.messages.id, messageId),
        eq(schema.messages.workspaceId, viewer.workspaceId),
        eq(schema.messages.role, "assistant"),
      ),
    );
  if (!row) return null;
  if (row.conversation.ownerId !== viewer.userId) return "forbidden" as const;
  return row;
}

/**
 * Thumbs up or down on a reply, with a reason on down. It counts for the
 * personality that wrote the reply, at the revision it had then, or for
 * the chat's personality when the reply doesn't say.
 */
export async function rateReply(
  ctx: AppContext,
  viewer: Viewer,
  messageId: string,
  input: FeedbackInput,
): Promise<{ rating: FeedbackRating; reason: string } | null | "forbidden"> {
  const found = await ratable(ctx, viewer, messageId);
  if (!found || found === "forbidden") return found;
  const { message, conversation } = found;
  let personality: { id: string; revision: number } | null = message.trace?.personality ?? null;
  if (!personality) {
    const row: PersonalityRow | null = await conversationPersonality(ctx.db, conversation);
    personality = row ? { id: row.id, revision: row.revision } : null;
  }
  const reason = input.rating === "down" ? (input.reason ?? "") : "";
  const values = {
    personalityId: personality?.id ?? null,
    revision: personality?.revision ?? 1,
    rating: input.rating,
    reason,
  };
  await ctx.db
    .insert(schema.messageFeedback)
    .values({
      messageId: message.id,
      userId: viewer.userId,
      workspaceId: viewer.workspaceId,
      conversationId: conversation.id,
      ...values,
    })
    .onConflictDoUpdate({
      target: [schema.messageFeedback.messageId, schema.messageFeedback.userId],
      set: { ...values, updatedAt: new Date() },
    });
  return { rating: input.rating, reason };
}

/** Takes the viewer's thumbs off a reply. */
export async function clearRating(
  ctx: AppContext,
  viewer: Viewer,
  messageId: string,
): Promise<boolean | "forbidden"> {
  const found = await ratable(ctx, viewer, messageId);
  if (!found || found === "forbidden") return found ?? false;
  await ctx.db
    .delete(schema.messageFeedback)
    .where(
      and(
        eq(schema.messageFeedback.messageId, messageId),
        eq(schema.messageFeedback.userId, viewer.userId),
      ),
    );
  return true;
}

/** The counts for a personality's current revision, and its latest downvotes. */
export async function feedbackSummary(
  ctx: AppContext,
  personality: PersonalityRow,
): Promise<FeedbackSummaryView> {
  const f = schema.messageFeedback;
  const mine = and(eq(f.workspaceId, personality.workspaceId), eq(f.personalityId, personality.id));
  const [[counts], recent] = await Promise.all([
    ctx.db
      .select({
        up: sql<number>`(count(*) filter (where ${f.rating} = 'up'))::int`,
        down: sql<number>`(count(*) filter (where ${f.rating} = 'down'))::int`,
      })
      .from(f)
      .where(and(mine, eq(f.revision, personality.revision))),
    ctx.db
      .select({
        messageId: f.messageId,
        conversationId: f.conversationId,
        conversationTitle: schema.conversations.title,
        rating: f.rating,
        reason: f.reason,
        content: schema.messages.content,
        revision: f.revision,
        at: f.updatedAt,
      })
      .from(f)
      .innerJoin(schema.messages, eq(f.messageId, schema.messages.id))
      .innerJoin(schema.conversations, eq(f.conversationId, schema.conversations.id))
      .where(and(mine, eq(f.rating, "down")))
      .orderBy(desc(f.updatedAt))
      .limit(RECENT_DOWNVOTES),
  ]);
  return {
    revision: personality.revision,
    up: counts?.up ?? 0,
    down: counts?.down ?? 0,
    recent: recent.map(
      (r): FeedbackItemView => ({
        messageId: r.messageId,
        conversationId: r.conversationId,
        conversationTitle: r.conversationTitle,
        rating: r.rating,
        reason: r.reason,
        excerpt: excerpt(r.content),
        revision: r.revision,
        createdAt: r.at.toISOString(),
      }),
    ),
  };
}
