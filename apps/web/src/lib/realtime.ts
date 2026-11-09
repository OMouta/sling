import type {
  ConversationSummaryView,
  InstallationView,
  NodeRunView,
  RunDetailView,
  RunnerView,
  RunView,
  SandboxListView,
  SandboxView,
  ServerEvent,
  TaskView,
  TraceStep,
  WorkflowSummaryView,
} from "@sling/core";
import type { WorkflowDetailView } from "@sling/workflow";
import type { QueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { applyCheckEvent, applyToolStepCheck } from "./checks.ts";
import { conversationsKey, patchListedConversation, previewText } from "./conversations.ts";
import { applyDeployTargetEvent } from "./deploys.ts";
import { applyExtension, forgetExtension } from "./extensionApi.ts";
import { liveText } from "./followUps.ts";
import { applyMemoryEvent } from "./memory.ts";
import { modelsKey } from "./models.ts";
import { applyPersonalityEvent } from "./personalities.ts";
import { applyRuleEvent } from "./rules.ts";
import { applySourceEvent } from "./sources.ts";
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
/** A reply as it streams in: its text so far, and its thinking and tool calls. */
export interface LiveReply {
  text: string;
  steps: TraceStep[];
  startedAt: number;
}

const streaming = new Store<Record<string, LiveReply>>({});

export function useConnection() {
  return useSyncExternalStore(connection.subscribe, connection.get);
}

/** The reply streaming in for a conversation's current turn, if any. */
export function useLiveReply(conversationId: string): LiveReply | null {
  const all = useSyncExternalStore(streaming.subscribe, streaming.get);
  const reply = all[conversationId] ?? null;
  return useMemo(() => (reply ? { ...reply, text: liveText(reply.text) } : null), [reply]);
}

/**
 * Fills in a reply that was already being written when the chat opened, from
 * the server's copy. What streamed in since stays when it's further along.
 */
export function seedLiveReply(conversationId: string, live: LiveReply) {
  const current = streaming.get()[conversationId];
  if (
    current &&
    current.steps.length >= live.steps.length &&
    current.text.length >= live.text.length
  )
    return;
  streaming.set({ ...streaming.get(), [conversationId]: live });
}

function clearStream(conversationId: string) {
  if (!(conversationId in streaming.get())) return;
  const next = { ...streaming.get() };
  delete next[conversationId];
  streaming.set(next);
}

/**
 * Text followed by more work becomes a step, so only the text after the last
 * step is the answer. The server builds the same steps (`TraceRecorder`).
 */
function settleText(r: LiveReply): LiveReply {
  const text = liveText(r.text).trim();
  if (!text) return { ...r, text: "" };
  return { ...r, text: "", steps: [...r.steps, { kind: "text", text }] };
}

function patchStream(conversationId: string, fn: (r: LiveReply) => LiveReply) {
  const all = streaming.get();
  const current = all[conversationId] ?? { text: "", steps: [], startedAt: Date.now() };
  streaming.set({ ...all, [conversationId]: fn(current) });
}

function upsert<T extends { id: string }>(list: T[] | undefined, item: T, prepend = false): T[] {
  if (!list) return [item];
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return prepend ? [item, ...list] : [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const chatTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Refetches an open chat soon. Whether Retry and Edit may replace a message
 * depends on everything after it, which only the server can tell.
 */
function refreshChat(qc: QueryClient, conversationId: string) {
  clearTimeout(chatTimers.get(conversationId));
  chatTimers.set(
    conversationId,
    setTimeout(() => {
      chatTimers.delete(conversationId);
      void qc.invalidateQueries({ queryKey: ["conversation", conversationId], exact: true });
    }, 300),
  );
}

/**
 * Changes a chat's messages. None of the others stays replaceable until the
 * server says again: a new message is the latest now, and a new reply may
 * have done something outside the chat.
 */
function patchMessages(
  qc: QueryClient,
  conversationId: string,
  fn: (messages: ConversationDetail["messages"]) => ConversationDetail["messages"],
) {
  qc.setQueryData<ConversationDetail>(["conversation", conversationId], (d) =>
    d
      ? {
          ...d,
          messages: fn(d.messages.map((m) => (m.replaceable ? { ...m, replaceable: false } : m))),
        }
      : d,
  );
}

/** Refetches the conversation lists soon, once for a burst of changes. */
function refreshConversations(qc: QueryClient) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void qc.invalidateQueries({ queryKey: conversationsKey }), 400);
}

/**
 * Changes one conversation in the lists. One the recent list doesn't have,
 * such as a new conversation's first message, makes the lists refetch, since
 * the server decides what's in them. So does a change to what the counts
 * count: whether it waits on the user, or is at work.
 */
function patchConversation(
  qc: QueryClient,
  id: string,
  fn: (c: ConversationSummaryView) => ConversationSummaryView,
  toTop = false,
) {
  let recount = false;
  const found = patchListedConversation(
    qc,
    id,
    (c) => {
      const next = fn(c);
      recount ||= next.waiting !== c.waiting || next.agentStatus !== c.agentStatus;
      return next;
    },
    toTop,
  );
  if (!found || recount) refreshConversations(qc);
}

function applyTask(qc: QueryClient, task: TaskView) {
  qc.setQueryData<TaskDetail>(["task", task.id], (d) => (d ? { ...d, task } : d));
  qc.setQueryData<TaskView[]>(["tasks"], (list) => upsertLoaded(list, task, true));
  if (task.conversationId) {
    qc.setQueryData<ConversationDetail>(["conversation", task.conversationId], (d) =>
      d ? { ...d, tasks: upsert(d.tasks, task) } : d,
    );
    refreshConversations(qc);
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
    case "personality.updated":
    case "personality.removed":
      applyPersonalityEvent(qc, ev);
      return;
    case "memory.updated":
    case "memory.removed":
      applyMemoryEvent(qc, ev);
      return;
    case "source.updated":
    case "source.removed":
      applySourceEvent(qc, ev);
      return;
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
      refreshConversations(qc);
      return;
    case "conversation.updated": {
      // Archived or restored: it leaves the lists it was in, and the server
      // says which it goes in now.
      const found = patchListedConversation(qc, ev.conversation.id, (c) =>
        c.archived === ev.conversation.archived ? { ...c, ...ev.conversation } : null,
      );
      if (!found) refreshConversations(qc);
      qc.setQueryData<ConversationDetail>(["conversation", ev.conversation.id], (d) =>
        d ? { ...d, conversation: ev.conversation } : d,
      );
      return;
    }
    case "message.created":
      if (ev.message.role === "assistant") clearStream(ev.message.conversationId);
      patchConversation(
        qc,
        ev.message.conversationId,
        (c) => ({
          ...c,
          preview: previewText(ev.message.text, ev.message.role) || c.preview,
          previewRole: ev.message.role,
          lastMessageAt: ev.message.createdAt,
        }),
        true,
      );
      patchMessages(qc, ev.message.conversationId, (list) => upsert(list, ev.message));
      if (ev.message.role === "assistant") refreshChat(qc, ev.message.conversationId);
      return;
    case "message.updated":
      patchMessages(qc, ev.message.conversationId, (list) => upsert(list, ev.message));
      return;
    case "message.removed": {
      const gone = new Set(ev.messageIds);
      patchMessages(qc, ev.conversationId, (list) => list.filter((m) => !gone.has(m.id)));
      refreshConversations(qc);
      return;
    }
    case "agent.delta":
      patchStream(ev.conversationId, (r) => ({ ...r, text: r.text + ev.text }));
      return;
    case "agent.thinking":
      patchStream(ev.conversationId, (r) => {
        const settled = settleText(r);
        const last = settled.steps.at(-1);
        if (last?.kind === "thinking") {
          return {
            ...settled,
            steps: [...settled.steps.slice(0, -1), { ...last, text: last.text + ev.text }],
          };
        }
        return { ...settled, steps: [...settled.steps, { kind: "thinking", text: ev.text }] };
      });
      return;
    case "agent.tool":
      if (ev.step.approval) {
        const waiting = ev.step.approval.state === "pending";
        patchConversation(qc, ev.conversationId, (c) => ({ ...c, waiting }));
      }
      patchStream(ev.conversationId, (r) => {
        const i = r.steps.findIndex((s) => s.kind === "tool" && s.id === ev.step.id);
        if (i === -1) {
          const settled = settleText(r);
          return { ...settled, steps: [...settled.steps, ev.step] };
        }
        const steps = r.steps.slice();
        steps[i] = ev.step;
        return { ...r, steps };
      });
      return;
    case "agent.status":
      if (ev.status === "thinking") {
        clearStream(ev.conversationId);
        patchStream(ev.conversationId, (r) => r);
      } else {
        clearStream(ev.conversationId);
      }
      qc.setQueryData<ConversationDetail>(["conversation", ev.conversationId], (d) =>
        d ? { ...d, agentStatus: ev.status } : d,
      );
      patchConversation(qc, ev.conversationId, (c) => ({ ...c, agentStatus: ev.status }));
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
    case "extension.updated":
      applyExtension(qc, ev.extension);
      return;
    case "extension.removed":
      forgetExtension(qc, ev.id);
      return;
    case "deploy_target.updated":
    case "deploy_target.removed":
      applyDeployTargetEvent(qc, ev);
      return;
    case "rule.updated":
      applyRuleEvent(qc, ev);
      return;
    case "check.changed":
    case "check.removed":
      applyCheckEvent(qc, ev);
      return;
    case "tool_step.check":
      applyToolStepCheck(qc, ev);
      return;
    case "settings.updated":
      for (const queryKey of [["settings"], qk.sandboxSettings(), qk.sandboxRepos(), modelsKey]) {
        void qc.invalidateQueries({ queryKey });
      }
      return;
  }
}

/** The socket open now, which presence goes out on. */
let current: WebSocket | null = null;
let openConversation: string | null = null;
let lastPresence = "";

/**
 * Tells the server which conversation this window shows and whether anyone
 * can see it, so replies there aren't also pushed to this person's devices.
 * Sends only what changed, except right after connecting.
 */
function sendPresence(force = false) {
  if (current?.readyState !== 1) return;
  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  const msg = JSON.stringify({ type: "presence", conversationId: openConversation, visible });
  if (!force && msg === lastPresence) return;
  lastPresence = msg;
  current.send(msg);
}

/** The conversation the page shows, or null on any other page. */
export function setOpenConversation(id: string | null) {
  openConversation = id;
  sendPresence();
}

export function connectRealtime(qc: QueryClient): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  let timer: number | undefined;
  let ping: number | undefined;
  let lastFrameAt = 0;

  const open = () => {
    connection.set("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    current = ws;
    ws.onopen = () => {
      const reconnected = attempt > 0;
      attempt = 0;
      connection.set("open");
      lastFrameAt = Date.now();
      sendPresence(true);
      // Anything could have changed while we were away.
      if (reconnected) void qc.invalidateQueries();
      ping = window.setInterval(() => {
        if (Date.now() - lastFrameAt > 60_000) {
          ws?.close();
          return;
        }
        if (ws?.readyState === 1) ws.send("ping");
      }, 25_000);
    };
    ws.onmessage = (e) => {
      lastFrameAt = Date.now();
      try {
        const ev = JSON.parse(e.data as string) as ServerEvent | { type: "pong" };
        if (ev.type !== "pong") apply(qc, ev);
      } catch {
        // Ignore malformed frames.
      }
    };
    ws.onclose = (event) => {
      window.clearInterval(ping);
      // A socket closed on purpose, as on unmount, mustn't mark its successor closed.
      if (stopped) return;
      connection.set("closed");
      if (event.code === 4401 || event.code === 4403) {
        void qc.invalidateQueries();
        return;
      }
      const delay =
        Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)) * (0.5 + Math.random() * 0.5);
      timer = window.setTimeout(open, delay);
    };
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      if (ws?.readyState === 1 && Date.now() - lastFrameAt > 60_000) ws.close();
      void qc.invalidateQueries();
    }
    sendPresence();
  };
  document.addEventListener("visibilitychange", onVisibility);
  open();
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);
    window.clearTimeout(timer);
    window.clearInterval(ping);
    if (current === ws) current = null;
    ws?.close();
  };
}
