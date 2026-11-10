import type { ConversationFilter, ConversationPage, ConversationSummaryView } from "@sling/core";
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { api } from "./api.ts";

export type { ConversationFilter };

/** Every chat list in the cache starts with this. */
export const conversationsKey = ["conversations"] as const;

/** The most recent chats and the counts, for the sidebar and the command palette. */
export function useRecentConversations() {
  return useQuery({
    queryKey: conversationsKey,
    queryFn: ({ signal }) => api.get<ConversationPage>("/api/conversations", { signal }),
  });
}

/** One filtered, searched list of chats, a page at a time, newest activity first. */
export function useConversationList(q: string, filter: ConversationFilter) {
  const query = q.trim();
  return useInfiniteQuery({
    queryKey: [...conversationsKey, "list", { q: query, filter }],
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams({ filter });
      if (query) params.set("q", query);
      if (pageParam) params.set("cursor", pageParam);
      return api.get<ConversationPage>(`/api/conversations?${params}`, { signal });
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // While a search is typed, the last results stay up; another tab's don't.
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey[2] as { filter?: string } | undefined)?.filter === filter
        ? previous
        : undefined,
  });
}

type ListData = ConversationPage | InfiniteData<ConversationPage, string>;

function pagesOf(data: ListData): ConversationPage[] {
  const pages = "pages" in data ? data.pages : [data];
  return pages.every((p) => Array.isArray(p?.items)) ? pages : [];
}

function withPages(data: ListData, pages: ConversationPage[]): ListData {
  return "pages" in data ? { ...data, pages } : (pages[0] ?? data);
}

/**
 * Changes a chat wherever a cached list has it, or takes it out when `fn`
 * returns null. With `toTop`, it moves to the top of the first page, as a
 * new message does. Returns whether the recent list had it, since only the
 * server can say what goes in a list.
 */
export function patchListedConversation(
  qc: QueryClient,
  id: string,
  fn: (c: ConversationSummaryView) => ConversationSummaryView | null,
  toTop = false,
): boolean {
  let inRecent = false;
  for (const [key, data] of qc.getQueriesData<ListData>({ queryKey: conversationsKey })) {
    if (!data) continue;
    const pages = pagesOf(data).slice();
    let next: ConversationSummaryView | null | undefined;
    for (let p = 0; p < pages.length && next === undefined; p++) {
      const page = pages[p] as ConversationPage;
      const i = page.items.findIndex((c) => c.id === id);
      const current = page.items[i];
      if (!current) continue;
      next = fn(current);
      const items = page.items.slice();
      if (next && !toTop) items[i] = next;
      else items.splice(i, 1);
      pages[p] = { ...page, items };
    }
    if (next === undefined) continue;
    if (key.length === 1) inRecent = true;
    const first = pages[0];
    if (next && toTop && first) pages[0] = { ...first, items: [next, ...first.items] };
    qc.setQueryData<ListData>(key, withPages(data, pages));
  }
  return inRecent;
}

/** Takes a chat out of every cached list, as when it's archived or restored. */
export function dropListedConversation(qc: QueryClient, id: string) {
  patchListedConversation(qc, id, () => null);
}

/** What a conversation is doing, for its row: the most urgent first. */
export function conversationStatus(
  c: ConversationSummaryView,
): "waiting" | "thinking" | "tasks" | null {
  if (c.waiting) return "waiting";
  if (c.agentStatus === "thinking") return "thinking";
  if (c.activeTasks > 0) return "tasks";
  return null;
}

/** When something last happened in a conversation: its latest message. */
export function activityAt(c: ConversationSummaryView): string {
  return c.lastMessageAt ?? c.updatedAt;
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
