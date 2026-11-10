import type { NodeRunView, RunDetailView, RunView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RotateCcw, Square, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { JsonView } from "../components/JsonView.tsx";
import { Page, useFocusMode } from "../components/Page.tsx";
import { RUN_STATE, RUN_TONE, RunStatusBadge } from "../components/StatusBadge.tsx";
import { Badge, Button, cx, Dot, ErrorText, Skeleton, Spinner } from "../components/ui.tsx";
import { ReadOnlyCanvas, useReadOnlyStore } from "../components/workflow/ReadOnlyCanvas.tsx";
import { runDuration, triggerTitle } from "../components/workflow/RunsTab.tsx";
import { api } from "../lib/api.ts";
import { ago, dateTime, duration } from "../lib/format.ts";
import { useNow } from "../lib/useNow.ts";
import type { CatalogIndex } from "../lib/workflow/catalog.ts";
import { useCatalogIndex } from "../lib/workflow/catalogIndex.ts";
import * as g from "../lib/workflow/graph.ts";
import { type GraphStore, runDecor, sortNodeRuns } from "../lib/workflow/store.ts";
import { qk, runIdOf, useRun, useVersion } from "../lib/workflowApi.ts";
import { runRoute } from "../router.tsx";

const ACTIVE = new Set(["queued", "running", "waiting"]);

export function WorkflowRunPage() {
  useFocusMode();
  const { id: workflowId, runId } = runRoute.useParams();
  const detail = useRun(runId);
  const catalog = useCatalogIndex();
  const version = useVersion(workflowId, detail.data?.run.versionNumber ?? null);
  const store = useReadOnlyStore(version.data?.definition, catalog.index);

  if (detail.isPending) {
    return (
      <Page
        title={<Skeleton className="h-4 w-40" />}
        crumb={{ label: "Workflows", to: "/workflows" }}
      >
        <div className="grid h-full place-items-center">
          <Spinner className="size-5" />
        </div>
      </Page>
    );
  }
  if (!detail.data) {
    return (
      <Page title="Run" crumb={{ label: "Workflows", to: "/workflows" }}>
        <div className="p-5">
          <ErrorText error={detail.error ?? "Run not found."} />
        </div>
      </Page>
    );
  }
  return (
    <RunDetail
      workflowId={workflowId}
      detail={detail.data}
      store={store}
      catalog={catalog.index}
      canvasError={version.error ?? catalog.error}
    />
  );
}

function RunDetail({
  workflowId,
  detail,
  store,
  catalog,
  canvasError,
}: {
  workflowId: string;
  detail: RunDetailView;
  store: GraphStore | null;
  catalog: CatalogIndex | null;
  canvasError: unknown;
}) {
  const { run, nodeRuns } = detail;
  const ordered = useMemo(() => sortNodeRuns(nodeRuns), [nodeRuns]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (store) store.decorate(runDecor(nodeRuns, store.get().graph.edges));
  }, [store, nodeRuns]);

  const labelOf = (nodeId: string, nodeType: string) => {
    const node = store ? g.nodeById(store.get().graph, nodeId) : undefined;
    return node?.data.label || catalog?.byType.get(nodeType)?.title || nodeId;
  };

  const pickNode = (nodeId: string) => {
    const latest = [...ordered].reverse().find((nr) => nr.nodeId === nodeId);
    setSelected(latest?.id ?? null);
    if (latest) {
      document
        .getElementById(`node-run-${latest.id}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };

  const pickRun = (nr: NodeRunView) => {
    const next = selected === nr.id ? null : nr.id;
    setSelected(next);
    store?.update((s) => g.select(s, next ? [nr.nodeId] : []));
  };

  return (
    <Page
      crumb={{ label: run.workflowName, to: "/workflows/$id", params: { id: workflowId } }}
      title={`Run ${run.id.slice(-8)}`}
      badge={
        <span className="flex items-center gap-1.5">
          <RunStatusBadge status={run.status} />
          <Badge>v{run.versionNumber}</Badge>
        </span>
      }
      controls={<RunControls workflowId={workflowId} run={run} />}
      toolbar={<RunSummary run={run} catalog={catalog} onPickNode={pickNode} />}
      bodyClassName="flex flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col border-t border-border lg:flex-row">
        <div className="h-[55vh] min-w-0 border-b border-border lg:h-auto lg:flex-1 lg:border-r lg:border-b-0">
          {store ? (
            <ReadOnlyCanvas store={store} onNodeClick={pickNode} />
          ) : canvasError ? (
            <div className="p-4">
              <ErrorText error={canvasError} />
            </div>
          ) : (
            <div className="grid h-full place-items-center text-muted">
              <Spinner />
            </div>
          )}
        </div>
        <aside className="bg-sidebar lg:w-[26rem] lg:shrink-0 lg:overflow-y-auto">
          <h2 className="section-label px-4 pt-4">Steps</h2>
          {ordered.length === 0 && <p className="px-4 py-3 text-xs text-muted">No steps yet.</p>}
          <ol className="space-y-1 p-2">
            {ordered.map((nr) => (
              <li key={nr.id} id={`node-run-${nr.id}`}>
                <NodeRunItem
                  nodeRun={nr}
                  label={labelOf(nr.nodeId, nr.nodeType)}
                  open={selected === nr.id}
                  onToggle={() => pickRun(nr)}
                />
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </Page>
  );
}

function RunControls({ workflowId, run }: { workflowId: string; run: RunView }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const active = ACTIVE.has(run.status);
  const cancel = useMutation({
    mutationFn: () => api.post<RunView | null>(`/api/runs/${run.id}/cancel`),
    onSuccess: (res) => {
      if (res && "id" in res) {
        qc.setQueryData<RunDetailView>(qk.run(run.id), (d) => (d ? { ...d, run: res } : d));
      }
      void qc.invalidateQueries({ queryKey: qk.run(run.id) });
    },
  });
  const retry = useMutation({
    mutationFn: () => api.post<RunView | { run: RunView }>(`/api/runs/${run.id}/retry`),
    onSuccess: (res) =>
      void navigate({
        to: "/workflows/$id/runs/$runId",
        params: { id: workflowId, runId: runIdOf(res) },
      }),
  });
  return (
    <>
      <ErrorText error={cancel.error ?? retry.error} />
      {active ? (
        <Button icon={Square} busy={cancel.isPending} onClick={() => cancel.mutate()}>
          Cancel
        </Button>
      ) : (
        <Button icon={RotateCcw} busy={retry.isPending} onClick={() => retry.mutate()}>
          Retry
        </Button>
      )}
    </>
  );
}

function RunSummary({
  run,
  catalog,
  onPickNode,
}: {
  run: RunView;
  catalog: CatalogIndex | null;
  onPickNode: (nodeId: string) => void;
}) {
  const active = ACTIVE.has(run.status);
  // Keep "so far" durations moving while the run is active.
  useNow(1000, active);

  return (
    <div className="shrink-0 space-y-3 px-5 py-3">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Zap aria-hidden="true" size={12} className="text-subtle" />
          {triggerTitle(catalog, run.triggerType)}
        </span>
        <span title={new Date(run.createdAt).toLocaleString()}>{ago(run.createdAt)}</span>
        {runDuration(run) && <span className="tabular">{runDuration(run)}</span>}
      </p>
      {run.error && (
        <div className="rounded-lg border border-[var(--tag-red-border)] bg-[var(--tag-red-bg)] p-3 text-[13px]">
          <p className="text-[var(--tag-red-text)]">{run.error.message}</p>
          <p className="mt-1 font-mono text-xs text-muted">
            {run.error.code}
            {run.error.nodeId && (
              <>
                {" · "}
                <button
                  type="button"
                  className="cursor-pointer underline underline-offset-2"
                  onClick={() => run.error?.nodeId && onPickNode(run.error.nodeId)}
                >
                  {run.error.nodeId}
                </button>
              </>
            )}
          </p>
        </div>
      )}
      {run.output !== null && run.output !== undefined && (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-soft select-none">
            Output
          </summary>
          <JsonView value={run.output} className="mt-2" />
        </details>
      )}
    </div>
  );
}

function NodeRunItem({
  nodeRun: nr,
  label,
  open,
  onToggle,
}: {
  nodeRun: NodeRunView;
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  const ms =
    nr.durationMs ??
    (nr.finishedAt ? new Date(nr.finishedAt).getTime() - new Date(nr.startedAt).getTime() : null);
  return (
    <div
      className={cx(
        "rounded-lg transition-shadow duration-150",
        open ? "bg-surface shadow-[0_0_0_1px_var(--accent-text)]" : "",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-hover"
      >
        <Dot tone={RUN_TONE[nr.status] ?? "neutral"} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
        {nr.iteration > 0 && <Badge>#{nr.iteration}</Badge>}
        {nr.attempt > 1 && <Badge tone="warn">try {nr.attempt}</Badge>}
        <span className="text-xs text-muted">{RUN_STATE[nr.status]?.label ?? nr.status}</span>
        <span className="w-16 text-right text-xs text-muted">{duration(ms)}</span>
      </button>
      {open && (
        <div className="space-y-3 px-2 pb-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted">Started</dt>
            <dd>{dateTime(nr.startedAt)}</dd>
            <dt className="text-muted">Duration</dt>
            <dd>{duration(ms) || "Running"}</dd>
          </dl>
          {nr.error && <JsonView title="Error" value={nr.error} />}
          <JsonView title="Inputs" value={nr.inputs} />
          <JsonView title="Outputs" value={nr.outputs} />
        </div>
      )}
    </div>
  );
}
