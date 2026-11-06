import type { ConversationSummaryView } from "@sling/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

export const conversationsKey = ["conversations"] as const;

/** The conversation list, or the ones matching `q` in their title or messages. */
export function useConversations(q = "") {
  const query = q.trim();
  return useQuery({
    queryKey: query ? [...conversationsKey, { q: query }] : conversationsKey,
    queryFn: () =>
      api.get<ConversationSummaryView[]>(
        query ? `/api/conversations?q=${encodeURIComponent(query)}` : "/api/conversations",
      ),
    placeholderData: keepPreviousData,
  });
}

export type ConversationFilter = "all" | "working" | "waiting" | "tasks";

/** What a conversation is doing, for its row: the most urgent first. */
export function conversationStatus(
  c: ConversationSummaryView,
): "waiting" | "thinking" | "tasks" | null {
  if (c.waiting) return "waiting";
  if (c.agentStatus === "thinking") return "thinking";
  if (c.activeTasks > 0) return "tasks";
  return null;
}

export const FILTERS: Record<ConversationFilter, (c: ConversationSummaryView) => boolean> = {
  all: () => true,
  working: (c) => c.agentStatus === "thinking" || c.activeTasks > 0,
  waiting: (c) => c.waiting,
  tasks: (c) => c.taskCount > 0,
};

/** When something last happened in a conversation: its latest message. */
export function activityAt(c: ConversationSummaryView): string {
  return c.lastMessageAt ?? c.updatedAt;
}

export function byActivity(a: ConversationSummaryView, b: ConversationSummaryView): number {
  return activityAt(b).localeCompare(activityAt(a));
}

const DAY = 24 * 60 * 60 * 1000;

/** Groups conversations by their latest message, newest first, keeping their order. */
export function groupByDate(
  list: ConversationSummaryView[],
  now = new Date(),
): { label: string; items: ConversationSummaryView[] }[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const label = (iso: string) => {
    const t = new Date(iso).getTime();
    if (t >= today) return "Today";
    if (t >= today - DAY) return "Yesterday";
    if (t >= today - 7 * DAY) return "Previous 7 days";
    if (t >= today - 30 * DAY) return "Previous 30 days";
    return "Older";
  };
  const groups: { label: string; items: ConversationSummaryView[] }[] = [];
  for (const c of list) {
    const l = label(activityAt(c));
    const last = groups.at(-1);
    if (last?.label === l) last.items.push(c);
    else groups.push({ label: l, items: [c] });
  }
  return groups;
}

/** A message's text as a list shows it: one line, shortened. */
export function previewText(text: string, role: string): string {
  const line = role === "system" ? (text.split("\n")[0] ?? "") : text;
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}
