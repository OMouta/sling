import type {
  InstallationView,
  NodeRunView,
  RunDetailView,
  RunnerView,
  RunView,
  SandboxListView,
  SandboxView,
  ServerEvent,
  TaskView,
  WorkflowSummaryView,
} from "@sling/core";
import type { WorkflowDetailView } from "@sling/workflow";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { modelsKey } from "./models.ts";
import type { ConversationDetail, TaskDetail } from "./types.ts";
import { qk } from "./workflowApi.ts";

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
  qc.setQueryData<TaskView[]>(["tasks"], (list) => upsertLoaded(list, task, true));
  if (task.conversationId) {
    qc.setQueryData<ConversationDetail>(["conversation", task.conversationId], (d) =>
      d ? { ...d, tasks: upsert(d.tasks, task) } : d,
    );
  }
}

/** Upserts into a cached list, but doesn't create one that was never fetched. */
function upsertLoaded<T extends { id: string }>(list: T[] | undefined, item: T, prepend = false) {
  return list ? upsert(list, item, prepend) : list;
}

/**
 * Workflow events patch the keys documented in `workflowApi.ts`. The editor
 * keeps its own copy of the draft, so a summary update only touches the
 * detail's summary fields. A new active version also changes the detail's
 * `active` definition and webhooks, which the event doesn't carry, so that
 * case refetches.
 */
function applyWorkflow(qc: QueryClient, wf: WorkflowSummaryView) {
  qc.setQueryData<WorkflowSummaryView[]>(qk.workflows(), (list) => upsertLoaded(list, wf, true));
  let newVersion = false;
  qc.setQueryData<WorkflowDetailView>(qk.workflow(wf.id), (d) => {
    if (!d) return d;
    newVersion = d.activeVersion !== wf.activeVersion;
    return {
      ...d,
      name: wf.name,
      description: wf.description,
      enabled: wf.enabled,
      templateKey: wf.templateKey,
      activeVersion: wf.activeVersion,
      hasUnpublishedChanges: wf.hasUnpublishedChanges,
      updatedAt: wf.updatedAt,
    };
  });
  if (newVersion) {
    void qc.invalidateQueries({ queryKey: qk.workflow(wf.id) });
    void qc.invalidateQueries({ queryKey: qk.versions(wf.id) });
  }
}

function applyRun(qc: QueryClient, run: RunView) {
  qc.setQueryData<RunView[]>(qk.runs(run.workflowId), (list) => upsertLoaded(list, run, true));
  qc.setQueryData<RunDetailView>(qk.run(run.id), (d) => (d ? { ...d, run } : d));
  qc.setQueryData<WorkflowSummaryView[]>(qk.workflows(), (list) =>
    list?.map((w) =>
      w.id === run.workflowId && (!w.lastRun || w.lastRun.createdAt <= run.createdAt)
        ? { ...w, lastRun: { id: run.id, status: run.status, createdAt: run.createdAt } }
        : w,
    ),
  );
}

function applyNodeRun(qc: QueryClient, nodeRun: NodeRunView) {
  qc.setQueryData<RunDetailView>(qk.run(nodeRun.runId), (d) =>
    d ? { ...d, nodeRuns: upsert(d.nodeRuns, nodeRun) } : d,
  );
}

/**
 * A sandbox changed. The list patches right away. The event doesn't carry the
 * month's usage, and a new sandbox or a change of state is what moves the
 * running count, so those refetch the list. The task running in it shows the
 * sandbox's state on its card, so that patches too.
 */
function applySandbox(qc: QueryClient, sandbox: SandboxView) {
  let lifecycle = false;
  qc.setQueryData<SandboxListView>(qk.sandboxes(), (d) => {
    if (!d) return d;
    const prev = d.sandboxes.find((s) => s.id === sandbox.id);
    lifecycle = prev?.state !== sandbox.state;
    return { ...d, sandboxes: upsert(d.sandboxes, sandbox, true) };
  });
  if (lifecycle) void qc.invalidateQueries({ queryKey: qk.sandboxes() });

  const taskId = sandbox.taskId;
  if (!taskId) return;
  const patch = (task: TaskView): TaskView => {
    const env = task.environment;
    // A retry can give a task a newer sandbox; an older one's events don't apply.
    if (task.id !== taskId || (env.sandboxId && env.sandboxId !== sandbox.id)) return task;
    return {
      ...task,
      environment: {
        kind: "sandbox",
        sandboxId: sandbox.id,
        sandboxState: sandbox.state,
        providerName: env.providerName ?? sandbox.providerName,
      },
    };
  };
  qc.setQueryData<TaskDetail>(["task", taskId], (d) => (d ? { ...d, task: patch(d.task) } : d));
  qc.setQueryData<TaskView[]>(["tasks"], (list) => list?.map(patch));
  qc.setQueriesData<ConversationDetail>({ queryKey: ["conversation"] }, (d) =>
    d?.tasks.some((t) => t.id === taskId) ? { ...d, tasks: d.tasks.map(patch) } : d,
  );
}

export function apply(qc: QueryClient, ev: ServerEvent) {
  switch (ev.type) {
    case "runner.updated":
      qc.setQueryData<RunnerView[]>(["runners"], (list) => {
        // A sandbox's Runner is never a machine, so the Machines list skips it.
        if (ev.runner.revokedAt || ev.runner.ephemeral) {
          return list?.filter((r) => r.id !== ev.runner.id);
        }
        return upsert(list, ev.runner);
      });
      // A machine coming online, going away, or logging in changes what chat can use.
      void qc.invalidateQueries({ queryKey: modelsKey });
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
    case "workflow.updated":
      applyWorkflow(qc, ev.workflow);
      return;
    case "run.updated":
      applyRun(qc, ev.run);
      return;
    case "node_run.updated":
      applyNodeRun(qc, ev.nodeRun);
      return;
    case "installation.updated":
      qc.setQueryData<InstallationView[]>(qk.installations(), (list) =>
        upsertLoaded(list, ev.installation),
      );
      return;
    case "sandbox.updated":
      applySandbox(qc, ev.sandbox);
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
