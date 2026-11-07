import type { RunView } from "@sling/core";
import { Link } from "@tanstack/react-router";
import { ago, between, duration } from "../../lib/format.ts";
import type { CatalogIndex } from "../../lib/workflow/catalog.ts";
import { useRuns } from "../../lib/workflowApi.ts";
import { RunStatusBadge } from "../StatusBadge.tsx";
import { Empty, ErrorText, Spinner } from "../ui.tsx";

export function triggerTitle(catalog: CatalogIndex | null, type: string): string {
  return catalog?.byType.get(type)?.title ?? type;
}

export function runDuration(run: Pick<RunView, "startedAt" | "finishedAt" | "status">): string {
  const ms = between(run.startedAt, run.finishedAt);
  if (ms === null) return "";
  return run.finishedAt ? duration(ms) : `${duration(ms)} so far`;
}

/** A workflow's runs, newest first. */
export function RunsTab({
  workflowId,
  catalog,
}: {
  workflowId: string;
  catalog: CatalogIndex | null;
}) {
  const runs = useRuns(workflowId);
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
      {runs.isPending && <Spinner />}
      <ErrorText error={runs.error} />
      {runs.data?.length === 0 && <Empty title="No runs yet" />}
      {runs.data && runs.data.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-xl bg-surface shadow-card">
          {runs.data.map((r) => (
            <li key={r.id}>
              <Link
                to="/workflows/$id/runs/$runId"
                params={{ id: workflowId, runId: r.id }}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-150 hover:bg-hover"
              >
                <span className="w-24 shrink-0">
                  <RunStatusBadge status={r.status} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {triggerTitle(catalog, r.triggerType)}
                  {r.error && <span className="ml-2 text-danger">{r.error.message}</span>}
                </span>
                <span className="text-xs text-muted">v{r.versionNumber}</span>
                <span className="w-24 text-right text-xs text-muted">{runDuration(r)}</span>
                <span
                  className="w-28 text-right text-xs text-muted"
                  title={new Date(r.createdAt).toLocaleString()}
                >
                  {ago(r.createdAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
