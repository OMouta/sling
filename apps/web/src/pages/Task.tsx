import { type Delivery, HARNESS_LABELS } from "@sling/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ScrollText } from "lucide-react";
import { Page } from "../components/Page.tsx";
import { TaskCard, TaskStateBadge } from "../components/TaskCard.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { Card, Empty, ErrorText, Mono, Skeleton, Stat } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { between, duration, shortSha } from "../lib/format.ts";
import type { TaskDetail } from "../lib/types.ts";
import { taskRoute } from "../router.tsx";

const DELIVER: Record<Delivery, string> = {
  local: "A local commit",
  push: "A pushed branch",
  pr: "A pull request",
};

function when(iso: string | null): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TaskPage() {
  const { id } = taskRoute.useParams();
  const detail = useQuery({
    queryKey: ["task", id],
    queryFn: () => api.get<TaskDetail>(`/api/tasks/${id}`),
  });

  if (detail.isPending) {
    return (
      <Page title={<Skeleton className="h-4 w-56" />}>
        <div className="mx-auto max-w-5xl space-y-4 px-5 py-6">
          <Skeleton className="h-44 w-full rounded-xl" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </Page>
    );
  }
  if (!detail.data)
    return (
      <Page title="Task">
        <div className="p-5">
          <ErrorText error={detail.error ?? "Task not found."} />
        </div>
      </Page>
    );
  const { task, events } = detail.data;
  const ran = between(task.startedAt, task.finishedAt);

  return (
    <Page
      title={task.title}
      crumb={{ label: "Tasks", to: "/tasks" }}
      badge={<TaskStateBadge task={task} />}
      controls={
        task.conversationId && (
          <Link
            to="/c/$id"
            params={{ id: task.conversationId }}
            className="pressable flex h-[30px] items-center gap-1.5 rounded-full bg-surface-2 px-3 text-xs font-medium shadow-raised hover:shadow-raised-hover max-md:hidden"
          >
            <ArrowLeft aria-hidden="true" />
            Back to the conversation
          </Link>
        )
      }
    >
      <div className="mx-auto grid w-full max-w-5xl gap-6 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0 space-y-6">
          <TaskCard task={task} stateInHeader />
          <Card className="px-4 py-3">
            <details>
              <summary className="cursor-pointer text-[13px] font-medium select-none marker:text-subtle">
                What {HARNESS_LABELS[task.harness]} was asked
              </summary>
              <p className="mt-2 text-[13px] leading-5 whitespace-pre-wrap text-soft">
                {task.objective}
              </p>
            </details>
          </Card>
          <section className="space-y-3">
            <h2 className="section-label">Timeline</h2>
            {events.length === 0 ? (
              <Card>
                <Empty icon={ScrollText} title="No events yet" className="py-10">
                  The machine's progress shows up here as it works.
                </Empty>
              </Card>
            ) : (
              <Timeline events={events} harness={task.harness} />
            )}
          </section>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <Card className="p-4">
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-1">
              <Stat label="Agent">
                {HARNESS_LABELS[task.harness]}
                {task.harnessVersion ? ` ${task.harnessVersion}` : ""}
              </Stat>
              <Stat label="Delivers">{DELIVER[task.deliver]}</Stat>
              {task.commitSha && (
                <Stat label="Commit">
                  <Mono>{shortSha(task.commitSha)}</Mono>
                </Stat>
              )}
              <Stat label="Created">{when(task.createdAt)}</Stat>
              {ran !== null && (
                <Stat label={task.finishedAt ? "Ran for" : "Running for"}>
                  <span className="tabular">{duration(ran)}</span>
                </Stat>
              )}
            </dl>
          </Card>
        </aside>
      </div>
    </Page>
  );
}
