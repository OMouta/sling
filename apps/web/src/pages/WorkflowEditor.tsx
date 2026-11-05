import type {
  NodeSpecView,
  ValidationIssue,
  WorkflowDefinition,
  WorkflowDetailView,
} from "@sling/workflow";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { type ReactNode, useCallback, useState } from "react";
import { CopyButton } from "../components/JsonView.tsx";
import { JsonInput } from "../components/SchemaForm.tsx";
import {
  Badge,
  Button,
  cx,
  Dialog,
  ErrorText,
  Input,
  Spinner,
  Switch,
  Tabs,
  Textarea,
} from "../components/ui.tsx";
import { GraphCanvas } from "../components/workflow/Canvas.tsx";
import { Inspector } from "../components/workflow/Inspector.tsx";
import { Palette } from "../components/workflow/Palette.tsx";
import { RunsTab } from "../components/workflow/RunsTab.tsx";
import { VersionsTab } from "../components/workflow/VersionsTab.tsx";
import { api } from "../lib/api.ts";
import { useIsPhone } from "../lib/useMedia.ts";
import type { CatalogIndex } from "../lib/workflow/catalog.ts";
import { useCatalogIndex } from "../lib/workflow/catalogIndex.ts";
import * as g from "../lib/workflow/graph.ts";
import {
  GraphStore,
  GraphStoreContext,
  issueDecor,
  useGraph,
  useGraphStore,
} from "../lib/workflow/store.ts";
import { type Autosave, type SaveStatus, useAutosave } from "../lib/workflow/useAutosave.ts";
import { qk, useWorkflow, workflowApi } from "../lib/workflowApi.ts";
import { type EditorTab, workflowRoute } from "../router.tsx";

export function WorkflowEditorPage() {
  const { id } = workflowRoute.useParams();
  const detail = useWorkflow(id);
  const catalog = useCatalogIndex();
  // Bumped to start a fresh editing session, after restoring a version.
  const [session, setSession] = useState(0);

  if (detail.isPending || catalog.isPending) {
    return (
      <div className="grid h-full place-items-center text-muted">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (!detail.data || !catalog.index) {
    return (
      <div className="space-y-2 p-6">
        <ErrorText error={detail.error ?? catalog.error ?? "Workflow not found."} />
        <Link to="/workflows" className="text-sm text-muted hover:text-text">
          ← Workflows
        </Link>
      </div>
    );
  }
  return (
    <EditorSession
      key={`${id}:${session}`}
      detail={detail.data}
      catalog={catalog.index}
      onRestart={() => setSession((n) => n + 1)}
    />
  );
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: "Saved",
  dirty: "Unsaved changes",
  saving: "Saving…",
  error: "Couldn't save",
};

function EditorSession({
  detail,
  catalog,
  onRestart,
}: {
  detail: WorkflowDetailView;
  catalog: CatalogIndex;
  onRestart: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = workflowRoute.useSearch();
  const tab: EditorTab = search.tab ?? "canvas";
  const id = detail.id;
  // The editor owns the draft from here on; later fetches of the detail don't replace it.
  const [store] = useState(() => new GraphStore(catalog, g.fromDefinition(detail.draft, catalog)));
  const autosave = useAutosave(store, id);
  // Summary fields stay live through the query cache.
  const live = useWorkflow(id).data ?? detail;
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const setTab = (next: EditorTab) =>
    void navigate({
      to: "/workflows/$id",
      params: { id },
      search: next === "canvas" ? {} : { tab: next },
    });

  const showIssues = useCallback(
    (issues: ValidationIssue[]) => {
      store.decorate(issueDecor(issues));
      setIssuesOpen(true);
    },
    [store],
  );

  const validate = useMutation({
    mutationFn: async () => {
      await autosave.flush();
      return workflowApi.validate(id);
    },
    onSuccess: (issues) => {
      showIssues(issues);
      setNotice(issues.length === 0 ? "No problems found." : null);
    },
  });

  const patch = useMutation({
    mutationFn: (body: { name?: string; description?: string; enabled?: boolean }) =>
      workflowApi.patch(id, body),
    onSuccess: (_, body) => {
      qc.setQueryData<WorkflowDetailView>(qk.workflow(id), (d) => (d ? { ...d, ...body } : d));
      void qc.invalidateQueries({ queryKey: qk.workflows() });
    },
  });

  const restore = async (def: WorkflowDefinition) => {
    autosave.discard();
    await workflowApi.saveDraft(id, def);
    qc.setQueryData<WorkflowDetailView>(qk.workflow(id), (d) =>
      d ? { ...d, draft: def, hasUnpublishedChanges: true } : d,
    );
    await navigate({ to: "/workflows/$id", params: { id }, search: {} });
    onRestart();
  };

  const hasManualTrigger = live.active?.nodes.some((n) => n.type === "core.manual") ?? false;

  return (
    <GraphStoreContext.Provider value={store}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="space-y-2 border-b border-border bg-surface px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Link to="/workflows" className="text-sm text-muted hover:text-text">
              ← Workflows
            </Link>
            <NameField
              value={live.name}
              onSave={(name) => {
                store.update((s) => g.setMeta(s, { name }));
                patch.mutate({ name });
              }}
            />
            {live.activeVersion !== null ? (
              <Badge tone="ok">v{live.activeVersion} active</Badge>
            ) : (
              <Badge>Not published</Badge>
            )}
            {live.hasUnpublishedChanges && <Badge tone="warn">Unpublished changes</Badge>}
            <span className="flex items-center gap-2 text-sm text-muted">
              <Switch
                size="sm"
                checked={live.enabled}
                label={live.enabled ? "Disable workflow" : "Enable workflow"}
                disabled={patch.isPending}
                onChange={(enabled) => patch.mutate({ enabled })}
              />
              {live.enabled ? "Enabled" : "Disabled"}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <SaveIndicator autosave={autosave} />
              <Button size="sm" busy={validate.isPending} onClick={() => validate.mutate()}>
                Validate
              </Button>
              <Button size="sm" onClick={() => setPublishing(true)}>
                Publish
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={live.activeVersion === null}
                title={
                  live.activeVersion === null
                    ? "Publish a version first. Runs use the active version."
                    : `Runs version ${live.activeVersion}`
                }
                onClick={() => setRunning(true)}
              >
                Run
              </Button>
            </div>
          </div>
          <ErrorText error={patch.error ?? validate.error} />
          <div className="flex items-center gap-3">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "canvas", label: "Canvas" },
                { id: "runs", label: "Runs" },
                { id: "versions", label: "Versions" },
              ]}
            />
            {notice && (
              <p role="status" className="text-sm text-ok">
                {notice}
              </p>
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1">
          {tab === "canvas" && (
            <CanvasTab
              detail={live}
              issuesOpen={issuesOpen}
              onCloseIssues={() => setIssuesOpen(false)}
              onPatch={(body) => patch.mutate(body)}
            />
          )}
          {tab === "runs" && <RunsTab workflowId={id} catalog={catalog} />}
          {tab === "versions" && (
            <VersionsTab
              workflowId={id}
              workflowName={live.name}
              activeVersion={live.activeVersion}
              catalog={catalog}
              viewing={search.version ?? null}
              onView={(n) =>
                void navigate({
                  to: "/workflows/$id",
                  params: { id },
                  search: n === null ? { tab: "versions" } : { tab: "versions", version: n },
                })
              }
              onRestore={restore}
            />
          )}
        </div>
      </div>

      {publishing && (
        <PublishDialog
          workflowId={id}
          autosave={autosave}
          onClose={() => setPublishing(false)}
          onIssues={(issues) => {
            showIssues(issues);
            if (tab !== "canvas") setTab("canvas");
          }}
          onPublished={(version) => {
            store.decorate(issueDecor([]));
            setIssuesOpen(false);
            setNotice(`Published version ${version}.`);
          }}
        />
      )}
      {running && (
        <RunDialog
          workflowId={id}
          askInput={hasManualTrigger}
          hasUnpublishedChanges={live.hasUnpublishedChanges}
          activeVersion={live.activeVersion}
          onClose={() => setRunning(false)}
        />
      )}
    </GraphStoreContext.Provider>
  );
}

function NameField({ value, onSave }: { value: string; onSave: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const name = draft?.trim();
    setDraft(null);
    if (name && name !== value) onSave(name);
  };
  return (
    <input
      aria-label="Workflow name"
      value={draft ?? value}
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(null);
      }}
      className="min-w-0 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-lg font-semibold tracking-tight hover:border-border focus:border-accent focus:outline-none"
      size={Math.max(8, Math.min(40, (draft ?? value).length + 1))}
    />
  );
}

function SaveIndicator({ autosave }: { autosave: Autosave }) {
  const { status } = autosave;
  return (
    <span
      role="status"
      aria-live="polite"
      className={cx(
        "flex items-center gap-1.5 text-xs",
        status === "error" ? "text-danger" : "text-muted",
      )}
      title={status === "error" ? String((autosave.error as Error)?.message ?? "") : undefined}
    >
      {status === "saving" && <Spinner className="size-3" />}
      {SAVE_LABEL[status]}
      {status === "error" && (
        <button
          type="button"
          className="underline"
          onClick={() => void autosave.flush().catch(() => {})}
        >
          Retry
        </button>
      )}
    </span>
  );
}

function CanvasTab({
  detail,
  issuesOpen,
  onCloseIssues,
  onPatch,
}: {
  detail: WorkflowDetailView;
  issuesOpen: boolean;
  onCloseIssues: () => void;
  onPatch: (body: { description?: string }) => void;
}) {
  const store = useGraphStore();
  const phone = useIsPhone();
  const hasSelection = useGraph((s) => s.graph.nodes.some((n) => n.selected));
  const webhookFor = (nodeId: string) => detail.webhooks.find((w) => w.nodeId === nodeId);

  const nodeExtra = (nodeId: string, spec: NodeSpecView | undefined) => {
    if (spec?.type !== "core.webhook") return null;
    const hook = webhookFor(nodeId);
    return (
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Webhook URL</p>
        {hook ? (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-surface-2 px-2 py-1.5 text-xs">
              {hook.url}
            </code>
            <CopyButton text={hook.url} />
          </div>
        ) : (
          <p className="text-xs text-muted">Publish to get a URL for this trigger.</p>
        )}
      </div>
    );
  };

  const empty = <WorkflowPanel detail={detail} onPatch={onPatch} />;

  return (
    <ReactFlowProvider>
      <div className="flex h-full min-h-0">
        {!phone && (
          <aside className="w-60 shrink-0 border-r border-border bg-surface">
            <Palette />
          </aside>
        )}
        <div className="relative min-w-0 flex-1">
          <GraphCanvas interactive={!phone} />
          {issuesOpen && <IssuesPanel onClose={onCloseIssues} />}
        </div>
        {!phone && (
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-surface">
            <Inspector empty={empty} nodeExtra={nodeExtra} />
          </aside>
        )}
      </div>
      {phone && hasSelection && (
        <div className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-xl border-t border-border bg-surface shadow-2xl">
          <div className="flex justify-end px-2 pt-2">
            <Button size="sm" variant="ghost" onClick={() => store.update((s) => g.select(s, []))}>
              Close
            </Button>
          </div>
          <Inspector empty={null} nodeExtra={nodeExtra} />
        </div>
      )}
    </ReactFlowProvider>
  );
}

function WorkflowPanel({
  detail,
  onPatch,
}: {
  detail: WorkflowDetailView;
  onPatch: (body: { description?: string }) => void;
}) {
  const store = useGraphStore();
  const description = useGraph((s) => s.graph.description);
  const triggers = useGraph((s) => s.graph.nodes).filter((n) => store.spec(n.data.type)?.isTrigger);
  return (
    <div className="space-y-5 p-4">
      <div className="space-y-1.5">
        <label htmlFor="wf-description" className="text-sm font-medium">
          Description
        </label>
        <Textarea
          id="wf-description"
          rows={3}
          value={description}
          maxLength={2000}
          onChange={(e) => store.update((s) => g.setMeta(s, { description: e.target.value }))}
          onBlur={(e) => {
            if (e.target.value !== detail.description) onPatch({ description: e.target.value });
          }}
        />
      </div>
      <section className="space-y-2">
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Triggers</h3>
        {triggers.length === 0 ? (
          <p className="text-sm text-muted">Add a trigger from the palette to start runs.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {triggers.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => store.update((s) => g.select(s, [n.id]))}
                >
                  {n.data.label || store.spec(n.data.type)?.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {detail.webhooks.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Webhooks</h3>
          <ul className="space-y-2">
            {detail.webhooks.map((w) => (
              <li key={w.nodeId} className="flex items-center gap-2">
                <code
                  className="min-w-0 flex-1 truncate rounded-md bg-surface-2 px-2 py-1.5 text-xs"
                  title={w.url}
                >
                  {w.url}
                </code>
                <CopyButton text={w.url} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-1 text-xs text-muted">
        <h3 className="font-medium tracking-wide uppercase">Shortcuts</h3>
        <p>Drag from a port to connect. Shift-drag to box select.</p>
        <p>Delete removes the selection. Ctrl or ⌘ with C, X, V, D, A, Z, Shift+Z.</p>
      </section>
      <DeleteWorkflow workflowId={detail.id} name={detail.name} />
    </div>
  );
}

function DeleteWorkflow({ workflowId, name }: { workflowId: string; name: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const del = useMutation({
    mutationFn: () => api.del(`/api/workflows/${workflowId}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: qk.workflow(workflowId) });
      void qc.invalidateQueries({ queryKey: qk.workflows() });
      void navigate({ to: "/workflows" });
    },
  });
  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
        Delete workflow
      </Button>
      {open && (
        <Dialog
          title="Delete this workflow?"
          onClose={() => setOpen(false)}
          footer={
            <>
              <ErrorText error={del.error} />
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="danger" busy={del.isPending} onClick={() => del.mutate()}>
                Delete
              </Button>
            </>
          }
        >
          <p className="text-sm">
            {name}, its versions and its run history are deleted. Its triggers stop.
          </p>
        </Dialog>
      )}
    </>
  );
}

function IssuesPanel({ onClose }: { onClose: () => void }) {
  const store = useGraphStore();
  const rf = useReactFlow();
  const issues = useGraph((s) => s.decor.issues);

  const focus = (issue: ValidationIssue) => {
    const edge = issue.edgeId
      ? store.get().graph.edges.find((e) => e.id === issue.edgeId)
      : undefined;
    const nodeId = issue.nodeId ?? edge?.target;
    store.update((s) => g.select(s, issue.nodeId ? [issue.nodeId] : [], edge ? [edge.id] : []));
    const node = nodeId ? g.nodeById(store.get().graph, nodeId) : undefined;
    if (node) {
      const w = node.measured?.width ?? 228;
      const h = node.measured?.height ?? 80;
      void rf.setCenter(node.position.x + w / 2, node.position.y + h / 2, {
        zoom: Math.max(rf.getZoom(), 0.9),
        duration: 250,
      });
    }
  };

  return (
    <section
      aria-label="Problems"
      className="absolute inset-x-3 bottom-3 z-10 max-h-[40%] overflow-hidden rounded-xl border border-border bg-surface shadow-lg sm:left-auto sm:w-96"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium">
          {issues.length === 0
            ? "No problems"
            : `${issues.length} problem${issues.length === 1 ? "" : "s"}`}
        </h2>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <ul className="max-h-64 divide-y divide-border overflow-y-auto">
        {issues.length === 0 && (
          <li className="px-3 py-2 text-sm text-muted">The draft is ready to publish.</li>
        )}
        {issues.map((issue, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: issues can repeat exactly.
          <li key={i}>
            <button
              type="button"
              onClick={() => focus(issue)}
              className="w-full px-3 py-2 text-left hover:bg-surface-2"
            >
              <span className="block text-sm text-danger">{issue.message}</span>
              <span className="block font-mono text-[11px] text-muted">
                {[issue.code, issue.nodeId, issue.port, issue.edgeId].filter(Boolean).join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PublishDialog({
  workflowId,
  autosave,
  onClose,
  onIssues,
  onPublished,
}: {
  workflowId: string;
  autosave: Autosave;
  onClose: () => void;
  onIssues: (issues: ValidationIssue[]) => void;
  onPublished: (version: number | null) => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const publish = useMutation({
    mutationFn: async () => {
      await autosave.flush();
      return workflowApi.publish(workflowId, note.trim());
    },
    onSuccess: (res) => {
      onClose();
      if (!res.ok) {
        onIssues(res.issues);
        return;
      }
      onPublished(res.version);
      void qc.invalidateQueries({ queryKey: qk.workflow(workflowId) });
      void qc.invalidateQueries({ queryKey: qk.versions(workflowId) });
      void qc.invalidateQueries({ queryKey: qk.workflows() });
    },
  });
  return (
    <Dialog
      title="Publish"
      onClose={onClose}
      footer={
        <>
          <ErrorText error={publish.error} />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={publish.isPending} onClick={() => publish.mutate()}>
            Publish
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          The server checks the draft, saves it as a new version and makes that version active.
          Triggers switch to it right away.
        </p>
        <div className="space-y-1.5">
          <label htmlFor="publish-note" className="text-sm font-medium">
            Note
          </label>
          <Input
            id="publish-note"
            value={note}
            placeholder="What changed"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") publish.mutate();
            }}
          />
        </div>
      </div>
    </Dialog>
  );
}

function RunDialog({
  workflowId,
  askInput,
  hasUnpublishedChanges,
  activeVersion,
  onClose,
}: {
  workflowId: string;
  askInput: boolean;
  hasUnpublishedChanges: boolean;
  activeVersion: number | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [input, setInput] = useState<unknown>({});
  const run = useMutation({
    mutationFn: () => workflowApi.run(workflowId, askInput ? input : {}),
    onSuccess: (runId) => {
      onClose();
      void navigate({ to: "/workflows/$id/runs/$runId", params: { id: workflowId, runId } });
    },
  });
  let note: ReactNode = null;
  if (hasUnpublishedChanges) {
    note = (
      <p className="text-sm text-warn">
        The draft has unpublished changes. This run uses version {activeVersion}.
      </p>
    );
  }
  return (
    <Dialog
      title="Run workflow"
      onClose={onClose}
      footer={
        <>
          <ErrorText error={run.error} />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-autofocus
            busy={run.isPending}
            disabled={askInput && input === undefined}
            onClick={() => run.mutate()}
          >
            Run
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {note}
        {askInput ? (
          <div className="space-y-1.5">
            <label htmlFor="run-input" className="text-sm font-medium">
              Input JSON
            </label>
            <JsonInput id="run-input" rows={8} value={input} onChange={setInput} />
            <p className="text-xs text-muted">The Manual run trigger outputs this as `input`.</p>
          </div>
        ) : (
          <p className="text-sm text-muted">
            This workflow has no Manual run trigger, so it starts with no input.
          </p>
        )}
      </div>
    </Dialog>
  );
}
