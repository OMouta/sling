import type { Harness, TaskEventView, TaskListView, TaskPage } from "@sling/core";
import {
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "./api.ts";
import type { TaskDetail } from "./types.ts";

/** Every task list in the cache starts with this. */
export const tasksKey = ["tasks"] as const;

/** The latest few tasks, with the counts, for Home and the sidebar. */
export function useRecentTasks() {
  return useQuery({
    queryKey: [...tasksKey, "recent"],
    queryFn: ({ signal }) => api.get<TaskPage>("/api/tasks?limit=5", { signal }),
  });
}

export interface TaskFilters {
  view: TaskListView;
  harness: Harness | "any";
  environment: "machine" | "sandbox" | "any";
}

/** The Tasks page's list, newest first, a page at a time, filtered on the server. */
export function useTaskList(filters: TaskFilters) {
  return useInfiniteQuery({
    queryKey: [...tasksKey, "list", filters],
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams({ view: filters.view });
      if (filters.harness !== "any") params.set("harness", filters.harness);
      if (filters.environment !== "any") params.set("environment", filters.environment);
      if (pageParam) params.set("cursor", pageParam);
      return api.get<TaskPage>(`/api/tasks?${params}`, { signal });
    },
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * A task with its latest events. A refresh asks for every event from the
 * oldest one loaded, so earlier events a reader opened stay open.
 */
export function taskDetailQuery(qc: QueryClient, id: string) {
  return queryOptions({
    queryKey: ["task", id],
    queryFn: ({ signal }) => {
      const from = qc.getQueryData<TaskDetail>(["task", id])?.events[0]?.seq;
      return api.get<TaskDetail>(`/api/tasks/${id}${from !== undefined ? `?from=${from}` : ""}`, {
        signal,
      });
    },
  });
}

export function useTaskDetail(id: string) {
  const qc = useQueryClient();
  return useQuery(taskDetailQuery(qc, id));
}

/** The kinds of event a running task's card in the chat shows, and how many it keeps. */
export const ACTIVITY_TYPES: readonly string[] = ["command", "agent_message", "file_change"];
export const ACTIVITY_EVENTS = 16;
export const activityKey = (id: string) => ["task", id, "activity"] as const;

/** A running task's newest steps, for its card in the chat. */
export function useTaskActivity(id: string) {
  return useQuery({
    queryKey: activityKey(id),
    queryFn: ({ signal }) =>
      api.get<{ events: TaskEventView[] }>(
        `/api/tasks/${id}/events?limit=${ACTIVITY_EVENTS}&types=${ACTIVITY_TYPES.join(",")}`,
        { signal },
      ),
  });
}

/** Loads the events before the loaded ones, into the task's cached detail. */
export function useEarlierEvents(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (before: number) =>
      api.get<{ events: TaskEventView[]; olderCursor: number | null }>(
        `/api/tasks/${id}/events?before=${before}`,
      ),
    onSuccess: (page) =>
      qc.setQueryData<TaskDetail>(["task", id], (d) => {
        if (!d) return d;
        const first = d.events[0]?.seq ?? Number.POSITIVE_INFINITY;
        return {
          ...d,
          events: [...page.events.filter((e) => e.seq < first), ...d.events],
          olderCursor: page.olderCursor,
        };
      }),
  });
}
