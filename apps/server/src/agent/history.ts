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

function hasToolCall(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((p) => typeof p === "object" && p !== null && p.type === "tool-call")
  );
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
  // A model step that called tools is part of the reply that follows it, and
  // shows in that reply's trace. The last message of a turn always has a trace.
  if (row.role === "assistant" && !row.trace && hasToolCall(msg.content)) return null;
  const text = textOf(msg.content).trim();
  if (!text) return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role === "system" ? "system" : row.role,
    text,
    taskIds: row.taskId ? [row.taskId] : [],
    createdAt: row.createdAt.toISOString(),
    trace: row.trace?.steps.length || hasExtras(row.trace) ? (row.trace ?? null) : null,
    attachments: [],
    personalityId: row.meta?.personalityId ?? null,
    research: row.meta?.research ?? false,
    feedback: null,
    replaceable: false,
  };
}

/** A reply with no steps still has a trace worth showing when it cites sources or suggests follow-ups. */
function hasExtras(trace: MessageRow["trace"]): boolean {
  return Boolean(trace?.sources?.length || trace?.followUps?.length);
}
