import type { SourceView } from "@sling/core";
import type { schema } from "@sling/db";

export type SourceRow = typeof schema.sources.$inferSelect;

export function toSourceView(row: SourceRow): SourceView {
  return {
    id: row.id,
    personalityId: row.personalityId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    kind: row.kind,
    name: row.name,
    mediaType: row.mediaType,
    size: row.size,
    url: row.url,
    state: row.state,
    error: row.error,
    pages: row.pages,
    chars: row.chars,
    createdAt: row.createdAt.toISOString(),
  };
}
