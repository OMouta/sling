import type {
  NodeSpecView,
  ValidationIssue,
  WorkflowDefinition,
  WorkflowDetailView,
} from "@sling/workflow";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import {
  Cable,
  CircleCheck,
  CircleHelp,
  Download,
  Play,
  Plus,
  SlidersHorizontal,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { CopyButton } from "../components/JsonView.tsx";
import { Page, useFocusMode } from "../components/Page.tsx";
import { JsonInput } from "../components/SchemaForm.tsx";
import {
  Badge,
  Button,
  cx,
  Dialog,
  ErrorText,
  Input,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  Textarea,
} from "../components/ui.tsx";
import { AddStepMenu } from "../components/workflow/AddStepMenu.tsx";
import { GraphCanvas } from "../components/workflow/Canvas.tsx";
import { Inspector } from "../components/workflow/Inspector.tsx";
import { RunsTab } from "../components/workflow/RunsTab.tsx";
import { VersionsTab } from "../components/workflow/VersionsTab.tsx";
import { webhookField } from "../components/workflow/WebhookSettings.tsx";
import { ApiError, api } from "../lib/api.ts";
import { ago, plural } from "../lib/format.ts";
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
import {
  type Autosave,
  type SaveStatus,
  unsavedDraft,
  useAutosave,
} from "../lib/workflow/useAutosave.ts";
import {
  type DraftConflict,
  DraftConflictError,
  downloadJson,
  exportFileName,
  qk,
  useWorkflow,
  workflowApi,
} from "../lib/workflowApi.ts";
import { type EditorTab, workflowRoute } from "../router.tsx";

export function WorkflowEditorPage() {
  const { id } = workflowRoute.useParams();
  const detail = useWorkflow(id);
  const catalog = useCatalogIndex();
  // Bumped to start a fresh editing session, after restoring a version.
  const [session, setSession] = useState(0);

  if (detail.isPending || catalog.isPending) {
    return (
      <Page
        title={<Skeleton className="h-4 w-48" />}
        crumb={{ label: "Workflows", to: "/workflows" }}
      >
        <div className="grid h-full place-items-center">
          <Spinner className="size-5" />
        </div>
      </Page>
    );
  }
  if (!detail.data || !catalog.index) {
    return (
      <Page title="Workflow" crumb={{ label: "Workflows", to: "/workflows" }}>
        <div className="space-y-2 p-5">
          <ErrorText error={detail.error ?? catalog.error ?? "Workflow not found."} />
          <Link to="/workflows" className="text-xs text-muted hover:text-text">
            Back to workflows
          </Link>
        </div>
      </Page>
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
  conflict: "Not saved",
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
  // Changes a closed editor couldn't save come back, and are saved again.
  const [start] = useState(() => {
    const unsaved = unsavedDraft(id);
    return unsaved
      ? { definition: unsaved.definition, revision: unsaved.revision, unsaved: true }
      : { definition: detail.draft, revision: detail.draftRevision, unsaved: false };
  });
  const [store] = useState(
    () => new GraphStore(catalog, g.fromDefinition(start.definition, catalog)),
  );
  const autosave = useAutosave(store, id, start);
  // Summary fields stay live through the query cache.
  const live = useWorkflow(id).data ?? detail;
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // A conflict the user closed without deciding. It opens again from the save status.
  const [setAside, setSetAside] = useState<DraftConflict | null>(null);
  // The canvas needs the room, so the app's sidebar steps aside.
  useFocusMode();

  // Leaving the editor waits for the last save. One that fails or conflicts
  // holds the navigation until the user retries or lets the changes go.
  const latest = useRef(autosave);
  latest.current = autosave;
  const shouldBlockFn = useCallback(
    async ({ next }: { next: { routeId: string; params: unknown } }) => {
      if (next.routeId === workflowRoute.id && (next.params as { id?: string }).id === id) {
        return false;
      }
      if (!latest.current.pending()) return false;
      try {
        await latest.current.flush();
        return false;
      } catch {
        return true;
      }
    },
    [id],
  );
  const leaving = useBlocker({ shouldBlockFn, enableBeforeUnload: false, withResolver: true });

  const onConflict = (conflict: DraftConflict) => {
    autosave.conflicted(conflict);
    setSetAside(null);
  };

  const loadTheirs = (conflict: DraftConflict) => {
    autosave.discard();
    qc.setQueryData<WorkflowDetailView>(qk.workflow(id), (d) =>
      d ? { ...d, draft: conflict.draft, draftRevision: conflict.revision } : d,
    );
    void qc.invalidateQueries({ queryKey: qk.workflow(id) });
    onRestart();
  };

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
    onError: (err) => {
      if (err instanceof DraftConflictError) onConflict(err.conflict);
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
    try {
      await autosave.replace(def);
    } catch (err) {
      // The conflict dialog takes over from the restore dialog.
      if (err instanceof DraftConflictError) {
        onConflict(err.conflict);
        return;
      }
      throw err;
    }
    await navigate({ to: "/workflows/$id", params: { id }, search: {} });
    onRestart();
  };

  const hasManualTrigger = live.active?.nodes.some((n) => n.type === "core.manual") ?? false;

  return (
    <GraphStoreContext.Provider value={store}>
      <Page
        crumb={{ label: "Workflows", to: "/workflows" }}
        title={<NameField />}
        badge={
          <span className="flex items-center gap-1.5 max-md:hidden">
            {live.activeVersion !== null ? (
              <Badge tone="ok" dot>
                v{live.activeVersion} active
              </Badge>
            ) : (
              <Badge>Not published</Badge>
            )}
            {live.hasUnpublishedChanges && <Badge tone="warn">Unpublished changes</Badge>}
          </span>
        }
        tabs={
          <div className="flex flex-wrap items-center gap-x-4">
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
              <p role="status" className="flex items-center gap-1.5 text-xs text-ok">
                <CircleCheck aria-hidden="true" />
                {notice}
              </p>
            )}
            <ErrorText
              error={
                patch.error ??
                (validate.error instanceof DraftConflictError ? null : validate.error)
              }
            />
            <div className="ml-auto flex flex-wrap items-center gap-2 py-2.5">
              <SaveIndicator autosave={autosave} onResolve={() => setSetAside(null)} />
              <span className="flex items-center gap-2 pr-1 text-xs text-muted">
                <Switch
                  size="sm"
                  checked={live.enabled}
                  label={live.enabled ? "Disable workflow" : "Enable workflow"}
                  disabled={patch.isPending}
                  onChange={(enabled) => patch.mutate({ enabled })}
                />
                {live.enabled ? "On" : "Off"}
              </span>
              <Button
                size="sm"
                icon={CircleCheck}
                busy={validate.isPending}
                onClick={() => validate.mutate()}
              >
                Validate
              </Button>
              <Button size="sm" icon={Upload} onClick={() => setPublishing(true)}>
                Publish
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={Play}
                // Only a Manual run trigger can be started by hand; the server refuses the rest.
                disabled={live.activeVersion === null || !hasManualTrigger}
                title={
                  live.activeVersion === null
                    ? "Publish a version first"
                    : !hasManualTrigger
                      ? "Add a Manual run trigger and publish to run it by hand"
                      : `Runs version ${live.activeVersion}`
                }
                onClick={() => setRunning(true)}
              >
                Run
              </Button>
            </div>
          </div>
        }
        bodyClassName={tab === "canvas" ? "overflow-hidden" : undefined}
      >
        {tab === "canvas" && (
          <CanvasTab
            detail={live}
            issuesOpen={issuesOpen}
            onCloseIssues={() => setIssuesOpen(false)}
            onDeleted={() => autosave.discard()}
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
      </Page>

      {publishing && (
        <PublishDialog
          workflowId={id}
          autosave={autosave}
          onClose={() => setPublishing(false)}
          onConflict={onConflict}
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
      {leaving.status === "blocked" ? (
        <LeaveDialog autosave={autosave} onStay={leaving.reset} onLeave={leaving.proceed} />
      ) : (
        autosave.conflict &&
        autosave.conflict !== setAside && (
          <ConflictDialog
            conflict={autosave.conflict}
            name={live.name}
            onClose={() => setSetAside(autosave.conflict)}
            onLoadTheirs={loadTheirs}
            onOverwrite={() => autosave.overwrite()}
          />
        )
      )}
    </GraphStoreContext.Provider>
  );
}

/** The workflow's name, saved with the rest of the draft. */
function NameField() {
  const store = useGraphStore();
  const value = useGraph((s) => s.graph.name);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const name = draft?.trim();
    setDraft(null);
    if (name && name !== value) store.update((s) => g.setMeta(s, { name }));
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
      className="-ml-1.5 h-[30px] min-w-0 rounded-lg [field-sizing:content] bg-transparent px-1.5 text-base font-medium transition-shadow duration-150 outline-none hover:shadow-field focus:shadow-focus focus-visible:outline-none"
      size={Math.max(8, Math.min(40, (draft ?? value).length + 1))}
    />
  );
}

function SaveIndicator({ autosave, onResolve }: { autosave: Autosave; onResolve: () => void }) {
  const { status } = autosave;
  const failed = status === "error" || status === "conflict";
  return (
    <span
      role="status"
      aria-live="polite"
      className={cx("flex items-center gap-1.5 text-xs", failed ? "text-danger" : "text-muted")}
      title={status === "error" ? saveErrorText(autosave.error) : undefined}
    >
      {status === "saving" && <Spinner className="size-3" />}
      {SAVE_LABEL[status]}
      {failed && (
        <button
          type="button"
          className="cursor-pointer underline underline-offset-2"
          onClick={() =>
            status === "conflict" ? onResolve() : void autosave.flush().catch(() => {})
          }
        >
          {status === "conflict" ? "Resolve" : "Retry"}
        </button>
      )}
    </span>
  );
}

/** Why a save failed. A request that never got an answer is the network, not the server. */
function saveErrorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Couldn't reach the server.";
}

/**
 * The draft changed somewhere else, in another tab or from a chat, after
 * this editor last saved. Saving waits here until the user picks a side.
 */
function ConflictDialog({
  conflict,
  name,
  onClose,
  onLoadTheirs,
  onOverwrite,
}: {
  conflict: DraftConflict;
  name: string;
  onClose: () => void;
  onLoadTheirs: (conflict: DraftConflict) => void;
  onOverwrite: () => Promise<void>;
}) {
  const store = useGraphStore();
  const mine = useGraph((s) => s.graph.nodes.length);
  const overwrite = useMutation({
    mutationFn: onOverwrite,
    onError: (err) => {
      // A newer conflict replaces this dialog's; anything else stays here.
      if (err instanceof DraftConflictError) overwrite.reset();
    },
  });
  return (
    <Dialog
      title="The draft changed somewhere else"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            icon={Download}
            className="mr-auto"
            onClick={() =>
              downloadJson(exportFileName(`${name} unsaved`), g.toDefinition(store.get().graph))
            }
          >
            Download mine
          </Button>
          <ErrorText error={overwrite.error} />
          <Button busy={overwrite.isPending} onClick={() => overwrite.mutate()}>
            Overwrite theirs
          </Button>
          <Button variant="primary" data-autofocus onClick={() => onLoadTheirs(conflict)}>
            Load theirs
          </Button>
        </>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-muted">Theirs</dt>
        <dd className="text-soft">
          {plural(conflict.draft.nodes.length, "step")}, saved {ago(conflict.updatedAt)}
        </dd>
        <dt className="text-muted">Yours</dt>
        <dd className="text-soft">{plural(mine, "step")}, not saved</dd>
      </dl>
    </Dialog>
  );
}

/** Leaving the editor with changes that didn't save. */
function LeaveDialog({
  autosave,
  onStay,
  onLeave,
}: {
  autosave: Autosave;
  onStay: () => void;
  onLeave: () => void;
}) {
  const retry = useMutation({ mutationFn: () => autosave.flush(), onSuccess: onLeave });
  const conflict = autosave.status === "conflict";
  return (
    <Dialog
      title="Your changes aren't saved"
      onClose={onStay}
      footer={
        <>
          <Button
            variant="ghost-danger"
            className="mr-auto"
            onClick={() => {
              autosave.discard();
              onLeave();
            }}
          >
            Discard changes
          </Button>
          <Button onClick={onStay}>Stay</Button>
          {!conflict && (
            <Button
              variant="primary"
              data-autofocus
              busy={retry.isPending}
              onClick={() => retry.mutate()}
            >
              Retry
            </Button>
          )}
        </>
      }
    >
      <ErrorText
        error={
          conflict
            ? "The draft was changed somewhere else."
            : saveErrorText(retry.error ?? autosave.error)
        }
      />
    </Dialog>
  );
}

interface CanvasProps {
  detail: WorkflowDetailView;
  issuesOpen: boolean;
  onCloseIssues: () => void;
  /** The workflow is gone, so its unsaved changes have nowhere to go. */
  onDeleted: () => void;
}

function CanvasTab(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasView {...props} />
    </ReactFlowProvider>
  );
}

/**
 * The canvas has the whole area. Adding steps, help, and the workflow's
 * details float over it, and a step's settings open beside it only while
 * it's selected.
 */
function CanvasView({ detail, issuesOpen, onCloseIssues, onDeleted }: CanvasProps) {
  const store = useGraphStore();
  const phone = useIsPhone();
  const hasSelection = useGraph(
    (s) => s.graph.nodes.some((n) => n.selected) || s.graph.edges.some((e) => e.selected),
  );
  const webhookFor = (nodeId: string) => detail.webhooks.find((w) => w.nodeId === nodeId);

  const nodeExtra = (nodeId: string, spec: NodeSpecView | undefined) => {
    if (spec?.type !== "core.webhook") return null;
    const hook = webhookFor(nodeId);
    return (
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-soft">Webhook URL</p>
        {hook ? (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-field px-2 py-1.5 font-mono text-xs shadow-field">
              {hook.url}
            </code>
            <CopyButton text={hook.url} />
          </div>
        ) : (
          <p className="text-xs text-muted">Publish to get the URL.</p>
        )}
      </div>
    );
  };

  const nodeField = webhookField(detail.id);

  const rf = useReactFlow();
  const [adding, setAdding] = useState<"step" | "trigger" | null>(null);
  const [details, setDetails] = useState(false);
  const [help, setHelp] = useState(false);
  const [showData, setShowData] = useState(false);
  const empty = useGraph((s) => s.graph.nodes.length === 0);
  const afterLabel = useGraph((s) => {
    const ids = g.selectedNodeIds(s.graph);
    const node = ids.length === 1 && ids[0] ? g.nodeById(s.graph, ids[0]) : undefined;
    return node ? node.data.label || (store.spec(node.data.type)?.title ?? null) : null;
  });
  const panelOpen = !phone && (hasSelection || details);

  // A new step goes after the selected one, or in the middle of what's in view.
  const addStep = (spec: NodeSpecView) => {
    const box = document.querySelector(".sling-canvas")?.getBoundingClientRect();
    const at = rf.screenToFlowPosition({
      x: box ? box.left + box.width / 2 : window.innerWidth / 2,
      y: box ? box.top + box.height / 2 : window.innerHeight / 2,
    });
    const offset = (store.get().graph.nodes.length % 5) * 24;
    const id = store.addStep(spec, { x: at.x - 128 + offset, y: at.y - 40 + offset });
    setAdding(null);
    setDetails(false);
    // Bring it into view if it landed outside.
    requestAnimationFrame(() => {
      const node = g.nodeById(store.get().graph, id);
      if (!node) return;
      const p = rf.flowToScreenPosition(node.position);
      const outside =
        !box || p.x < box.left || p.x + 256 > box.right || p.y < box.top || p.y + 80 > box.bottom;
      if (outside)
        void rf.setCenter(node.position.x + 128, node.position.y + 40, { duration: 250 });
    });
  };

  return (
    <div className="relative h-full min-h-0">
      <GraphCanvas interactive={!phone} className={cx(showData && "show-all-ports")} />

      {!phone && (
        <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex flex-wrap items-start gap-2">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-surface-2 p-1 shadow-raised">
            <Button
              size="sm"
              variant="primary"
              icon={Plus}
              aria-expanded={adding !== null}
              onClick={() => setAdding((a) => (a ? null : "step"))}
            >
              Add step
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={Cable}
              aria-pressed={showData}
              title="Show every input and output"
              className={cx(showData && "bg-surface-3 text-text")}
              onClick={() => setShowData((v) => !v)}
            >
              Data
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={CircleHelp}
              aria-pressed={help}
              className={cx(help && "bg-surface-3 text-text")}
              onClick={() => setHelp((v) => !v)}
            >
              How it works
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={SlidersHorizontal}
              aria-pressed={details && !hasSelection}
              onClick={() => {
                store.update((s) => g.select(s, []));
                setDetails((v) => !v || hasSelection);
              }}
            >
              Details
            </Button>
          </div>
          <TriggerSummary onAddTrigger={() => setAdding("trigger")} />
        </div>
      )}

      {adding && (
        <div className="absolute top-16 bottom-3 left-3 z-30 flex items-start">
          <AddStepMenu
            after={afterLabel}
            title={adding === "trigger" ? "Choose a trigger" : "Add a step"}
            triggers={adding === "trigger"}
            onPick={addStep}
            onClose={() => setAdding(null)}
          />
        </div>
      )}
      {help && !adding && <HowItWorks onClose={() => setHelp(false)} />}

      {empty && !adding && !phone && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-6">
          <div className="pointer-events-auto max-w-sm rounded-2xl bg-surface p-6 text-center shadow-popover">
            <p className="text-sm font-medium">Start with what makes it run</p>
            <Button
              className="mt-4"
              variant="primary"
              icon={Zap}
              onClick={() => setAdding("trigger")}
            >
              Choose a trigger
            </Button>
          </div>
        </div>
      )}

      {issuesOpen && <IssuesPanel onClose={onCloseIssues} />}

      {panelOpen && (
        <aside
          aria-label={hasSelection ? "Step settings" : "Workflow details"}
          className="anim-pop absolute top-3 right-3 bottom-3 z-20 flex w-[360px] max-w-[calc(100%-1.5rem)] origin-top-right flex-col overflow-hidden rounded-2xl bg-surface shadow-popover"
        >
          <div className="flex items-center justify-between border-b border-border py-1.5 pr-1.5 pl-4">
            <p className="text-xs font-medium text-subtle">
              {hasSelection ? "Step settings" : "Workflow details"}
            </p>
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={X}
              aria-label="Close"
              onClick={() => {
                store.update((s) => g.select(s, []));
                setDetails(false);
              }}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Inspector
              empty={<WorkflowPanel detail={detail} onDeleted={onDeleted} />}
              nodeExtra={nodeExtra}
              nodeField={nodeField}
            />
          </div>
        </aside>
      )}
      {phone && hasSelection && (
        <div className="anim-pop fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto overscroll-contain rounded-t-2xl bg-surface shadow-popover">
          <div className="flex justify-end px-2 pt-2">
            <Button
              size="sm"
              variant="ghost"
              icon={X}
              onClick={() => store.update((s) => g.select(s, []))}
            >
              Close
            </Button>
          </div>
          <Inspector empty={null} nodeExtra={nodeExtra} nodeField={nodeField} />
        </div>
      )}
    </div>
  );
}

/** What starts this workflow, in a line over the canvas. Each trigger selects its step. */
function TriggerSummary({ onAddTrigger }: { onAddTrigger: () => void }) {
  const store = useGraphStore();
  const nodes = useGraph((s) => s.graph.nodes);
  const triggers = nodes.filter((n) => store.spec(n.data.type)?.isTrigger);
  if (nodes.length === 0) return null;
  return (
    <div className="pointer-events-auto flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-full bg-surface-2/90 px-3 py-1 text-xs text-muted shadow-raised backdrop-blur">
      {triggers.length === 0 ? (
        <>
          <span className="text-warn">No trigger yet, so it never runs.</span>
          <button
            type="button"
            onClick={onAddTrigger}
            className="cursor-pointer font-medium text-text underline-offset-2 hover:underline"
          >
            Choose one
          </button>
        </>
      ) : (
        <>
          <Zap aria-hidden="true" size={12} className="text-subtle" />
          Runs when
          {triggers.map((t, i) => (
            <span key={t.id} className="flex items-center gap-1.5">
              {i > 0 && <span>or</span>}
              <button
                type="button"
                onClick={() => store.update((s) => g.select(s, [t.id]))}
                className="cursor-pointer rounded-full bg-surface-3 px-2 py-0.5 font-medium text-soft transition-colors duration-150 hover:text-text"
              >
                {t.data.label || store.spec(t.data.type)?.title}
              </button>
            </span>
          ))}
        </>
      )}
    </div>
  );
}

/** The editor in a few lines, for anyone opening it the first time. */
function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <section
      aria-label="How workflows work"
      className="anim-pop absolute top-16 left-3 z-30 w-[380px] max-w-[calc(100%-1.5rem)] origin-top-left rounded-2xl bg-surface p-4 shadow-popover"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-medium">How workflows work</h2>
        <Button size="sm" variant="ghost" iconOnly icon={X} aria-label="Close" onClick={onClose} />
      </div>
      <ol className="mt-2 space-y-2.5 text-[13px] leading-5 text-soft">
        <li>
          <span className="font-medium text-text">A trigger starts a run.</span>
        </li>
        <li>
          <span className="font-medium text-text">Thick lines set the order</span>, left to right.
        </li>
        <li>
          <span className="font-medium text-text">Thin colored lines carry data</span> between
          steps.
        </li>
        <li>
          <span className="font-medium text-text">Changes save as a draft.</span> Publish makes them
          live.
        </li>
      </ol>
      <p className="mt-3 border-t border-border pt-3 text-xs leading-4 text-muted">
        Drag from a port to connect. Shift-drag to select. ⌘Z undo. ⌘C, ⌘X, ⌘V, ⌘D copy, cut, paste,
        duplicate.
      </p>
    </section>
  );
}

function WorkflowPanel({
  detail,
  onDeleted,
}: {
  detail: WorkflowDetailView;
  onDeleted: () => void;
}) {
  const store = useGraphStore();
  const description = useGraph((s) => s.graph.description);
  const triggers = useGraph((s) => s.graph.nodes).filter((n) => store.spec(n.data.type)?.isTrigger);
  return (
    <div className="space-y-5 p-4">
      <div className="space-y-1.5">
        <label htmlFor="wf-description" className="text-xs font-medium text-soft">
          Description
        </label>
        <Textarea
          id="wf-description"
          rows={3}
          value={description}
          maxLength={2000}
          onChange={(e) => store.update((s) => g.setMeta(s, { description: e.target.value }))}
        />
      </div>
      <section className="space-y-2">
        <h3 className="section-label">Triggers</h3>
        {triggers.length === 0 ? (
          <p className="text-xs text-muted">No trigger yet, so it never runs.</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {triggers.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className="cursor-pointer text-soft hover:text-text hover:underline"
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
          <h3 className="section-label">Webhooks</h3>
          <ul className="space-y-2">
            {detail.webhooks.map((w) => (
              <li key={w.nodeId} className="flex items-center gap-2">
                <code
                  className="min-w-0 flex-1 truncate rounded-lg bg-field px-2 py-1.5 font-mono text-xs shadow-field"
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
      <DeleteWorkflow workflowId={detail.id} name={detail.name} onDeleted={onDeleted} />
    </div>
  );
}

function DeleteWorkflow({
  workflowId,
  name,
  onDeleted,
}: {
  workflowId: string;
  name: string;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const del = useMutation({
    mutationFn: () => api.del(`/api/workflows/${workflowId}`),
    onSuccess: () => {
      onDeleted();
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
          title={`Delete ${name}?`}
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
          <p className="text-[13px] leading-5 text-soft">
            Its versions and run history go with it.
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
      className="anim-pop absolute bottom-3 left-1/2 z-20 max-h-[40%] w-[min(26rem,calc(100%-1.5rem))] -translate-x-1/2 overflow-hidden rounded-xl bg-surface shadow-popover"
    >
      <div className="flex items-center justify-between border-b border-border py-2 pr-2 pl-3">
        <h2 className="text-[13px] font-medium">
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
          <li className="px-3 py-2.5 text-xs text-muted">The draft is ready to publish.</li>
        )}
        {issues.map((issue, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: issues can repeat exactly.
          <li key={i}>
            <button
              type="button"
              onClick={() => focus(issue)}
              className="w-full cursor-pointer px-3 py-2 text-left transition-colors duration-150 hover:bg-hover"
            >
              <span className="block text-[13px] text-danger">{issue.message}</span>
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
  onConflict,
  onIssues,
  onPublished,
}: {
  workflowId: string;
  autosave: Autosave;
  onClose: () => void;
  onConflict: (conflict: DraftConflict) => void;
  onIssues: (issues: ValidationIssue[]) => void;
  onPublished: (version: number | null) => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const publish = useMutation({
    // What's published is the revision on the canvas; a newer one elsewhere is a conflict.
    mutationFn: async () => {
      await autosave.flush();
      return workflowApi.publish(workflowId, note.trim(), autosave.revision());
    },
    onError: (err) => {
      if (!(err instanceof DraftConflictError)) return;
      onClose();
      onConflict(err.conflict);
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
      <div className="space-y-1.5">
        <label htmlFor="publish-note" className="text-xs font-medium text-soft">
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
      <p className="text-[13px] text-warn">
        Runs version {activeVersion}, without your unpublished changes.
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
            <label htmlFor="run-input" className="text-xs font-medium text-soft">
              Input JSON
            </label>
            <JsonInput id="run-input" rows={8} value={input} onChange={setInput} />
          </div>
        ) : (
          !hasUnpublishedChanges && (
            <p className="text-[13px] text-muted">Runs version {activeVersion}.</p>
          )
        )}
      </div>
    </Dialog>
  );
}
