import type { CheckResultView, CheckView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ChevronRight,
  Ellipsis,
  Globe,
  Mail,
  Pause,
  Pencil,
  Play,
  Plus,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { CheckDialog } from "../components/CheckDialog.tsx";
import { CheckList, MethodLine } from "../components/DeployBits.tsx";
import { Page, Toolbar } from "../components/Page.tsx";
import { ActionStateText } from "../components/TaskCard.tsx";
import {
  Badge,
  Button,
  Card,
  cx,
  Dot,
  Empty,
  ErrorText,
  Menu,
  MenuItem,
  MenuSeparator,
  Mono,
  Skeleton,
  Spinner,
  useConfirm,
} from "../components/ui.tsx";
import {
  checkApi,
  deadlineText,
  forgetCheck,
  stateText,
  stateTone,
  upsertCheck,
  useCheckResults,
  useChecks,
  watchesText,
} from "../lib/checks.ts";
import { slowest } from "../lib/deploys.ts";
import { ago, duration, shortSha } from "../lib/format.ts";
import { useNow } from "../lib/useNow.ts";

type Editing = { check: CheckView | null } | null;

const KIND_ICON = { site: Globe, command: SquareTerminal, reply: Mail } as const;

export function ChecksPage() {
  const list = useChecks();
  const checks = list.data ?? [];
  const [editing, setEditing] = useState<Editing>(null);
  // "Checked 3 min ago" moves on by itself.
  const now = useNow(30_000, checks.length > 0);
  const watched = checks.filter((c) => c.enabled);
  const down = watched.filter((c) => c.state === "down" || c.state === "missed").length;
  const allUp =
    watched.length > 0 &&
    watched.every((c) => c.state === "up" || c.state === "met" || c.state === "waiting");
  const add = () => setEditing({ check: null });

  return (
    <Page
      title="Checks"
      badge={
        down > 0 ? (
          <Badge tone="danger" dot>
            {down} down
          </Badge>
        ) : allUp ? (
          <Badge tone="ok" dot>
            All good
          </Badge>
        ) : undefined
      }
      toolbar={
        // While nothing is watched, the empty state has the only Add check.
        list.data && checks.length === 0 ? undefined : (
          <Toolbar
            actions={
              <Button variant="primary" icon={Plus} onClick={add}>
                Add check
              </Button>
            }
          />
        )
      }
    >
      {editing && (
        <CheckDialog check={editing.check} checks={checks} onClose={() => setEditing(null)} />
      )}
      {list.data && checks.length === 0 ? (
        <Empty
          fill
          icon={Activity}
          title="Nothing watched yet"
          action={
            <Button variant="primary" icon={Plus} onClick={add}>
              Add check
            </Button>
          }
        />
      ) : (
        <div className="space-y-4 px-5 pt-1 pb-6">
          {list.isPending && <Skeleton className="h-[156px] w-full rounded-xl" />}
          <ErrorText error={list.error} />
          {checks.map((c) => (
            <CheckCard key={c.id} check={c} now={now} onEdit={() => setEditing({ check: c })} />
          ))}
        </div>
      )}
    </Page>
  );
}

function CheckCard({
  check: c,
  now,
  onEdit,
}: {
  check: CheckView;
  now: number;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const [history, setHistory] = useState(false);
  const run = useMutation({
    mutationFn: () => checkApi.run(c.id),
    onSuccess: (next) => upsertCheck(qc, next),
  });
  const toggle = useMutation({
    mutationFn: () => checkApi.update(c.id, { enabled: !c.enabled }),
    onSuccess: (next) => upsertCheck(qc, next),
  });
  const remove = useMutation({
    mutationFn: () => checkApi.remove(c.id),
    onSuccess: () => forgetCheck(qc, c.id),
  });
  const Icon = KIND_ICON[c.kind];
  const tone = run.isPending || !c.enabled ? "neutral" : stateTone(c.state);
  const r = c.lastResult;
  const siteResults = r?.detail.kind === "site" ? r.detail.checks : null;
  // One page says the same as the header, unless it's failing and has more to say.
  const pageRows =
    c.config.kind === "site" &&
    (c.config.checks.length > 1 || (siteResults ?? []).some((x) => !x.ok));

  return (
    <article aria-label={c.name}>
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <span className="relative grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised">
            <Icon aria-hidden="true" size={16} />
            <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-surface p-[2px]">
              <Dot tone={tone} pulse={run.isPending} />
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
              <span className="truncate font-medium">{c.name}</span>
              <Status check={c} now={now} running={run.isPending} />
            </p>
            <p className="mt-0.5 truncate text-xs text-subtle">
              {c.kind === "command" ? (
                <>
                  <Mono>{watchesText(c)}</Mono>
                  {c.runnerName ? ` on ${c.runnerName}` : ""}
                </>
              ) : (
                watchesText(c)
              )}
            </p>
          </div>
          <Menu
            label={`${c.name} actions`}
            trigger={({ open, toggle: t }) => (
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={Ellipsis}
                aria-label={`${c.name} actions`}
                aria-expanded={open}
                onClick={t}
              />
            )}
          >
            <MenuItem icon={Activity} onSelect={() => run.mutate()}>
              Check now
            </MenuItem>
            <MenuItem icon={Pencil} onSelect={onEdit}>
              Edit
            </MenuItem>
            <MenuItem icon={c.enabled ? Pause : Play} onSelect={() => toggle.mutate()}>
              {c.enabled ? "Pause" : "Resume"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={Trash2}
              danger
              onSelect={async () => {
                const ok = await confirm({
                  title: `Delete ${c.name}?`,
                  body: c.deploy
                    ? `Its history goes too, and tasks in ${c.deploy.remoteKey} can't deploy until you add it again.`
                    : "Its history goes too.",
                  action: "Delete",
                  danger: true,
                });
                if (ok) remove.mutate();
              }}
            >
              Delete
            </MenuItem>
          </Menu>
        </div>

        {c.deploy && (
          <dl className="grid gap-x-6 gap-y-2 border-t border-border px-4 py-2.5 text-xs sm:grid-cols-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <dt className="shrink-0 text-subtle">Deploys</dt>
              <dd className="min-w-0 text-soft">
                <MethodLine target={c.deploy} />
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-2">
              <dt className="shrink-0 text-subtle">Last deploy</dt>
              <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-soft">
                {c.deploy.lastDeploy ? (
                  <>
                    <Link
                      to="/tasks/$id"
                      params={{ id: c.deploy.lastDeploy.taskId }}
                      className="max-w-full truncate decoration-faint underline-offset-2 hover:underline"
                    >
                      {c.deploy.lastDeploy.taskTitle}
                    </Link>
                    {c.deploy.lastDeploy.commitSha && (
                      <Mono className="shrink-0">{shortSha(c.deploy.lastDeploy.commitSha)}</Mono>
                    )}
                    <span className="shrink-0">
                      <ActionStateText state={c.deploy.lastDeploy.state} />
                    </span>
                    <span className="shrink-0 text-muted">{ago(c.deploy.lastDeploy.at, now)}</span>
                  </>
                ) : (
                  <span className="text-muted">Never</span>
                )}
              </dd>
            </div>
          </dl>
        )}

        <div className="border-t border-border px-4 py-2.5">
          {c.config.kind === "site" ? (
            pageRows && (
              <CheckList checks={c.config.checks} results={siteResults} label={`${c.name} pages`} />
            )
          ) : (
            <p
              className={cx(
                "text-xs",
                r && !r.passed && c.state !== "waiting" ? "text-danger" : "text-muted",
              )}
            >
              {r
                ? r.message
                : c.kind === "reply" && c.deadline
                  ? `Due by ${deadlineText(c.deadline)}`
                  : "Not run yet"}
            </p>
          )}
          <button
            type="button"
            aria-expanded={history}
            onClick={() => setHistory((h) => !h)}
            className={cx(
              "-ml-1 inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1 text-xs text-muted transition-colors duration-150 hover:text-text",
              (c.config.kind !== "site" || pageRows) && "mt-1.5",
            )}
          >
            <ChevronRight
              aria-hidden="true"
              size={13}
              className={cx("transition-transform duration-150", history && "rotate-90")}
            />
            History
          </button>
          {history && <History check={c} now={now} />}
        </div>
        {(run.error || remove.error || toggle.error) && (
          <div className="px-4 pb-3">
            <ErrorText error={run.error ?? remove.error ?? toggle.error} />
          </div>
        )}
        {dialog}
      </Card>
    </article>
  );
}

/** Its state now, how fast, and when it last ran. */
function Status({ check: c, now, running }: { check: CheckView; now: number; running: boolean }) {
  if (running) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted">
        <Spinner className="size-3" />
        Checking
      </span>
    );
  }
  if (!c.enabled) return <span className="shrink-0 text-xs text-muted">Paused</span>;
  const r = c.lastResult;
  if (!r) return <span className="shrink-0 text-xs text-muted">Not checked yet</span>;
  const tone = stateTone(c.state);
  const ms = r.detail.kind === "site" ? slowest(r.detail.checks) : r.ms;
  const parts: string[] = [];
  if ((c.state === "up" || c.state === "unknown") && r.passed && c.kind === "site" && ms !== null) {
    parts.push(duration(ms));
  }
  if (c.failures > 1 && c.kind !== "reply") parts.push(`${c.failures} failures in a row`);
  if (c.state === "waiting" && c.deadline) parts.push(`due by ${deadlineText(c.deadline)}`);
  parts.push(`checked ${ago(r.at, now)}`);
  return (
    <span className="tabular min-w-0 text-xs text-muted">
      <span
        className={cx(
          "font-medium",
          tone === "ok" && "text-ok",
          tone === "danger" && "text-danger",
          c.state === "unknown" && !r.passed && "text-warn",
        )}
      >
        {c.state === "unknown" && !r.passed ? "Failing" : stateText(c.state, c.kind)}
      </span>
      {` · ${parts.join(" · ")}`}
    </span>
  );
}

/** The newest runs, newest first: a strip to scan, then each with its line. */
function History({ check, now }: { check: CheckView; now: number }) {
  const results = useCheckResults(check.id, true);
  if (results.isPending) return <Skeleton className="mt-2 h-16 w-full rounded-lg" />;
  if (results.error) return <ErrorText error={results.error} />;
  const list = results.data ?? [];
  if (list.length === 0) return <p className="mt-1 pl-5 text-xs text-muted">No runs yet</p>;
  return (
    <div className="mt-1.5 space-y-2 pl-5">
      <ol aria-label={`${check.name} recent runs`} className="flex h-5 items-end gap-[2px]">
        {list
          .slice(0, 48)
          .reverse()
          .map((r) => (
            <li
              key={r.id}
              title={`${new Date(r.at).toLocaleString()}: ${r.message}`}
              className={cx(
                "h-full w-1.5 rounded-[2px]",
                r.passed ? "bg-ok/70" : r.state === "waiting" ? "bg-surface-3" : "bg-danger/80",
              )}
            />
          ))}
      </ol>
      <ul aria-label={`${check.name} history`} className="max-h-56 space-y-1 overflow-y-auto">
        {list.slice(0, 20).map((r) => (
          <HistoryRow key={r.id} result={r} now={now} />
        ))}
      </ul>
    </div>
  );
}

function HistoryRow({ result: r, now }: { result: CheckResultView; now: number }) {
  return (
    <li className="flex min-w-0 items-baseline gap-2 text-xs">
      <Dot tone={r.passed ? "ok" : r.state === "waiting" ? "neutral" : "danger"} />
      <span className="tabular w-24 shrink-0 text-subtle" title={new Date(r.at).toLocaleString()}>
        {ago(r.at, now)}
      </span>
      <span className={cx("min-w-0 truncate", r.passed ? "text-soft" : "text-muted")}>
        {r.message}
      </span>
    </li>
  );
}
