import type { MessageView } from "@sling/core";
import type { schema } from "@sling/db";
import type { ModelMessage } from "ai";

type MessageRow = typeof schema.messages.$inferSelect;

/** How many stored messages go back to the model each turn. */
export const HISTORY_LIMIT = 40;

/** Prefix for notes the server adds when a task changes. */
export const UPDATE_PREFIX = "[Sling update]";

/** The text parts of a message's content, joined. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" && p !== null && (p as { type?: string }).type === "text",
    )
    .map((p) => p.text)
    .join("");
}

/** Rebuilds the model's view of a conversation from stored rows. */
export function toModelMessages(rows: MessageRow[]): ModelMessage[] {
  const recent = rows.slice(-HISTORY_LIMIT);
  const out: ModelMessage[] = [];
  for (const row of recent) {
    const msg = row.content as ModelMessage;
    if (row.role === "system") {
      // Notes are shown to the model as user-side context, clearly marked.
      out.push({ role: "user", content: `${UPDATE_PREFIX} ${textOf(msg.content)}` });
    } else {
      out.push(msg);
    }
  }
  // Never start on a tool result whose call was trimmed away.
  while (out.length > 0 && out[0]?.role !== "user") out.shift();
  return out;
}

/** What the chat UI shows for a stored message, or null to hide it. */
export function toMessageView(row: MessageRow): MessageView | null {
  if (row.role === "tool") return null;
  const msg = row.content as ModelMessage;
  const text = textOf(msg.content).trim();
  if (!text) return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role === "system" ? "system" : row.role,
    text,
    taskIds: row.taskId ? [row.taskId] : [],
    createdAt: row.createdAt.toISOString(),
    trace: row.trace ?? null,
  };
}
