import type { ApprovalView } from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitBranch, GitPullRequest, ShieldCheck, Upload, Workflow } from "lucide-react";
import { useState } from "react";
import { Content, Page, Toolbar, ToolbarText } from "../components/Page.tsx";
import { SandboxFallbackCard } from "../components/SandboxFallbackCard.tsx";
import {
  Badge,
  Button,
  Card,
  CardFooter,
  Empty,
  ErrorText,
  Kicker,
  Mono,
  Skeleton,
  Tabs,
} from "../components/ui.tsx";
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

  const [tab, setTab] = useState<"all" | "tasks" | "workflows" | "sandboxes">("all");
  const total = approvals.data?.length ?? 0;
  const show = (t: typeof tab) => tab === "all" || tab === t;

  return (
    <Page
      title="Approvals"
      badge={
        total > 0 ? (
          <Badge tone="warn" dot>
            {total} waiting
          </Badge>
        ) : undefined
      }
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "all", label: "All", count: total },
            { id: "tasks", label: "Pushes and PRs", count: byTask.size },
            { id: "workflows", label: "Workflows", count: workflow.length },
            { id: "sandboxes", label: "Sandboxes", count: fallback.length },
          ]}
        />
      }
      toolbar={
        <Toolbar>
          <ToolbarText>Steps waiting for you. They expire after 24 hours.</ToolbarText>
        </Toolbar>
      }
    >
      <Content className="space-y-4 pt-2">
        {approvals.isPending && <Skeleton className="h-40 w-full rounded-xl" />}
        <ErrorText error={approvals.error} />
        {approvals.data?.length === 0 && (
          <Empty icon={ShieldCheck} title="Nothing waiting">
            You're all caught up.
          </Empty>
        )}
        {show("sandboxes") && fallback.map((a) => <SandboxFallbackCard key={a.id} approval={a} />)}
        {show("tasks") &&
          [...byTask.entries()].map(([taskId, list]) => (
            <ApprovalGroup key={taskId} taskId={taskId} approvals={list} />
          ))}
        {show("workflows") && workflow.map((a) => <WorkflowApproval key={a.id} approval={a} />)}
      </Content>
    </Page>
  );
}

const ICON = { push: Upload, open_pr: GitPullRequest, merge: GitBranch, deploy: GitBranch };

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
        <Kicker icon={GitPullRequest}>Push and pull request</Kicker>
        <div>
          <Link
            to="/tasks/$id"
            params={{ id: taskId }}
            className="text-sm font-medium decoration-faint underline-offset-2 hover:underline"
          >
            {t.title}
          </Link>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            {t.repoName}
            {t.runnerName ? ` on ${t.runnerName}` : ""} · <Mono>{t.branch}</Mono>
          </p>
        </div>
        <ul className="space-y-1.5 text-[13px]">
          {approvals.map((a) => {
            const Icon = a.actionKind ? ICON[a.actionKind] : Upload;
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-x-2">
                <Icon aria-hidden="true" className="text-subtle" />
                <span className="font-medium">{a.actionKind ? LABEL[a.actionKind] : a.title}</span>
                <span className="text-xs text-muted">
                  {a.actionKind === "push" ? `to ${t.remoteUrl || "origin"} · ` : ""}expires{" "}
                  {ago(a.expiresAt)}
                </span>
              </li>
            );
          })}
        </ul>
        {t.diffStats && (
          <p className="tabular text-[13px]">
            {plural(t.diffStats.filesChanged, "file")},{" "}
            <span className="text-ok">+{t.diffStats.insertions}</span>{" "}
            <span className="text-danger">-{t.diffStats.deletions}</span>
          </p>
        )}
        {pr?.prTitle && (
          <div className="rounded-lg bg-surface-2 p-3 text-[13px] shadow-raised">
            <p className="font-medium">{pr.prTitle}</p>
            <p className="mt-1 leading-5 whitespace-pre-wrap text-muted">{pr.prBody}</p>
          </div>
        )}
      </div>
      <CardFooter>
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
      </CardFooter>
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
        <Kicker icon={Workflow}>Workflow step</Kicker>
        <p className="text-sm font-medium">{approval.title}</p>
        <p className="text-xs text-muted">
          {r ? (
            <>
              From{" "}
              <Link
                to="/workflows/$id"
                params={{ id: r.workflowId }}
                className="text-soft hover:text-text hover:underline"
              >
                {r.workflowName}
              </Link>{" "}
              v{r.versionNumber} ·{" "}
              <Link
                to="/workflows/$id/runs/$runId"
                params={{ id: r.workflowId, runId: r.id }}
                className="text-accent-text hover:underline"
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
          <pre className="max-h-60 overflow-auto rounded-lg bg-field p-3 font-mono text-xs whitespace-pre-wrap shadow-field">
            {JSON.stringify(approval.payload, null, 2)}
          </pre>
        )}
      </div>
      <CardFooter>
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
      </CardFooter>
    </Card>
  );
}
