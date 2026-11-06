import type { ApprovalView, RunnerView } from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Rocket,
  ShieldCheck,
  Upload,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { DeployPlanText } from "../components/DeployBits.tsx";
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
import { groupApprovals } from "../lib/approvals.ts";
import {
  deployPlan,
  targetForRemote,
  targetForTask,
  taskRepo,
  useDeployTargets,
} from "../lib/deploys.ts";
import { ago, plural } from "../lib/format.ts";
import type { TaskDetail } from "../lib/types.ts";
import { useRun } from "../lib/workflowApi.ts";

const LABEL = {
  push: "Push branch",
  open_pr: "Open pull request",
  merge: "Merge",
  deploy: "Deploy",
  verify: "Check the site",
};

export function ApprovalsPage() {
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<ApprovalView[]>("/api/approvals"),
  });
  const { byTask, workflow, fallback, decisions } = groupApprovals(approvals.data ?? []);

  const [tab, setTab] = useState<"all" | "tasks" | "workflows" | "sandboxes">("all");
  const total = decisions;
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
            { id: "tasks", label: "Tasks", count: byTask.size },
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
      {approvals.data?.length === 0 ? (
        <Empty fill icon={ShieldCheck} title="Nothing waiting">
          You're all caught up.
        </Empty>
      ) : (
        <Content className="space-y-4 pt-2">
          {approvals.isPending && <Skeleton className="h-40 w-full rounded-xl" />}
          <ErrorText error={approvals.error} />
          {show("sandboxes") &&
            fallback.map((a) => <SandboxFallbackCard key={a.id} approval={a} />)}
          {show("tasks") &&
            [...byTask.entries()].map(([taskId, list]) => (
              <ApprovalGroup key={taskId} taskId={taskId} approvals={list} />
            ))}
          {show("workflows") && workflow.map((a) => <WorkflowApproval key={a.id} approval={a} />)}
        </Content>
      )}
    </Page>
  );
}

const ICON = {
  push: Upload,
  open_pr: GitPullRequest,
  merge: GitMerge,
  deploy: Rocket,
  verify: Activity,
};

function ApprovalGroup({ taskId, approvals }: { taskId: string; approvals: ApprovalView[] }) {
  // Merge and deploy wait together, once the PR exists: that's one deployment to approve.
  if (approvals.some((a) => a.actionKind === "merge" || a.actionKind === "deploy")) {
    return <DeployApprovalGroup taskId={taskId} approvals={approvals} />;
  }
  return <PullRequestGroup taskId={taskId} approvals={approvals} />;
}

function useTaskDecision(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      api.post(`/api/tasks/${taskId}/approval`, { decision }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["approvals"] }),
  });
}

function DecisionFooter({ decide }: { decide: ReturnType<typeof useTaskDecision> }) {
  return (
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
  );
}

function StepList({ approvals, remoteUrl }: { approvals: ApprovalView[]; remoteUrl: string }) {
  return (
    <ul className="space-y-1.5 text-[13px]">
      {approvals.map((a) => {
        const Icon = a.actionKind ? ICON[a.actionKind] : Upload;
        return (
          <li key={a.id} className="flex flex-wrap items-center gap-x-2">
            <Icon aria-hidden="true" className="text-subtle" />
            <span className="font-medium">{a.actionKind ? LABEL[a.actionKind] : a.title}</span>
            <span className="text-xs text-muted">
              {a.actionKind === "push" ? `to ${remoteUrl || "origin"} · ` : ""}expires{" "}
              {ago(a.expiresAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Approve deployment?" for a task whose PR is open: the target, and what
 * merging and deploying will do, in order.
 */
function DeployApprovalGroup({ taskId, approvals }: { taskId: string; approvals: ApprovalView[] }) {
  const decide = useTaskDecision(taskId);
  const targets = useDeployTargets();
  const runners = useQuery({
    queryKey: ["runners"],
    queryFn: () => api.get<RunnerView[]>("/api/runners"),
  });
  // The task has the PR's URL and the target its steps name.
  const detail = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.get<TaskDetail>(`/api/tasks/${taskId}`),
  });
  const t = approvals[0]?.task;
  if (!t) return null;
  const task = detail.data?.task;
  const target = task
    ? targetForTask(task, targets.data, runners.data)
    : targetForRemote(t.remoteUrl, targets.data);
  const targetName = target?.name ?? task?.actions.find((a) => a.targetName)?.targetName;
  const prUrl = task?.actions.find((a) => a.kind === "open_pr")?.url ?? null;

  return (
    <Card className="overflow-hidden">
      <div className="space-y-3 p-4">
        <Kicker icon={Rocket}>Approve deployment?</Kicker>
        <div>
          <p className="text-sm font-medium">{targetName ?? t.repoName}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <Link
              to="/tasks/$id"
              params={{ id: taskId }}
              className="text-soft decoration-faint underline-offset-2 hover:text-text hover:underline"
            >
              {t.title}
            </Link>
            <span>
              · {t.repoName}
              {t.runnerName ? ` on ${t.runnerName}` : ""}
            </span>
            {prUrl && (
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-text hover:underline"
              >
                View PR
                <ExternalLink aria-hidden="true" size={12} />
              </a>
            )}
          </p>
        </div>
        <p className="text-[13px] leading-5 text-soft">
          <DeployPlanText
            plan={deployPlan({
              prUrl,
              branch: t.branch,
              defaultBranch: task ? (taskRepo(task, runners.data)?.defaultBranch ?? null) : null,
              target,
            })}
          />
        </p>
        <StepList approvals={approvals} remoteUrl={t.remoteUrl} />
      </div>
      <DecisionFooter decide={decide} />
    </Card>
  );
}

function PullRequestGroup({ taskId, approvals }: { taskId: string; approvals: ApprovalView[] }) {
  const first = approvals[0];
  const decide = useTaskDecision(taskId);
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
        <StepList approvals={approvals} remoteUrl={t.remoteUrl} />
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
      <DecisionFooter decide={decide} />
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
