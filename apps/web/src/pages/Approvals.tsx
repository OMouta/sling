import type { ApprovalView } from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SandboxFallbackCard } from "../components/SandboxFallbackCard.tsx";
import { Button, Card, Empty, ErrorText, PageHeader, Spinner } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ago, plural } from "../lib/format.ts";
import { useRun } from "../lib/workflowApi.ts";

const LABEL = {
  push: "Push branch",
  open_pr: "Open pull request",
  merge: "Merge",
  deploy: "Deploy",
};

export function ApprovalsPage() {
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<ApprovalView[]>("/api/approvals"),
  });
  const byTask = new Map<string, ApprovalView[]>();
  const workflow: ApprovalView[] = [];
  const fallback: ApprovalView[] = [];
  for (const a of approvals.data ?? []) {
    if (a.kind === "sandbox_fallback") {
      fallback.push(a);
      continue;
    }
    if (a.kind === "workflow" || !a.taskId) {
      workflow.push(a);
      continue;
    }
    byTask.set(a.taskId, [...(byTask.get(a.taskId) ?? []), a]);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <PageHeader
        title="Approvals"
        description="Steps waiting for you. They expire after 24 hours."
      />
      {approvals.isPending && <Spinner />}
      <ErrorText error={approvals.error} />
      {approvals.data?.length === 0 && <Empty title="Nothing waiting">You're all caught up.</Empty>}
      {fallback.map((a) => (
        <SandboxFallbackCard key={a.id} approval={a} />
      ))}
      {[...byTask.entries()].map(([taskId, list]) => (
        <ApprovalGroup key={taskId} taskId={taskId} approvals={list} />
      ))}
      {workflow.map((a) => (
        <WorkflowApproval key={a.id} approval={a} />
      ))}
    </div>
  );
}

function ApprovalGroup({ taskId, approvals }: { taskId: string; approvals: ApprovalView[] }) {
  const qc = useQueryClient();
  const first = approvals[0];
  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      api.post(`/api/tasks/${taskId}/approval`, { decision }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approvals"] }),
  });
  if (!first?.task) return null;
  const t = first.task;
  const pr = approvals.find((a) => a.actionKind === "open_pr");

  return (
    <Card className="overflow-hidden">
      <div className="space-y-3 p-4">
        <div>
          <Link to="/tasks/$id" params={{ id: taskId }} className="font-medium hover:underline">
            {t.title}
          </Link>
          <p className="text-sm text-muted">
            {t.repoName}
            {t.runnerName ? ` on ${t.runnerName}` : ""} ·{" "}
            <code className="font-mono text-xs">{t.branch}</code>
          </p>
        </div>
        <ul className="space-y-1 text-sm">
          {approvals.map((a) => (
            <li key={a.id}>
              <span className="font-medium">{a.actionKind ? LABEL[a.actionKind] : a.title}</span>
              <span className="text-muted">
                {a.actionKind === "push" ? ` to ${t.remoteUrl || "origin"}` : ""} · expires{" "}
                {ago(a.expiresAt)}
              </span>
            </li>
          ))}
        </ul>
        {t.diffStats && (
          <p className="text-sm">
            {plural(t.diffStats.filesChanged, "file")},{" "}
            <span className="text-ok">+{t.diffStats.insertions}</span>{" "}
            <span className="text-danger">-{t.diffStats.deletions}</span>
          </p>
        )}
        {pr?.prTitle && (
          <div className="rounded-lg bg-surface-2 p-3 text-sm">
            <p className="font-medium">{pr.prTitle}</p>
            <p className="mt-1 whitespace-pre-wrap text-muted">{pr.prBody}</p>
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-4 py-3">
        <ErrorText error={decide.error} />
        <Button size="sm" busy={decide.isPending} onClick={() => decide.mutate("reject")}>
          Reject
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={decide.isPending}
          onClick={() => decide.mutate("approve")}
        >
          Approve
        </Button>
      </div>
    </Card>
  );
}

function WorkflowApproval({ approval }: { approval: ApprovalView }) {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      api.post(`/api/approvals/${approval.id}`, { decision }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approvals"] }),
  });
  // The approval names its run; the run says which workflow it belongs to.
  const run = useRun(approval.runId);
  const r = run.data?.run;
  return (
    <Card className="overflow-hidden">
      <div className="space-y-2 p-4">
        <p className="font-medium">{approval.title}</p>
        <p className="text-sm text-muted">
          {r ? (
            <>
              From{" "}
              <Link
                to="/workflows/$id"
                params={{ id: r.workflowId }}
                className="text-text hover:underline"
              >
                {r.workflowName}
              </Link>{" "}
              v{r.versionNumber} ·{" "}
              <Link
                to="/workflows/$id/runs/$runId"
                params={{ id: r.workflowId, runId: r.id }}
                className="text-accent hover:underline"
              >
                view run
              </Link>
            </>
          ) : (
            "From a workflow"
          )}{" "}
          · expires {ago(approval.expiresAt)}
        </p>
        {approval.payload && (
          <pre className="max-h-60 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap">
            {JSON.stringify(approval.payload, null, 2)}
          </pre>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-4 py-3">
        <ErrorText error={decide.error} />
        <Button size="sm" busy={decide.isPending} onClick={() => decide.mutate("reject")}>
          Reject
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={decide.isPending}
          onClick={() => decide.mutate("approve")}
        >
          Approve
        </Button>
      </div>
    </Card>
  );
}
