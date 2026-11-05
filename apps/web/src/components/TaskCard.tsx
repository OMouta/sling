import {
  type ActionView,
  type ApprovalView,
  HARNESS_LABELS,
  type RoutingView,
  type TaskState,
  type TaskView,
} from "@sling/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api.ts";
import { between, duration, plural, shortSha } from "../lib/format.ts";
import { pendingFallbackFor } from "../lib/sandbox.ts";
import {
  type EnvironmentSummary,
  environmentSummary,
  sortConsidered,
} from "../lib/taskEnvironment.ts";
import { useNow } from "../lib/useNow.ts";
import { ModeBadge } from "./ModeBadge.tsx";
import { SandboxFallbackCard } from "./SandboxFallbackCard.tsx";
import { SandboxStateBadge } from "./StatusBadge.tsx";
import { Badge, Button, Card, Dot, ErrorText, Spinner } from "./ui.tsx";

const STATE: Record<
  TaskState,
  { label: string; tone: "neutral" | "ok" | "warn" | "danger" | "accent" }
> = {
  queued: { label: "Queued", tone: "neutral" },
  dispatched: { label: "Starting", tone: "accent" },
  running: { label: "Running", tone: "accent" },
  succeeded: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  rejected: { label: "Refused by machine", tone: "danger" },
  interrupted: { label: "Interrupted", tone: "warn" },
};

const ACTION_LABEL: Record<string, string> = {
  push: "Push branch",
  open_pr: "Open pull request",
  merge: "Merge",
  deploy: "Deploy",
};

const ACTION_STATE: Record<ActionView["state"], string> = {
  awaiting_approval: "Waiting for approval",
  ready: "Ready",
  sent: "In progress",
  succeeded: "Done",
  failed: "Failed",
  refused: "Refused by machine",
  rejected: "Rejected",
  expired: "Approval expired",
  skipped: "Skipped",
};

export function TaskStateBadge({ task }: { task: TaskView }) {
  const s = STATE[task.state];
  const busy = task.state === "running" || task.state === "dispatched";
  return (
    <span className="inline-flex items-center gap-1.5">
      {busy && <Spinner className="size-3 text-accent" />}
      <Badge tone={s.tone}>{task.cancelRequested && busy ? "Cancelling" : s.label}</Badge>
    </span>
  );
}

export function TaskCard({ task, compact }: { task: TaskView; compact?: boolean }) {
  const awaiting = task.actions.filter((a) => a.state === "awaiting_approval");
  const active = task.state === "queued" || task.state === "dispatched" || task.state === "running";
  const now = useNow(1000, task.state === "running" && !task.finishedAt);
  const ran = task.startedAt ? between(task.startedAt, task.finishedAt, now) : null;

  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      api.post(`/api/tasks/${task.id}/approval`, { decision }),
  });
  const cancel = useMutation({ mutationFn: () => api.post(`/api/tasks/${task.id}/cancel`) });
  // Only a task with no machine yet can be waiting on a fallback approval.
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<ApprovalView[]>("/api/approvals"),
    enabled: task.runnerId === null,
  });
  const fallback = task.runnerId === null ? pendingFallbackFor(approvals.data, task.id) : undefined;
  if (fallback) return <SandboxFallbackCard approval={fallback} />;

  return (
    <Card className="overflow-hidden">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium tracking-wide text-muted uppercase">
            {HARNESS_LABELS[task.harness] ?? task.harness} task
          </span>
          <TaskStateBadge task={task} />
          <ModeBadge mode={task.mode} />
          {task.runnerOffline && <Badge tone="warn">Machine offline</Badge>}
        </div>
        <div>
          <Link
            to="/tasks/$id"
            params={{ id: task.id }}
            className="font-medium hover:underline hover:underline-offset-2"
          >
            {task.title}
          </Link>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span>{task.repoName}</span>
            <EnvironmentBadge summary={environmentSummary(task)} />
            {ran !== null && (
              <span className="tabular-nums">
                {task.finishedAt ? "ran" : "running"} {duration(ran)}
              </span>
            )}
            {task.branch && <code className="font-mono text-xs">{task.branch}</code>}
          </p>
        </div>
        {task.routing && <WhyHere routing={task.routing} />}

        {task.diffStats && (
          <p className="text-sm">
            {plural(task.diffStats.filesChanged, "file")} changed,{" "}
            <span className="text-ok">+{task.diffStats.insertions}</span>{" "}
            <span className="text-danger">-{task.diffStats.deletions}</span>
            {task.commitSha && (
              <span className="text-muted"> · commit {shortSha(task.commitSha)}</span>
            )}
          </p>
        )}
        {!compact && task.summary && (
          <p className="text-sm whitespace-pre-wrap text-muted">{task.summary}</p>
        )}
        {task.error && <p className="text-sm text-danger">{task.error}</p>}

        {task.actions.length > 0 && (
          <ol className="space-y-1.5 border-t border-border pt-3">
            {task.actions.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-36 shrink-0">{ACTION_LABEL[a.kind] ?? a.kind}</span>
                <ActionStateText action={a} />
                {a.url && (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline underline-offset-2"
                  >
                    {a.kind === "open_pr" && a.url.includes("/pull/") ? "View PR" : "Open link"}
                  </a>
                )}
                {a.message && a.state !== "succeeded" && (
                  <span className="w-full text-xs text-muted sm:w-auto">{a.message}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      {(awaiting.length > 0 || active) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface-2/50 px-4 py-3">
          {awaiting.length > 0 && (
            <>
              <span className="mr-auto text-sm">
                Approve {awaiting.map((a) => ACTION_LABEL[a.kind]?.toLowerCase()).join(" and ")}?
              </span>
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
            </>
          )}
          {active && awaiting.length === 0 && (
            <Button
              size="sm"
              variant="danger"
              className="ml-auto"
              busy={cancel.isPending}
              disabled={task.cancelRequested}
              onClick={() => cancel.mutate()}
            >
              Cancel task
            </Button>
          )}
          <ErrorText error={decide.error ?? cancel.error} />
        </div>
      )}
    </Card>
  );
}

/** Where the task runs. A sandbox links to the Sandboxes page, where it can be destroyed. */
function EnvironmentBadge({ summary }: { summary: EnvironmentSummary }) {
  switch (summary.kind) {
    case "machine":
      return <Badge>{summary.text}</Badge>;
    case "sandbox":
      return (
        <Link
          to="/sandboxes"
          title="See it on the Sandboxes page"
          className="inline-flex items-center gap-1 hover:opacity-80"
        >
          <Badge tone="accent">{summary.text}</Badge>
          <SandboxStateBadge state={summary.state} />
        </Link>
      );
    case "waiting":
      return <Badge tone="warn">{summary.text}</Badge>;
    case "none":
      return <Badge>{summary.text}</Badge>;
  }
}

function WhyHere({ routing }: { routing: RoutingView }) {
  const picked = routing.target?.kind === "machine" ? routing.target.runnerId : null;
  return (
    <details className="rounded-lg border border-border px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Why here?</summary>
      <p className="mt-2">{routing.reason}</p>
      {routing.considered.length > 0 && (
        <ul aria-label="Machines considered" className="mt-2 space-y-1">
          {sortConsidered(routing.considered).map((c) => (
            <li key={c.runnerId} className="flex flex-wrap items-center gap-x-2">
              <Dot tone={c.eligible ? "ok" : "neutral"} />
              <span className="font-medium">{c.runnerName}</span>
              {c.runnerId === picked && <Badge tone="accent">picked</Badge>}
              <span className="text-muted">
                {c.eligible ? "Eligible." : "Not eligible."} {c.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function ActionStateText({ action }: { action: ActionView }) {
  const tone =
    action.state === "succeeded"
      ? "text-ok"
      : action.state === "awaiting_approval"
        ? "text-warn"
        : ["failed", "refused", "rejected", "expired"].includes(action.state)
          ? "text-danger"
          : "text-muted";
  return (
    <span className={`inline-flex items-center gap-1.5 ${tone}`}>
      {action.state === "sent" && <Spinner className="size-3" />}
      {ACTION_STATE[action.state]}
    </span>
  );
}
