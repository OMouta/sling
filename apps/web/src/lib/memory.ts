import type { MemoryInput, MemoryPatch, MemoryView, ReplyTrace } from "@sling/core";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import type { ConversationDetail } from "./types.ts";

export const memoriesKey = ["memories"] as const;

/** The server lists at most this many. A search there reaches the rest. */
export const MEMORY_LIST_MAX = 2_000;

export function useMemories() {
  return useQuery({
    queryKey: memoriesKey,
    queryFn: ({ signal }) => api.get<MemoryView[]>("/api/memories", { signal }),
  });
}

/** The server's search, for when the list it sent was cut short. */
export function useMemorySearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: [...memoriesKey, q],
    queryFn: ({ signal }) =>
      api.get<MemoryView[]>(`/api/memories?q=${encodeURIComponent(q)}`, { signal }),
    enabled: enabled && q.length > 0,
    placeholderData: (prev) => prev,
  });
}

export const memoryApi = {
  add: (input: MemoryInput) => api.post<MemoryView>("/api/memories", input),
  update: (id: string, patch: MemoryPatch) => api.patch<MemoryView>(`/api/memories/${id}`, patch),
  remove: (id: string) => api.del<{ ok: true }>(`/api/memories/${id}`),
};

/** Every word, anywhere in the text, as the server's search for the page matches. */
export function matchesMemory(m: MemoryView, q: string): boolean {
  const text = m.text.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w));
}

function markUndone(trace: ReplyTrace, id: string): ReplyTrace | null {
  let changed = false;
  const steps = trace.steps.map((s) => {
    if (s.kind !== "tool" || s.memory?.id !== id || s.memory.undone) return s;
    changed = true;
    return { ...s, memory: { ...s.memory, undone: true } };
  });
  return changed ? { ...trace, steps } : null;
}

/** The chat's "Remembered" line for a memory that's gone says so. */
export function markMemoryUndone(qc: QueryClient, id: string) {
  qc.setQueriesData<ConversationDetail>({ queryKey: ["conversation"] }, (d) => {
    if (!d) return d;
    let changed = false;
    const messages = d.messages.map((msg) => {
      const trace = msg.trace && markUndone(msg.trace, id);
      if (!trace) return msg;
      changed = true;
      return { ...msg, trace };
    });
    return changed ? { ...d, messages } : d;
  });
}

/** Live updates from the server. */
export function applyMemoryEvent(
  qc: QueryClient,
  ev: { type: "memory.updated"; memory: MemoryView } | { type: "memory.removed"; id: string },
) {
  qc.setQueryData<MemoryView[]>(memoriesKey, (list) => {
    if (!list) return list;
    if (ev.type === "memory.removed") return list.filter((m) => m.id !== ev.id);
    const i = list.findIndex((m) => m.id === ev.memory.id);
    if (i === -1) return [ev.memory, ...list];
    const next = list.slice();
    next[i] = ev.memory;
    return next;
  });
  // Searches the server answered are stale now.
  void qc.invalidateQueries({
    predicate: (q) => q.queryKey[0] === memoriesKey[0] && q.queryKey.length > 1,
  });
  if (ev.type === "memory.removed") markMemoryUndone(qc, ev.id);
}
