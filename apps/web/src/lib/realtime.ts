import type { RunnerView, ServerEvent, TaskView } from "@sling/core";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { ConversationDetail, TaskDetail } from "./types.ts";

/**
 * One WebSocket per tab. Server events patch the React Query cache directly,
 * so pages re-render without refetching.
 */

type Listener = () => void;

class Store<T> {
  #value: T;
  #listeners = new Set<Listener>();
  constructor(value: T) {
    this.#value = value;
  }
  get = () => this.#value;
  set(value: T) {
    this.#value = value;
    for (const l of this.#listeners) l();
  }
  subscribe = (l: Listener) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };
}

const connection = new Store<"connecting" | "open" | "closed">("connecting");
const streaming = new Store<Record<string, string>>({});

export function useConnection() {
  return useSyncExternalStore(connection.subscribe, connection.get);
}

/** Assistant text streamed so far for a conversation's current turn. */
export function useStreamingText(conversationId: string): string {
  const all = useSyncExternalStore(streaming.subscribe, streaming.get);
  return all[conversationId] ?? "";
}

function setStream(conversationId: string, text: string | null) {
  const next = { ...streaming.get() };
  if (text === null) delete next[conversationId];
  else next[conversationId] = text;
  streaming.set(next);
}

function upsert<T extends { id: string }>(list: T[] | undefined, item: T, prepend = false): T[] {
  if (!list) return [item];
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return prepend ? [item, ...list] : [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

function applyTask(qc: QueryClient, task: TaskView) {
  qc.setQueryData<TaskDetail>(["task", task.id], (d) => (d ? { ...d, task } : d));
  if (task.conversationId) {
    qc.setQueryData<ConversationDetail>(["conversation", task.conversationId], (d) =>
      d ? { ...d, tasks: upsert(d.tasks, task) } : d,
    );
  }
}

export function apply(qc: QueryClient, ev: ServerEvent) {
  switch (ev.type) {
    case "runner.updated":
      qc.setQueryData<RunnerView[]>(["runners"], (list) => {
        if (ev.runner.revokedAt) return list?.filter((r) => r.id !== ev.runner.id);
        return upsert(list, ev.runner);
      });
      return;
    case "task.updated":
      applyTask(qc, ev.task);
      return;
    case "task.event":
      qc.setQueryData<TaskDetail>(["task", ev.event.taskId], (d) => {
        if (!d || d.events.some((e) => e.seq === ev.event.seq)) return d;
        return { ...d, events: [...d.events, ev.event] };
      });
      return;
    case "approval.updated":
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      return;
    case "conversation.updated":
      qc.setQueryData(
        ["conversations"],
        (list: ConversationDetail["conversation"][] | undefined) => {
          const next = upsert(list, ev.conversation, true);
          return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        },
      );
      qc.setQueryData<ConversationDetail>(["conversation", ev.conversation.id], (d) =>
        d ? { ...d, conversation: ev.conversation } : d,
      );
      return;
    case "message.created":
      if (ev.message.role === "assistant") setStream(ev.message.conversationId, null);
      qc.setQueryData<ConversationDetail>(["conversation", ev.message.conversationId], (d) =>
        d ? { ...d, messages: upsert(d.messages, ev.message) } : d,
      );
      return;
    case "agent.delta":
      setStream(ev.conversationId, (streaming.get()[ev.conversationId] ?? "") + ev.text);
      return;
    case "agent.status":
      if (ev.status !== "thinking") setStream(ev.conversationId, null);
      qc.setQueryData<ConversationDetail>(["conversation", ev.conversationId], (d) =>
        d ? { ...d, agentStatus: ev.status } : d,
      );
      return;
  }
}

export function connectRealtime(qc: QueryClient): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  let timer: number | undefined;
  let ping: number | undefined;

  const open = () => {
    connection.set("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    ws.onopen = () => {
      const reconnected = attempt > 0;
      attempt = 0;
      connection.set("open");
      // Anything could have changed while we were away.
      if (reconnected) void qc.invalidateQueries();
      ping = window.setInterval(() => ws?.readyState === 1 && ws.send("ping"), 25_000);
    };
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as ServerEvent | { type: "pong" };
        if (ev.type !== "pong") apply(qc, ev);
      } catch {
        // Ignore malformed frames.
      }
    };
    ws.onclose = () => {
      window.clearInterval(ping);
      connection.set("closed");
      if (stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt++);
      timer = window.setTimeout(open, delay);
    };
  };
  open();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    window.clearInterval(ping);
    ws?.close();
  };
}
