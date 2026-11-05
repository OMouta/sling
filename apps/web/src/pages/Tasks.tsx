import {
  HARNESS_LABELS,
  HARNESSES,
  type Harness,
  type TaskState,
  type TaskView,
} from "@sling/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Bot, Box, CircleDot, ListChecks, Plus } from "lucide-react";
import { useState } from "react";
import { ModeBadge } from "../components/ModeBadge.tsx";
import { Page, StatsBar, Toolbar } from "../components/Page.tsx";
import { TaskStateBadge } from "../components/TaskCard.tsx";
import {
  Avatar,
  Button,
  Empty,
  ErrorText,
  FilterSelect,
  Skeleton,
  Table,
  Tabs,
  Td,
  Th,
  Tr,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ago, between, duration } from "../lib/format.ts";
import { environmentSummary } from "../lib/taskEnvironment.ts";

type View = "all" | "active" | "attention" | "done";

const ACTIVE: ReadonlySet<TaskState> = new Set(["queued", "dispatched", "running"]);
const PROBLEM: ReadonlySet<TaskState> = new Set(["failed", "rejected", "interrupted"]);

function needsAttention(t: TaskView): boolean {
  return PROBLEM.has(t.state) || t.actions.some((a) => a.state === "awaiting_approval");
}

const VIEWS: Record<View, (t: TaskView) => boolean> = {
  all: () => true,
  active: (t) => ACTIVE.has(t.state),
  attention: needsAttention,
  done: (t) => t.state === "succeeded",
};

export function TasksPage() {
  const navigate = useNavigate();
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: () => api.get<TaskView[]>("/api/tasks"),
  });
  const [view, setView] = useState<View>("all");
  const [agent, setAgent] = useState<Harness | "any">("any");
  const [where, setWhere] = useState<"any" | "machine" | "sandbox">("any");

  const all = tasks.data ?? [];
  const rows = all.filter(
    (t) =>
      VIEWS[view](t) &&
      (agent === "any" || t.harness === agent) &&
      (where === "any" || t.environment.kind === where),
  );
  const count = (v: View) => all.filter(VIEWS[v]).length;
  const added = rows.reduce((n, t) => n + (t.diffStats?.insertions ?? 0), 0);
  const removed = rows.reduce((n, t) => n + (t.diffStats?.deletions ?? 0), 0);
  const finished = rows.filter((t) => t.state === "succeeded" || t.state === "failed");
  const successRate = finished.length
    ? Math.round((finished.filter((t) => t.state === "succeeded").length / finished.length) * 100)
    : null;

  return (
    <Page
      title="Tasks"
      badge={
        count("active") > 0 ? (
          <span className="tabular text-xs text-subtle">{count("active")} running</span>
        ) : undefined
      }
      tabs={
        <Tabs
          value={view}
          onChange={setView}
          tabs={[
            { id: "all", label: "All tasks" },
            { id: "active", label: "Running", count: count("active") },
            { id: "attention", label: "Needs attention", count: count("attention") },
            { id: "done", label: "Done" },
          ]}
        />
      }
      toolbar={
        <Toolbar
          actions={
            <Button variant="primary" icon={Plus} onClick={() => void navigate({ to: "/" })}>
              New task
            </Button>
          }
        >
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
        rows.length > 0 && (
          <StatsBar
            items={[
              <>
                <span className="text-text">{rows.length}</span> tasks in view
              </>,
              <>
                <span className="text-ok">+{added.toLocaleString()}</span>
                <span className="text-danger">-{removed.toLocaleString()}</span> lines
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
        <Empty
          fill
          icon={ListChecks}
          title={all.length === 0 ? "No tasks yet" : "No tasks match"}
          action={
            all.length === 0 && (
              <Button variant="primary" icon={Plus} onClick={() => void navigate({ to: "/" })}>
                Start one from chat
              </Button>
            )
          }
        >
          {all.length === 0
            ? "Ask the assistant for a change and it starts a task on one of your machines."
            : "Try another tab or filter."}
        </Empty>
      ) : (
        <Table className="border-t border-border">
          <thead>
            <tr>
              <Th>Task</Th>
              <Th>Status</Th>
              <Th>Agent</Th>
              <Th>Runs on</Th>
              <Th>Mode</Th>
              <Th align="right">Changes</Th>
              <Th align="right">Duration</Th>
              <Th align="right">Started</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                onOpen={() => void navigate({ to: "/tasks/$id", params: { id: t.id } })}
              />
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}

function TaskRow({ task: t, onOpen }: { task: TaskView; onOpen: () => void }) {
  const env = environmentSummary(t);
  const ran = between(t.startedAt, t.finishedAt);
  const awaiting = t.actions.some((a) => a.state === "awaiting_approval");
  return (
    <Tr onClick={onOpen}>
      <Td className="max-w-[380px]">
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
          <span className="shrink-0 text-xs text-subtle">{t.repoName}</span>
        </div>
      </Td>
      <Td>
        <TaskStateBadge task={t} />
      </Td>
      <Td className="text-[13px] text-soft">{HARNESS_LABELS[t.harness] ?? t.harness}</Td>
      <Td>
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
      <Td>
        <ModeBadge mode={t.mode} />
      </Td>
      <Td align="right" className="text-[13px]">
        {t.diffStats ? (
          <>
            <span className="text-ok">+{t.diffStats.insertions}</span>{" "}
            <span className="text-danger">-{t.diffStats.deletions}</span>
          </>
        ) : (
          <span className="text-faint">–</span>
        )}
      </Td>
      <Td align="right" className="text-[13px] text-soft">
        {ran !== null ? duration(ran) : <span className="text-faint">–</span>}
      </Td>
      <Td align="right" className="text-[13px] text-muted">
        {ago(t.createdAt)}
      </Td>
    </Tr>
  );
}
