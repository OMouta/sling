import type { ApprovalListKind, ApprovalPage, ApprovalView } from "@sling/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

/** Every approval list in the cache starts with this. */
export const approvalsKey = ["approvals"] as const;

/** How many decisions wait, for the bell and the sidebar. */
export function useApprovalCounts() {
  return useQuery({
    queryKey: [...approvalsKey, "counts"],
    queryFn: ({ signal }) => api.get<ApprovalPage>("/api/approvals?limit=1", { signal }),
    select: (page) => page?.counts ?? null,
  });
}

/** Pending approvals of one kind, a page at a time, soonest to expire or newest first. */
export function useApprovalList(
  kind: ApprovalListKind,
  order: "expiring" | "newest",
  enabled = true,
) {
  return useInfiniteQuery({
    enabled,
    queryKey: [...approvalsKey, "list", { kind, order }],
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams({ kind, order });
      if (pageParam) params.set("cursor", pageParam);
      return api.get<ApprovalPage>(`/api/approvals?${params}`, { signal });
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** What waits on one task: its steps, or running it in a sandbox. */
export function useTaskApprovals(taskId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...approvalsKey, "task", taskId],
    queryFn: ({ signal }) =>
      api.get<ApprovalPage>(`/api/approvals?taskId=${encodeURIComponent(taskId)}`, { signal }),
    select: (page) => page?.items ?? [],
    enabled,
  });
}

/** Approvals grouped the way the Approvals page shows them: one decision each. */
export function groupApprovals(list: ApprovalView[]) {
  const byTask = new Map<string, ApprovalView[]>();
  const workflow: ApprovalView[] = [];
  const fallback: ApprovalView[] = [];
  for (const a of list) {
    if (a.kind === "sandbox_fallback") fallback.push(a);
    else if (a.kind === "workflow" || !a.taskId) workflow.push(a);
    else byTask.set(a.taskId, [...(byTask.get(a.taskId) ?? []), a]);
  }
  return { byTask, workflow, fallback, decisions: byTask.size + workflow.length + fallback.length };
}

/** How many decisions are waiting. A task's push and PR are approved together, so they count once. */
export function decisionCount(counts: ApprovalPage["counts"] | undefined): number {
  return counts ? counts.tasks + counts.workflows + counts.sandboxes : 0;
}
