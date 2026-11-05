import { HARNESS_LABELS } from "@sling/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TaskCard } from "../components/TaskCard.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { Card, ErrorText, Spinner } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import type { TaskDetail } from "../lib/types.ts";
import { taskRoute } from "../router.tsx";

export function TaskPage() {
  const { id } = taskRoute.useParams();
  const detail = useQuery({
    queryKey: ["task", id],
    queryFn: () => api.get<TaskDetail>(`/api/tasks/${id}`),
  });

  if (detail.isPending) {
    return (
      <div className="grid h-full place-items-center text-muted">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (!detail.data)
    return (
      <div className="p-6">
        <ErrorText error={detail.error ?? "Task not found."} />
      </div>
    );
  const { task, events } = detail.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      {task.conversationId && (
        <Link
          to="/c/$id"
          params={{ id: task.conversationId }}
          className="text-sm text-muted hover:text-text"
        >
          ← Back to the conversation
        </Link>
      )}
      <TaskCard task={task} />
      <Card className="p-4">
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            What {HARNESS_LABELS[task.harness]} was asked
          </summary>
          <p className="mt-2 text-sm whitespace-pre-wrap text-muted">{task.objective}</p>
        </details>
      </Card>
      <div>
        <h2 className="mb-3 text-sm font-medium tracking-wide text-muted uppercase">Timeline</h2>
        {events.length === 0 ? (
          <p className="text-sm text-muted">No events yet.</p>
        ) : (
          <Timeline events={events} harness={task.harness} />
        )}
      </div>
    </div>
  );
}
