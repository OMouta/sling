import type { Harness, TaskListView, TaskPage } from "@sling/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

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
