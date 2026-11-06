import {
  type ActionView,
  type ApprovalView,
  effortLabel,
  HARNESS_LABELS,
  type PermissionMode,
  type RoutingView,
  type RunnerView,
  type TaskEventView,
  type TaskState,
  type TaskView,
  type VerifyDetail,
} from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowRight,
  Check,
  Clock,
  ExternalLink,
  FilePen,
  FolderGit2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  Rocket,
  SquareTerminal,
  Upload,
  X,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { api } from "../lib/api.ts";
import {
  awaitsDeployApproval,
  canDeployLater,
  deployApi,
  deployPlan,
  isDeployStep,
  targetForTask,
  taskRepo,
  useDeployTargets,
} from "../lib/deploys.ts";
import { between, duration, plural, shortSha } from "../lib/format.ts";
import { agentModels, useModelCatalog } from "../lib/models.ts";
import { apply } from "../lib/realtime.ts";
import { pendingFallbackFor } from "../lib/sandbox.ts";
import {
  type EnvironmentSummary,
  environmentSummary,
  sortConsidered,
} from "../lib/taskEnvironment.ts";
import type { TaskDetail } from "../lib/types.ts";
import { useNow } from "../lib/useNow.ts";
import { CheckList, DeployPlanText } from "./DeployBits.tsx";
import { ModeBadge } from "./ModeBadge.tsx";
import { SandboxFallbackCard } from "./SandboxFallbackCard.tsx";
import { SandboxStateBadge } from "./StatusBadge.tsx";
import {
  Badge,
  Button,
  Card,
  CardFooter,
  cx,
  Dot,
  ErrorText,
  Mono,
  Skeleton,
  Spinner,
  type Tone,
} from "./ui.tsx";

const STATE: Record<TaskState, { label: string; tone: Tone }> = {
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
  verify: "Check the site",
};

const ACTION_ICON = {
  push: Upload,
  open_pr: GitPullRequest,
  merge: GitMerge,
  deploy: Rocket,
  verify: Activity,
} as Record<string, typeof Upload>;

const ACTION_STATE: Record<ActionView["state"], string> = {
  queued: "Not started",
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
    <Badge tone={s.tone} dot={!busy}>
      {busy && <LoaderCircle aria-hidden="true" size={12} className="animate-spin" />}
      {task.cancelRequested && busy ? "Cancelling" : s.label}
    </Badge>
  );
}

export function TaskCard({
  task,
  compact,
  stateInHeader,
  conversationMode,
}: {
  task: TaskView;
  /** In the chat: the agent's latest steps instead of its full summary. */
  compact?: boolean;
  /** The page header already shows the task's state. */
  stateInHeader?: boolean;
  /** The mode the chat shows already. The card names the task's only when it differs. */
  conversationMode?: PermissionMode;
}) {
  const awaiting = task.actions.filter((a) => a.state === "awaiting_approval");
  const catalog = useModelCatalog();
  const modelLabel = task.model
    ? (agentModels(catalog.data, task.harness)?.models.find((m) => m.id === task.model)?.label ??
      task.model)
    : null;
  const active = task.state === "queued" || task.state === "dispatched" || task.state === "running";
  const running = task.state === "running" && !task.finishedAt;
  const now = useNow(1000, running);
  const ran =
    task.startedAt && (task.finishedAt || running)
      ? between(task.startedAt, task.finishedAt, now)
      : null;

  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      api.post(`/api/tasks/${task.id}/approval`, { decision }),
  });
  const cancel = useMutation({ mutationFn: () => api.post(`/api/tasks/${task.id}/cancel`) });
  const deploy = useMutation({
    mutationFn: () => deployApi.deployTask(task.id),
    onSuccess: (next) => {
      if (next && typeof next === "object" && "actions" in next) {
        apply(qc, { type: "task.updated", task: next });
      }
    },
  });
  // Only a deploy approval or a delivered PR needs to know the repo's target.
  const deployApproval = awaitsDeployApproval(task);
  const deployLater = canDeployLater(task) && !deploy.isSuccess;
  const wantsTarget = deployApproval || deployLater;
  const targets = useDeployTargets(wantsTarget);
  const runners = useQuery({
    queryKey: ["runners"],
    queryFn: () => api.get<RunnerView[]>("/api/runners"),
    enabled: wantsTarget,
  });
  const target = wantsTarget ? targetForTask(task, targets.data, runners.data) : undefined;
  const targetName = target?.name ?? task.actions.find((a) => a.targetName)?.targetName;
  // Only a task with no machine yet can be waiting on a fallback approval.
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<ApprovalView[]>("/api/approvals"),
    enabled: task.runnerId === null,
  });
  const fallback = task.runnerId === null ? pendingFallbackFor(approvals.data, task.id) : undefined;
  if (fallback) return <SandboxFallbackCard approval={fallback} />;

  const agent = [
    `${HARNESS_LABELS[task.harness] ?? task.harness} task`,
    modelLabel,
    task.effort && effortLabel(task.effort),
  ]
    .filter(Boolean)
    .join(" · ");
  const showMode = conversationMode === undefined || conversationMode !== task.mode;

  return (
    <Card className="overflow-hidden">
      <div className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-surface-3 text-soft shadow-active"
          >
            <SquareTerminal size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <Link
                to="/tasks/$id"
                params={{ id: task.id }}
                className="min-w-0 flex-1 text-sm leading-5 font-medium decoration-faint underline-offset-2 hover:underline"
              >
                {task.title}
              </Link>
              <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {task.runnerOffline && <Badge tone="warn">Machine offline</Badge>}
                {showMode && <ModeBadge mode={task.mode} />}
                {!stateInHeader && <TaskStateBadge task={task} />}
              </span>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span className="inline-flex items-center gap-1">
                {agent}
                {task.fast && <Zap aria-label="Fast" size={12} className="text-warn" />}
              </span>
              <span className="inline-flex items-center gap-1">
                <FolderGit2 aria-hidden="true" size={12} className="text-subtle" />
                {task.repoName}
              </span>
              <EnvironmentBadge
                summary={environmentSummary(task)}
                reason={task.routing?.reason ?? null}
              />
              {ran !== null && (
                <span className="tabular inline-flex items-center gap-1">
                  <Clock aria-hidden="true" size={12} className="text-subtle" />
                  {task.finishedAt ? "ran" : "running"} {duration(ran)}
                </span>
              )}
              {task.branch && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <GitBranch aria-hidden="true" size={12} className="text-subtle" />
                  <Mono className="truncate">{task.branch}</Mono>
                </span>
              )}
            </p>
          </div>
        </div>
        {!compact && task.routing && <WhyHere routing={task.routing} />}
        {compact && task.routing && !task.runnerName && (
          <p className="text-[13px] text-muted">{task.routing.reason}</p>
        )}

        {compact && active && <TaskActivity task={task} />}

        {task.diffStats && (
          <p className="tabular text-[13px]">
            {plural(task.diffStats.filesChanged, "file")} changed,{" "}
            <span className="text-ok">+{task.diffStats.insertions}</span>{" "}
            <span className="text-danger">-{task.diffStats.deletions}</span>
            {task.commitSha && (
              <span className="text-muted"> · commit {shortSha(task.commitSha)}</span>
            )}
          </p>
        )}
        {task.summary && (
          <p
            className={cx(
              "text-[13px] leading-5 whitespace-pre-wrap text-soft",
              compact && "line-clamp-6",
            )}
          >
            {task.summary}
          </p>
        )}
        {task.error && <p className="text-[13px] text-danger">{task.error}</p>}

        {task.actions.length > 0 && (
          <ol aria-label="Steps after the task" className="space-y-1 border-t border-border pt-3">
            {task.actions.map((a) => (
              <StepRow
                key={a.id}
                action={a}
                prUrl={task.actions.find((x) => x.kind === "open_pr")?.url ?? null}
              />
            ))}
          </ol>
        )}
      </div>

      {deployApproval && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3">
          <div className="min-w-0 flex-1 basis-64">
            <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
              <Rocket aria-hidden="true" size={13} className="shrink-0 text-subtle" />
              Approve deployment?
              {targetName && <span className="truncate font-normal text-muted">{targetName}</span>}
            </p>
            {targets.isPending ? (
              <Skeleton className="mt-1.5 h-3 w-4/5" />
            ) : (
              <p className="mt-0.5 text-xs leading-[18px] text-muted">
                <DeployPlanText
                  plan={deployPlan({
                    prUrl: task.actions.find((a) => a.kind === "open_pr")?.url ?? null,
                    branch: task.branch,
                    defaultBranch: taskRepo(task, runners.data)?.defaultBranch ?? null,
                    target,
                  })}
                />
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
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
          <ErrorText error={decide.error} />
        </div>
      )}

      {((awaiting.length > 0 && !deployApproval) ||
        active ||
        compact ||
        (deployLater && target)) && (
        <CardFooter>
          {compact && (
            <Link
              to="/tasks/$id"
              params={{ id: task.id }}
              className="mr-auto inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-text"
            >
              Open task
              <ArrowRight aria-hidden="true" size={12} />
            </Link>
          )}
          {awaiting.length > 0 && !deployApproval && (
            <>
              <span className={cx("text-[13px]", !compact && "mr-auto")}>
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
          {deployLater && target && (
            <Button
              size="sm"
              icon={Rocket}
              title={`Merge the PR, deploy it to ${target.name}, and check the site`}
              busy={deploy.isPending}
              onClick={() => deploy.mutate()}
            >
              Deploy
            </Button>
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
          <ErrorText
            error={(deployApproval ? null : decide.error) ?? cancel.error ?? deploy.error}
          />
        </CardFooter>
      )}
    </Card>
  );
}

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One line of what the agent did: a command, files it touched, or what it said. */
function activityLine(e: TaskEventView): { key: string; icon: ReactNode; text: ReactNode } | null {
  const p = e.payload as P;
  switch (e.type) {
    case "command": {
      const status = str(p.status);
      return {
        key: `cmd:${str(p.itemId) || e.seq}`,
        icon:
          status === "started" ? (
            <Spinner className="size-3" />
          ) : status === "failed" ? (
            <X aria-hidden="true" size={12} className="text-danger" />
          ) : (
            <Check aria-hidden="true" size={12} className="text-subtle" />
          ),
        text: <Mono className="truncate">{str(p.command)}</Mono>,
      };
    }
    case "file_change": {
      const changes = (p.changes as { path: string }[] | undefined) ?? [];
      return {
        key: `files:${e.seq}`,
        icon: <FilePen aria-hidden="true" size={12} className="text-subtle" />,
        text: (
          <span className="truncate">
            Edited {changes.map((c) => c.path.split("/").at(-1)).join(", ")}
          </span>
        ),
      };
    }
    case "agent_message":
      return {
        key: `msg:${e.seq}`,
        icon: <MessageSquare aria-hidden="true" size={12} className="text-subtle" />,
        text: <span className="truncate">{str(p.text).split("\n")[0]}</span>,
      };
    default:
      return null;
  }
}

/** The agent's latest steps, live, for a running task's card in the chat. */
function TaskActivity({ task }: { task: TaskView }) {
  const detail = useQuery({
    queryKey: ["task", task.id],
    queryFn: () => api.get<TaskDetail>(`/api/tasks/${task.id}`),
  });
  const lines = new Map<string, NonNullable<ReturnType<typeof activityLine>>>();
  for (const e of detail.data?.events ?? []) {
    const line = activityLine(e);
    // A command's result replaces its start, in the start's place.
    if (line) lines.set(line.key, line);
  }
  const latest = [...lines.values()].slice(-4);
  if (latest.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <Spinner className="size-3" />
        <span className="text-shimmer">
          {task.state === "queued" ? "Waiting to start" : "Starting"}
        </span>
      </p>
    );
  }
  return (
    <ol
      aria-label="Latest steps"
      className="space-y-1 rounded-lg bg-field px-2.5 py-2 text-xs text-soft shadow-field"
    >
      {latest.map((l) => (
        <li key={l.key} className="flex min-w-0 items-center gap-2">
          <span className="grid w-3 shrink-0 place-items-center">{l.icon}</span>
          {l.text}
        </li>
      ))}
    </ol>
  );
}

/**
 * Where the task runs. A sandbox links to the Sandboxes page, where it can be
 * destroyed. Why it went there shows on hover.
 */
function EnvironmentBadge({
  summary,
  reason,
}: {
  summary: EnvironmentSummary;
  reason: string | null;
}) {
  switch (summary.kind) {
    case "machine":
      return <span title={reason ?? undefined}>{summary.text}</span>;
    case "sandbox":
      return (
        <Link
          to="/sandboxes"
          title="See it on the Sandboxes page"
          className="inline-flex items-center gap-1.5 hover:text-text"
        >
          {summary.text}
          <SandboxStateBadge state={summary.state} />
        </Link>
      );
    case "waiting":
      return <span className="text-warn">{summary.text}</span>;
    case "none":
      return <span>{summary.text}</span>;
  }
}

/**
 * Why the router picked where the task runs, on the Task page. The machines
 * it compared show only when there was more than one, since with one the
 * reason already says it all.
 */
function WhyHere({ routing }: { routing: RoutingView }) {
  const picked = routing.target?.kind === "machine" ? routing.target.runnerId : null;
  if (routing.considered.length < 2) {
    return <p className="text-[13px] text-muted">{routing.reason}</p>;
  }
  return (
    <details className="group rounded-lg bg-surface-2 px-3 py-2 text-[13px] shadow-raised">
      <summary className="cursor-pointer text-xs font-medium text-soft select-none marker:text-subtle">
        Why here?
      </summary>
      <p className="mt-2 text-soft">{routing.reason}</p>
      <ul aria-label="Machines considered" className="mt-2 space-y-1">
        {sortConsidered(routing.considered).map((c) => (
          <li key={c.runnerId} className="flex flex-wrap items-center gap-x-2 text-xs">
            <Dot tone={c.eligible ? "ok" : "neutral"} />
            <span className="font-medium text-text">{c.runnerName}</span>
            {c.runnerId === picked && <Badge tone="accent">picked</Badge>}
            <span className="text-muted">
              {c.eligible ? "Eligible." : "Not eligible."} {c.reason}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A step's state, colored by how it went. */
export function ActionStateText({ state }: { state: ActionView["state"] }) {
  const tone =
    state === "succeeded"
      ? "text-ok"
      : state === "awaiting_approval"
        ? "text-warn"
        : ["failed", "refused", "rejected", "expired"].includes(state)
          ? "text-danger"
          : "text-muted";
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${tone}`}>
      {state === "sent" && <Spinner className="size-3" />}
      {ACTION_STATE[state]}
    </span>
  );
}

function linkLabel(url: string): string {
  if (url.includes("/pull/") || url.includes("/merge_requests/")) return "View PR";
  if (url.includes("/commit/")) return "View commit";
  return "Open link";
}

/**
 * One step after the task: its state and where it ran, then what it left
 * behind. A merge shows its commit, a deploy its command's output, and the
 * site check what each check saw.
 */
function StepRow({ action: a, prUrl }: { action: ActionView; prUrl: string | null }) {
  const Icon = ACTION_ICON[a.kind] ?? Upload;
  // A deploy's steps say useful things when they work too, such as a hook's answer.
  const showMessage = a.message && (a.state !== "succeeded" || isDeployStep(a));
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
      <span className="flex w-40 shrink-0 items-center gap-2">
        <Icon aria-hidden="true" className="text-subtle" />
        {ACTION_LABEL[a.kind] ?? a.kind}
      </span>
      <ActionStateText state={a.state} />
      {a.ranOn && (
        <span className="text-xs text-muted">
          {a.ranOn === "Sling" ? "by Sling" : `on ${a.ranOn}`}
        </span>
      )}
      {a.kind === "merge" && a.commitSha && (
        <span className="text-xs text-muted">
          commit <Mono>{shortSha(a.commitSha)}</Mono>
        </span>
      )}
      {/* A merge links to the PR the step above it already links to. */}
      {a.url && (a.kind === "open_pr" || a.url !== prUrl) && (
        <a
          href={a.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline"
        >
          {linkLabel(a.url)}
          <ExternalLink aria-hidden="true" size={12} />
        </a>
      )}
      {showMessage && <span className="w-full pl-6 text-xs text-muted">{a.message}</span>}
      {a.kind === "deploy" && a.output && (
        <details className="w-full pl-6">
          <summary className="w-fit cursor-pointer text-xs font-medium text-muted select-none marker:text-subtle hover:text-soft">
            Output
          </summary>
          <pre className="mt-1.5 max-h-80 overflow-auto rounded-lg bg-field px-3 py-2 font-mono text-[11.5px] leading-[17px] break-words whitespace-pre-wrap text-soft shadow-field">
            {a.output}
          </pre>
        </details>
      )}
      {a.kind === "verify" && a.verify && (
        <VerifyResult verify={a.verify} commitSha={a.commitSha} running={a.state === "sent"} />
      )}
    </li>
  );
}

function VerifyResult({
  verify: v,
  commitSha,
  running,
}: {
  verify: VerifyDetail;
  commitSha: string | null;
  running: boolean;
}) {
  const took = v.finishedAt ? between(v.startedAt, v.finishedAt) : null;
  const commit = commitSha ? <Mono>{shortSha(commitSha)}</Mono> : "the merged commit";
  return (
    <div className="w-full space-y-1 pt-0.5 pl-6">
      <CheckList checks={v.checks} results={v.checks} label="What the checks saw" />
      {v.versionSeen !== null && (
        <p className="flex items-center gap-2 text-xs">
          <Dot tone={v.versionSeen ? "ok" : running ? "neutral" : "danger"} />
          <span className="text-soft">
            {v.versionSeen
              ? "The version URL shows "
              : running
                ? "Waiting for the version URL to show "
                : "The version URL never showed "}
            {commit}
          </span>
        </p>
      )}
      <p className="tabular text-xs text-subtle">
        {running ? `Attempt ${v.attempts}` : plural(v.attempts, "attempt")}
        {took !== null ? ` over ${duration(took)}` : ""}
      </p>
    </div>
  );
}
