import "@xyflow/react/dist/base.css";
import {
  Background,
  BackgroundVariant,
  type Connection,
  type EdgeTypes,
  type FinalConnectionState,
  type NodeTypes,
  Panel,
  ReactFlow,
  useConnection,
  useReactFlow,
} from "@xyflow/react";
import { type DragEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import * as g from "../../lib/workflow/graph.ts";
import { type GraphStore, useGraph, useGraphStore } from "../../lib/workflow/store.ts";
import { cx } from "../ui.tsx";
import { DataEdge, EdgeMarkers, ExecEdge } from "./Edges.tsx";
import { NodeView } from "./NodeView.tsx";

const NODE_TYPES: NodeTypes = { sling: NodeView };
const EDGE_TYPES: EdgeTypes = { exec: ExecEdge, data: DataEdge };

/** Drag-and-drop type for palette items. The payload is a node type. */
export const NODE_DND_TYPE = "application/x-sling-node";

/** Copied nodes, shared across editors in this tab. */
let clipboard: { fragment: g.Fragment; pastes: number } | null = null;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function requestOf(c: Connection | g.GraphEdge): g.ConnectionRequest {
  return {
    source: c.source,
    sourceHandle: c.sourceHandle,
    target: c.target,
    targetHandle: c.targetHandle,
  };
}

function reasonFor(store: GraphStore, state: FinalConnectionState | null): string | null {
  if (!state?.fromHandle || !state.toHandle) return null;
  const { fromHandle: from, toHandle: to } = state;
  const req =
    from.type === "source"
      ? { source: from.nodeId, sourceHandle: from.id, target: to.nodeId, targetHandle: to.id }
      : { source: to.nodeId, sourceHandle: to.id, target: from.nodeId, targetHandle: from.id };
  const check = g.checkConnection(store.get().graph, store.catalog, req);
  return check.ok ? null : check.reason;
}

/** Says why the connection being dragged isn't allowed, or why the last one was refused. */
function ConnectionHint({ flash }: { flash: string | null }) {
  const store = useGraphStore();
  const live = useConnection((c) =>
    c.inProgress && c.toHandle && c.isValid === false
      ? reasonFor(store, c as FinalConnectionState)
      : null,
  );
  const text = live ?? flash;
  if (!text) return null;
  return (
    <Panel position="top-center">
      <div
        role="status"
        className="rounded-lg border border-danger/40 bg-surface px-3 py-1.5 text-sm text-danger shadow"
      >
        {text}
      </div>
    </Panel>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Toolbar({ editable }: { editable: boolean }) {
  const store = useGraphStore();
  const rf = useReactFlow();
  const canUndo = useGraph((s) => s.graph.past.length > 0);
  const canRedo = useGraph((s) => s.graph.future.length > 0);
  return (
    <Panel position="bottom-left">
      <div className="flex divide-x divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
        {editable && (
          <>
            <ToolButton
              label="Undo (Ctrl+Z)"
              disabled={!canUndo}
              onClick={() => store.update(g.undo)}
            >
              ↶
            </ToolButton>
            <ToolButton
              label="Redo (Ctrl+Shift+Z)"
              disabled={!canRedo}
              onClick={() => store.update(g.redo)}
            >
              ↷
            </ToolButton>
          </>
        )}
        <ToolButton label="Zoom in" onClick={() => void rf.zoomIn({ duration: 150 })}>
          +
        </ToolButton>
        <ToolButton label="Zoom out" onClick={() => void rf.zoomOut({ duration: 150 })}>
          −
        </ToolButton>
        <ToolButton
          label="Fit view"
          onClick={() => void rf.fitView({ padding: 0.2, duration: 200 })}
        >
          ⤢
        </ToolButton>
      </div>
    </Panel>
  );
}

/** Undo, redo, copy, cut, paste, duplicate, select all and delete. */
function useShortcuts(store: GraphStore, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditable(e.target)) return;
      if (document.querySelector("[role=dialog]")) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        store.update(g.deleteSelection);
        return;
      }
      if (!mod) return;
      if (key === "z") {
        e.preventDefault();
        store.update(e.shiftKey ? g.redo : g.undo);
      } else if (key === "y") {
        e.preventDefault();
        store.update(g.redo);
      } else if (key === "a") {
        e.preventDefault();
        store.update(g.selectAll);
      } else if (key === "c" || key === "x" || key === "d") {
        const fragment = g.copySelection(store.get().graph);
        if (!fragment) return;
        e.preventDefault();
        if (key === "d") {
          store.update((s) => g.paste(s, store.catalog, fragment));
          return;
        }
        clipboard = { fragment, pastes: 0 };
        if (key === "x") store.update(g.deleteSelection);
      } else if (key === "v" && clipboard) {
        e.preventDefault();
        const clip = clipboard;
        clip.pastes += 1;
        const offset = { x: 40 * clip.pastes, y: 40 * clip.pastes };
        store.update((s) => g.paste(s, store.catalog, clip.fragment, offset));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, enabled]);
}

/**
 * The workflow canvas. Needs a GraphStoreContext and a ReactFlowProvider
 * above it. `interactive` false makes it view-only even for an editable
 * store, which is how phones show it.
 */
export function GraphCanvas({
  interactive = true,
  onNodeClick,
  className,
  children,
}: {
  interactive?: boolean;
  onNodeClick?: (nodeId: string) => void;
  className?: string;
  children?: ReactNode;
}) {
  const store = useGraphStore();
  const rf = useReactFlow();
  const editable = interactive && !store.readOnly;
  const nodes = useGraph((s) => s.graph.nodes);
  const edges = useGraph((s) => s.graph.edges);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useShortcuts(store, editable);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const showReason = useCallback((reason: string) => {
    setFlash(reason);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 3500);
  }, []);

  const onNodesChange = useCallback(
    (changes: Parameters<typeof g.applyNodeChanges>[1]) =>
      store.update((s) => g.applyNodeChanges(s, changes)),
    [store],
  );
  const onEdgesChange = useCallback(
    (changes: Parameters<typeof g.applyEdgeChanges>[1]) =>
      store.update((s) => g.applyEdgeChanges(s, changes)),
    [store],
  );
  const isValidConnection = useCallback(
    (c: Connection | g.GraphEdge) =>
      g.checkConnection(store.get().graph, store.catalog, requestOf(c)).ok,
    [store],
  );
  const onConnect = useCallback(
    (c: Connection) => {
      const check = store.connect(requestOf(c));
      if (!check.ok) showReason(check.reason);
    },
    [store, showReason],
  );
  const onConnectEnd = useCallback(
    (_: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid !== false) return;
      const reason = reasonFor(store, state);
      if (reason) showReason(reason);
    },
    [store, showReason],
  );
  const beginDrag = useCallback(() => store.update(g.beginDrag), [store]);
  const endDrag = useCallback(() => store.update(g.endDrag), [store]);

  const onDragOver = (e: DragEvent) => {
    if (!editable || !e.dataTransfer.types.includes(NODE_DND_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const onDrop = (e: DragEvent) => {
    if (!editable) return;
    const spec = store.spec(e.dataTransfer.getData(NODE_DND_TYPE));
    if (!spec) return;
    e.preventDefault();
    const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    store.addNode(spec, { x: at.x - 110, y: at.y - 20 });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target for palette items; the palette also adds on click.
    <div
      className={cx("sling-canvas relative h-full w-full", className)}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <EdgeMarkers />
      <ReactFlow<g.GraphNode, g.GraphEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDragStart={beginDrag}
        onNodeDragStop={endDrag}
        onSelectionDragStart={beginDrag}
        onSelectionDragStop={endDrag}
        onNodeClick={onNodeClick ? (_, node) => onNodeClick(node.id) : undefined}
        nodesDraggable={editable}
        nodesConnectable={editable}
        edgesFocusable={editable}
        elementsSelectable
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={["Meta", "Control"]}
        minZoom={0.1}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Toolbar editable={editable} />
        {editable && <ConnectionHint flash={flash} />}
        {children}
      </ReactFlow>
    </div>
  );
}
