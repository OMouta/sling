import {
  HARNESS_LABELS,
  HARNESSES,
  type Harness,
  type TaskListView,
  type TaskView,
} from "@sling/core";
import { Link, useNavigate } from "@tanstack/react-router";
import { Bot, Box, CircleDot, ListChecks } from "lucide-react";
import { useMemo, useState } from "react";
import { ModeBadge } from "../components/ModeBadge.tsx";
import { Page, StatsBar, Toolbar } from "../components/Page.tsx";
import { TaskStateBadge } from "../components/TaskCard.tsx";
import {
  Avatar,
  Empty,
  ErrorText,
  FilterSelect,
  Skeleton,
  Spinner,
  Table,
  Tabs,
  Td,
  Th,
  Tr,
} from "../components/ui.tsx";
import { ago, between, duration } from "../lib/format.ts";
import { useLoadMore, useStickyCounts } from "../lib/pages.ts";
import { environmentSummary } from "../lib/taskEnvironment.ts";
import { useTaskList } from "../lib/tasks.ts";
import { useNow } from "../lib/useNow.ts";

export function TasksPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<TaskListView>("all");
  const [agent, setAgent] = useState<Harness | "any">("any");
  const [where, setWhere] = useState<"any" | "machine" | "sandbox">("any");
  const tasks = useTaskList({ view, harness: agent, environment: where });
  const pages = tasks.data?.pages;
  const rows = useMemo(() => pages?.flatMap((p) => p.items) ?? [], [pages]);
  const counts = useStickyCounts(pages?.[0]?.counts);
  // Totals over every task the filters match, not only the pages loaded.
  const stats = pages?.[0]?.stats;
  const finished = (stats?.succeeded ?? 0) + (stats?.failed ?? 0);
  // A rate over a handful of tasks says little.
  const successRate =
    stats && finished >= 5 ? Math.round((stats.succeeded / finished) * 100) : null;
  const filtered = view !== "all" || agent !== "any" || where !== "any";
  const end = useLoadMore(tasks);
  // A running task's duration counts up, and "Started" moves on by itself.
  const running = rows.some(isRunning);
  const now = useNow(running ? 1000 : 30_000, rows.length > 0);

  return (
    <Page
      title="Tasks"
      tabs={
        <Tabs
          value={view}
          onChange={setView}
          tabs={[
            { id: "all", label: "All tasks" },
            { id: "active", label: "Running", count: counts?.active },
            { id: "attention", label: "Needs attention", count: counts?.attention },
            { id: "done", label: "Done" },
          ]}
        />
      }
      toolbar={
        <Toolbar>
          <FilterSelect
            label="Agent"
            icon={Bot}
            value={agent}
            onChange={setAgent}
            options={[
              { value: "any", label: "Any" },
              ...HARNESSES.map((h) => ({ value: h, label: HARNESS_LABELS[h] })),
            ]}
          />
          <FilterSelect
            label="Runs on"
            icon={Box}
            value={where}
            onChange={setWhere}
            options={[
              { value: "any", label: "Anywhere" },
              { value: "machine", label: "My machines" },
              { value: "sandbox", label: "Sandboxes" },
            ]}
          />
        </Toolbar>
      }
      footer={
        stats &&
        stats.total > 0 && (
          <StatsBar
            items={[
              <>
                <span className="text-ok">+{stats.insertions.toLocaleString()}</span>
                <span className="text-danger">-{stats.deletions.toLocaleString()}</span> lines
              </>,
              successRate !== null && (
                <>
                  <span className="text-text">{successRate}%</span> succeeded
                </>
              ),
            ]}
          />
        )
      }
    >
      <ErrorText error={tasks.error} />
      {tasks.isPending ? (
        <div className="space-y-3 px-5 py-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Empty fill icon={ListChecks} title={filtered ? "No tasks match" : "No tasks yet"} />
      ) : (
        <Table className="border-t border-border">
          <thead>
            <tr>
              <Th>Task</Th>
              <Th>Status</Th>
              {/* A phone keeps the task and its status. */}
              <Th className="max-sm:hidden">Agent</Th>
              <Th className="max-sm:hidden">Runs on</Th>
              <Th className="max-sm:hidden">Mode</Th>
              <Th align="right" className="max-sm:hidden">
                Changes
              </Th>
              <Th align="right" className="max-sm:hidden">
                Duration
              </Th>
              <Th align="right" className="max-sm:hidden">
                Started
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                now={now}
                onOpen={() => void navigate({ to: "/tasks/$id", params: { id: t.id } })}
              />
            ))}
          </tbody>
        </Table>
      )}
      <div ref={end} aria-hidden="true" />
      {tasks.isFetchingNextPage && (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      )}
    </Page>
  );
}

function isRunning(t: TaskView): boolean {
  return t.state === "running" && !t.finishedAt;
}

function TaskRow({ task: t, now, onOpen }: { task: TaskView; now: number; onOpen: () => void }) {
  const env = environmentSummary(t);
  const ran = t.finishedAt || isRunning(t) ? between(t.startedAt, t.finishedAt, now) : null;
  const awaiting = t.actions.some((a) => a.state === "awaiting_approval");
  return (
    <Tr onClick={onOpen}>
      <Td className="max-w-[380px] max-sm:w-full max-sm:max-w-0">
        <div className="flex min-w-0 items-center gap-2.5">
          {awaiting && (
            <CircleDot aria-label="Waiting for approval" size={12} className="shrink-0 text-warn" />
          )}
          <Link
            to="/tasks/$id"
            params={{ id: t.id }}
            onClick={(e) => e.stopPropagation()}
            className="min-w-0 truncate"
          >
            {t.title}
          </Link>
          <span className="shrink-0 text-xs text-subtle max-sm:hidden">{t.repoName}</span>
        </div>
      </Td>
      <Td>
        <TaskStateBadge task={t} />
      </Td>
      <Td className="text-[13px] text-soft max-sm:hidden">
        {HARNESS_LABELS[t.harness] ?? t.harness}
      </Td>
      <Td className="max-sm:hidden">
        <span className="flex items-center gap-2 text-[13px] text-soft">
          {env.kind === "machine" && t.runnerName ? (
            <>
              <Avatar name={t.runnerName} />
              {t.runnerName}
            </>
          ) : (
            <span className={env.kind === "waiting" ? "text-warn" : "text-muted"}>{env.text}</span>
          )}
        </span>
      </Td>
      <Td className="max-sm:hidden">
        <ModeBadge mode={t.mode} />
      </Td>
      <Td align="right" className="text-[13px] max-sm:hidden">
        {t.diffStats ? (
          <>
            <span className="text-ok">+{t.diffStats.insertions}</span>{" "}
            <span className="text-danger">-{t.diffStats.deletions}</span>
          </>
        ) : (
          <span className="text-faint">–</span>
        )}
      </Td>
      <Td align="right" className="text-[13px] text-soft max-sm:hidden">
        {ran !== null ? duration(ran) : <span className="text-faint">–</span>}
      </Td>
      <Td align="right" className="text-[13px] text-muted max-sm:hidden">
        {ago(t.createdAt, now)}
      </Td>
    </Tr>
  );
}
