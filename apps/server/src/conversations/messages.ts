import type { MessageView } from "@sling/core";
import { schema } from "@sling/db";
import { and, eq, inArray } from "drizzle-orm";
import { toMessageView } from "../agent/history.ts";
import type { AppContext } from "../context.ts";
import { toSourceView } from "../sources/views.ts";
import { replaceable } from "./replace.ts";

type MessageRow = typeof schema.messages.$inferSelect;

/** What the chat shows for a conversation's messages, as `userId` sees them. */
export async function messageViews(
  ctx: AppContext,
  workspaceId: string,
  userId: string,
  rows: MessageRow[],
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
    replaceable(ctx, rows),
  ]);
  const ratings = new Map(feedback.map((f) => [f.messageId, f.rating]));
  for (const v of views) {
    v.attachments = files.filter((f) => f.messageId === v.id).map(toSourceView);
    v.feedback = ratings.get(v.id) ?? null;
    v.replaceable = replaceableIds.has(v.id);
  }
  return views;
}
