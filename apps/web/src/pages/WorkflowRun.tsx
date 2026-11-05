import type { NodeRunView, RunDetailView, RunView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { JsonView } from "../components/JsonView.tsx";
import { RUN_TONE, RunStatusBadge } from "../components/StatusBadge.tsx";
import { Badge, Button, Card, cx, Dot, ErrorText, Spinner } from "../components/ui.tsx";
import { ReadOnlyCanvas, useReadOnlyStore } from "../components/workflow/ReadOnlyCanvas.tsx";
import { runDuration, triggerTitle } from "../components/workflow/RunsTab.tsx";
import { api } from "../lib/api.ts";
import { ago, duration } from "../lib/format.ts";
import type { CatalogIndex } from "../lib/workflow/catalog.ts";
import { useCatalogIndex } from "../lib/workflow/catalogIndex.ts";
import * as g from "../lib/workflow/graph.ts";
import { type GraphStore, runDecor, sortNodeRuns } from "../lib/workflow/store.ts";
import { qk, runIdOf, useRun, useVersion } from "../lib/workflowApi.ts";
import { runRoute } from "../router.tsx";

const ACTIVE = new Set(["queued", "running", "waiting"]);

export function WorkflowRunPage() {
  const { id: workflowId, runId } = runRoute.useParams();
  const detail = useRun(runId);
  const catalog = useCatalogIndex();
  const version = useVersion(workflowId, detail.data?.run.versionNumber ?? null);
  const store = useReadOnlyStore(version.data?.definition, catalog.index);

  if (detail.isPending) {
    return (
      <div className="grid h-full place-items-center text-muted">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div className="p-6">
        <ErrorText error={detail.error ?? "Run not found."} />
      </div>
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
    <div className="flex min-h-full flex-col">
      <RunHeader workflowId={workflowId} run={run} catalog={catalog} onPickNode={pickNode} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
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
        <aside className="lg:w-[26rem] lg:shrink-0 lg:overflow-y-auto">
          <h2 className="px-4 pt-4 text-xs font-medium tracking-wide text-muted uppercase">
            Steps
          </h2>
          {ordered.length === 0 && <p className="px-4 py-3 text-sm text-muted">No steps yet.</p>}
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
    </div>
  );
}

function RunHeader({
  workflowId,
  run,
  catalog,
  onPickNode,
}: {
  workflowId: string;
  run: RunView;
  catalog: CatalogIndex | null;
  onPickNode: (nodeId: string) => void;
}) {
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
  // Keep "so far" durations moving while the run is active.
  const [, tick] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => {
    if (!active) return;
    timer.current = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer.current);
  }, [active]);

  return (
    <header className="space-y-3 border-b border-border bg-surface px-4 py-3">
      <Link
        to="/workflows/$id"
        params={{ id: workflowId }}
        search={{ tab: "runs" }}
        className="text-sm text-muted hover:text-text"
      >
        ← {run.workflowName} runs
      </Link>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-lg font-semibold tracking-tight">Run {run.id.slice(-8)}</h1>
        <RunStatusBadge status={run.status} />
        <Badge>v{run.versionNumber}</Badge>
        <span className="text-sm text-muted">
          {triggerTitle(catalog, run.triggerType)} ·{" "}
          <span title={new Date(run.createdAt).toLocaleString()}>{ago(run.createdAt)}</span>
          {runDuration(run) && ` · ${runDuration(run)}`}
        </span>
        <div className="ml-auto flex gap-2">
          {active && (
            <Button size="sm" busy={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel
            </Button>
          )}
          {!active && (
            <Button size="sm" busy={retry.isPending} onClick={() => retry.mutate()}>
              Retry
            </Button>
          )}
        </div>
      </div>
      <ErrorText error={cancel.error ?? retry.error} />
      {run.error && (
        <Card className="border-danger/40 bg-danger/5 p-3 text-sm">
          <p className="text-danger">{run.error.message}</p>
          <p className="mt-1 font-mono text-xs text-muted">
            {run.error.code}
            {run.error.nodeId && (
              <>
                {" · "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => run.error?.nodeId && onPickNode(run.error.nodeId)}
                >
                  {run.error.nodeId}
                </button>
              </>
            )}
          </p>
        </Card>
      )}
      {run.output !== null && run.output !== undefined && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">Output</summary>
          <JsonView value={run.output} className="mt-2" />
        </details>
      )}
    </header>
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
      className={cx("rounded-lg border", open ? "border-accent bg-surface" : "border-transparent")}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-2"
      >
        <Dot tone={RUN_TONE[nr.status] ?? "neutral"} />
        <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
        {nr.iteration > 0 && <Badge>#{nr.iteration}</Badge>}
        {nr.attempt > 1 && <Badge tone="warn">try {nr.attempt}</Badge>}
        <span className="text-xs text-muted">{nr.status}</span>
        <span className="w-16 text-right text-xs text-muted">{duration(ms)}</span>
      </button>
      {open && (
        <div className="space-y-3 px-2 pb-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted">Node</dt>
            <dd className="font-mono">
              {nr.nodeId} · {nr.nodeType}
            </dd>
            <dt className="text-muted">Exec port</dt>
            <dd className="font-mono">{nr.execPort ?? "none"}</dd>
            <dt className="text-muted">Attempt</dt>
            <dd>{nr.attempt}</dd>
            <dt className="text-muted">Iteration</dt>
            <dd>{nr.iteration}</dd>
            <dt className="text-muted">Started</dt>
            <dd>{new Date(nr.startedAt).toLocaleString()}</dd>
            <dt className="text-muted">Duration</dt>
            <dd>{duration(ms) || "running"}</dd>
          </dl>
          {nr.error && <JsonView title="Error" value={nr.error} />}
          <JsonView title="Inputs" value={nr.inputs} />
          <JsonView title="Outputs" value={nr.outputs} />
        </div>
      )}
    </div>
  );
}
