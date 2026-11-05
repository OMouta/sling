import type { ApprovalView } from "@sling/core";

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
export function decisionCount(list: ApprovalView[] | undefined): number {
  return list ? groupApprovals(list).decisions : 0;
}
