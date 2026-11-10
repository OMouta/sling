import { type Delivery, HARNESS_LABELS, type TaskView } from "@sling/core";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ScrollText } from "lucide-react";
import { Page } from "../components/Page.tsx";
import { TaskCard, TaskStateBadge } from "../components/TaskCard.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { Button, Card, Empty, ErrorText, Mono, Skeleton, Stat } from "../components/ui.tsx";
import { isDeployStep } from "../lib/deploys.ts";
import { between, dateTime, duration, shortSha } from "../lib/format.ts";
import { useEarlierEvents, useTaskDetail } from "../lib/tasks.ts";
import { taskRoute } from "../router.tsx";

const DELIVER: Record<Delivery, string> = {
  local: "A local commit",
  push: "A pushed branch",
  pr: "A pull request",
  deploy: "A deploy, checked",
};

/** What the task delivers, naming the deploy target once its steps know it. */
function Delivers({ task }: { task: TaskView }) {
  const name = task.actions.find((a) => a.targetName)?.targetName;
  const target = name ? (
    <Link to="/checks" className="decoration-faint underline-offset-2 hover:underline">
      {name}
    </Link>
  ) : null;
  if (task.deliver === "deploy") {
    return target ? <>A deploy to {target}, checked</> : DELIVER.deploy;
  }
  // Deployed later, from a delivered PR.
  if (task.actions.some(isDeployStep)) {
    return (
      <>
        {DELIVER[task.deliver]}, then a deploy{target ? <> to {target}</> : null}
      </>
    );
  }
  return DELIVER[task.deliver];
}

export function TaskPage() {
  const { id } = taskRoute.useParams();
  const detail = useTaskDetail(id);
  const earlier = useEarlierEvents(id);

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
  const { task, events, olderCursor } = detail.data;
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
                <Empty icon={ScrollText} title="No events yet" className="py-10" />
              </Card>
            ) : (
              <>
                {olderCursor != null && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="-ml-2.5"
                    busy={earlier.isPending}
                    onClick={() => earlier.mutate(olderCursor)}
                  >
                    Show earlier events
                  </Button>
                )}
                <ErrorText error={earlier.error} />
                <Timeline events={events} harness={task.harness} />
              </>
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
              <Stat label="Delivers">
                <Delivers task={task} />
              </Stat>
              {task.commitSha && (
                <Stat label="Commit">
                  <Mono>{shortSha(task.commitSha)}</Mono>
                </Stat>
              )}
              <Stat label="Created">{dateTime(task.createdAt)}</Stat>
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
