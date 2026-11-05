import type { ActionView, TaskState, TaskView } from "@sling/core";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api.ts";
import { plural, shortSha } from "../lib/format.ts";
import { ModeBadge } from "./ModeBadge.tsx";
import { Badge, Button, Card, ErrorText, Spinner } from "./ui.tsx";

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

  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      api.post(`/api/tasks/${task.id}/approval`, { decision }),
  });
  const cancel = useMutation({ mutationFn: () => api.post(`/api/tasks/${task.id}/cancel`) });

  return (
    <Card className="overflow-hidden">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium tracking-wide text-muted uppercase">Codex task</span>
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
          <p className="mt-0.5 text-sm text-muted">
            {task.repoName} on {task.runnerName}
            {task.branch && (
              <>
                {" · "}
                <code className="font-mono text-xs">{task.branch}</code>
              </>
            )}
          </p>
        </div>

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
