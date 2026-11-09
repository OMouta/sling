import type {
  ActionCheckView,
  CheckInput,
  CheckKind,
  CheckPatch,
  CheckResultView,
  CheckState,
  CheckView,
  ServerEvent,
  ToolStep,
} from "@sling/core";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import type { ConversationDetail } from "./types.ts";

/**
 * Everything Sling watches on its own. `check.changed` and `check.removed`
 * patch the list, and a reconnect refetches it.
 */
export const checksKey = ["checks"] as const;
export const checkResultsKey = (id: string) => ["checks", id, "results"] as const;

export function useChecks(enabled = true) {
  return useQuery({
    queryKey: checksKey,
    queryFn: ({ signal }) => api.get<CheckView[]>("/api/checks", { signal }),
    staleTime: 60_000,
    enabled,
  });
}

export function useCheckResults(id: string, enabled: boolean) {
  return useQuery({
    queryKey: checkResultsKey(id),
    queryFn: ({ signal }) => api.get<CheckResultView[]>(`/api/checks/${id}/results`, { signal }),
    enabled,
  });
}

export const checkApi = {
  create: (body: CheckInput) => api.post<CheckView>("/api/checks", body),
  update: (id: string, body: CheckPatch) => api.patch<CheckView>(`/api/checks/${id}`, body),
  remove: (id: string) => api.del<unknown>(`/api/checks/${id}`),
  run: (id: string) => api.post<CheckView>(`/api/checks/${id}/run`),
};

const byName = (a: CheckView, b: CheckView) => a.name.localeCompare(b.name);

export function upsertCheck(qc: QueryClient, check: CheckView) {
  qc.setQueryData<CheckView[]>(checksKey, (list) => {
    if (!list) return list;
    const i = list.findIndex((c) => c.id === check.id);
    if (i === -1) return [...list, check].sort(byName);
    const next = list.slice();
    next[i] = check;
    return next;
  });
  // A new run goes at the top of an open history.
  const r = check.lastResult;
  if (r) {
    qc.setQueryData<CheckResultView[]>(checkResultsKey(check.id), (list) =>
      list && !list.some((x) => x.id === r.id) ? [r, ...list].slice(0, 100) : list,
    );
  }
}

export function forgetCheck(qc: QueryClient, id: string) {
  qc.setQueryData<CheckView[]>(checksKey, (list) => list?.filter((c) => c.id !== id));
  qc.removeQueries({ queryKey: checkResultsKey(id) });
}

export function applyCheckEvent(
  qc: QueryClient,
  ev: Extract<ServerEvent, { type: "check.changed" | "check.removed" }>,
) {
  if (ev.type === "check.changed") upsertCheck(qc, ev.check);
  else forgetCheck(qc, ev.id);
}

/** An action's check that changed after its reply was saved lands on the reply's step. */
export function applyToolStepCheck(
  qc: QueryClient,
  ev: Extract<ServerEvent, { type: "tool_step.check" }>,
) {
  const patch = (check: ActionCheckView) => (s: ConversationDetail["messages"][number]) => {
    if (s.id !== ev.messageId || !s.trace) return s;
    return {
      ...s,
      trace: {
        ...s.trace,
        steps: s.trace.steps.map((step) =>
          step.kind === "tool" && step.id === ev.stepId ? ({ ...step, check } as ToolStep) : step,
        ),
      },
    };
  };
  qc.setQueryData<ConversationDetail>(["conversation", ev.conversationId], (d) =>
    d ? { ...d, messages: d.messages.map(patch(ev.check)) } : d,
  );
}

/* ----------------------------------------------------------------- words */

export const KIND_LABEL: Record<CheckKind, string> = {
  site: "Site",
  command: "Command",
  reply: "Reply",
};

/** How a state reads: "Up", "Down", "Waiting for a reply". */
export function stateText(state: CheckState, kind: CheckKind): string {
  switch (state) {
    case "unknown":
      return "Not checked yet";
    case "up":
      return kind === "command" ? "Passing" : "Up";
    case "down":
      return kind === "command" ? "Failing" : "Down";
    case "waiting":
      return "Waiting";
    case "met":
      return "Replied";
    case "missed":
      return "No reply";
  }
}

export function stateTone(state: CheckState): "ok" | "danger" | "warn" | "neutral" {
  if (state === "up" || state === "met") return "ok";
  if (state === "down" || state === "missed") return "danger";
  return "neutral";
}

/** "Every minute", "Every 5 min", "Every hour". */
export function everyText(seconds: number): string {
  if (seconds < 60) return `Every ${seconds} s`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "Every hour" : `Every ${seconds / 3600} h`;
  const m = Math.round(seconds / 60);
  return m === 1 ? "Every minute" : `Every ${m} min`;
}

/** What a check watches, in a few words: the hosts, the command, or who should reply. */
export function watchesText(c: CheckView): string {
  const cfg = c.config;
  if (cfg.kind === "site") {
    const hosts = [
      ...new Set(
        cfg.checks.map((x) => {
          try {
            const u = new URL(x.url);
            return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
          } catch {
            return x.url;
          }
        }),
      ),
    ];
    return hosts.join(", ");
  }
  if (cfg.kind === "command") return cfg.command;
  const parts = [cfg.from && `from ${cfg.from}`, cfg.subject && `“${cfg.subject}”`].filter(Boolean);
  return parts.join(", ") || "a reply";
}

/** "Fri 13 Nov, 17:00" in the browser's zone. */
export function deadlineText(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}
