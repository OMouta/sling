import type { MessageView } from "@sling/core";
import { schema } from "@sling/db";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { toMessageView } from "../agent/history.ts";
import type { AppContext } from "../context.ts";
import { toSourceView } from "../sources/views.ts";
import { replaceable } from "./replace.ts";

type MessageRow = typeof schema.messages.$inferSelect;

/**
 * What the chat shows for a conversation's messages, as `userId` sees them.
 * Only the latest messages can hold the exchange Retry and Edit replace, so
 * an older page says `latest: false`.
 */
export async function messageViews(
  ctx: AppContext,
  workspaceId: string,
  userId: string,
  rows: MessageRow[],
  { latest = true }: { latest?: boolean } = {},
): Promise<MessageView[]> {
  const views = rows.map(toMessageView).filter((m) => m !== null);
  const users = views.filter((m) => m.role === "user").map((m) => m.id);
  const replies = views.filter((m) => m.role === "assistant").map((m) => m.id);
  const [files, feedback, replaceableIds] = await Promise.all([
    ctx.sources.forMessages(workspaceId, users),
    replies.length
      ? ctx.db
          .select({
            messageId: schema.messageFeedback.messageId,
            rating: schema.messageFeedback.rating,
          })
          .from(schema.messageFeedback)
          .where(
            and(
              eq(schema.messageFeedback.userId, userId),
              inArray(schema.messageFeedback.messageId, replies),
            ),
          )
      : [],
    latest ? replaceable(ctx, rows) : new Set<string>(),
  ]);
  const ratings = new Map(feedback.map((f) => [f.messageId, f.rating]));
  for (const v of views) {
    v.attachments = files.filter((f) => f.messageId === v.id).map(toSourceView);
    v.feedback = ratings.get(v.id) ?? null;
    v.replaceable = replaceableIds.has(v.id);
  }
  return views;
}

/**
 * A chat's latest activity, worked out again from its messages, for after
 * some were removed. Millisecond precision, like the times the app writes.
 */
export function lastMessageAt(conversationId: string): SQL<Date | null> {
  const m = schema.messages;
  return sql`(select date_trunc('milliseconds', max(${m.createdAt})) from ${m} where ${m.conversationId} = ${conversationId} and ${m.role} in ('user', 'assistant', 'system'))`;
}
