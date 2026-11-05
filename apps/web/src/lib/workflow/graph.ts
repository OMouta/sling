/**
 * The editor's graph state and every edit to it, as pure functions. Nodes and
 * edges are kept in React Flow's shape so the canvas can render them without
 * copying, and unchanged nodes keep their identity so they don't re-render.
 */
import {
  type Edge as DefEdge,
  EXEC_IN,
  isAssignable,
  type NodeInstance,
  type NodeSpecView,
  WORKFLOW_SCHEMA,
  type WorkflowDefinition,
} from "@sling/workflow";
import {
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  applyEdgeChanges as rfApplyEdgeChanges,
  applyNodeChanges as rfApplyNodeChanges,
} from "@xyflow/react";
import {
  type CatalogIndex,
  defaultConfig,
  handleId,
  type PortKind,
  parseHandle,
  portsOf,
} from "./catalog.ts";

export type NodeData = {
  type: string;
  version: number;
  label: string;
  config: Record<string, unknown>;
};
export type GraphNode = Node<NodeData, "sling">;

/** `portType` is the source port's type on data edges, used for the edge color. */
export type EdgeData = { portType: string | null };
export type GraphEdge = Edge<EdgeData, PortKind>;

export interface Snapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphState {
  name: string;
  description: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  past: Snapshot[];
  future: Snapshot[];
  /** Bumped by every change to the saved definition, so autosave can tell. */
  revision: number;
  /** Key of the newest history entry. Repeats of the same edit share one entry. */
  coalesce: string | null;
  /** The graph before the current drag. Committed to history when the drag ends. */
  dragOrigin: Snapshot | null;
}

export const HISTORY_LIMIT = 100;

export type IdFactory = (prefix: "n" | "e") => string;

export function randomId(prefix: "n" | "e"): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += (b % 36).toString(36);
  return `${prefix}_${s}`;
}

// ---------------------------------------------------------------------------
// Conversion

function toNode(n: NodeInstance, selected = false): GraphNode {
  return {
    id: n.id,
    type: "sling",
    position: { x: n.position.x, y: n.position.y },
    data: { type: n.type, version: n.version, label: n.label ?? "", config: n.config ?? {} },
    ...(selected ? { selected: true } : {}),
  };
}

function outputType(
  catalog: CatalogIndex,
  node: GraphNode | NodeInstance | undefined,
  port: string,
): string | null {
  if (!node) return null;
  const type = "data" in node ? node.data.type : node.type;
  const config = "data" in node ? node.data.config : node.config;
  const spec = catalog.byType.get(type);
  if (!spec) return null;
  return portsOf(spec, config).outputs.find((p) => p.name === port)?.type ?? null;
}

function toEdge(
  e: DefEdge,
  catalog: CatalogIndex,
  nodes: ReadonlyMap<string, NodeInstance | GraphNode>,
): GraphEdge {
  return {
    id: e.id,
    type: e.kind,
    source: e.from.node,
    sourceHandle: handleId(e.kind, e.from.port),
    target: e.to.node,
    targetHandle: handleId(e.kind, e.to.port),
    data: {
      portType: e.kind === "data" ? outputType(catalog, nodes.get(e.from.node), e.from.port) : null,
    },
  };
}

export function fromDefinition(def: WorkflowDefinition, catalog: CatalogIndex): GraphState {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  return {
    name: def.name,
    description: def.description ?? "",
    nodes: def.nodes.map((n) => toNode(n)),
    edges: def.edges.map((e) => toEdge(e, catalog, byId)),
    past: [],
    future: [],
    revision: 0,
    coalesce: null,
    dragOrigin: null,
  };
}

function toInstance(n: GraphNode): NodeInstance {
  return {
    id: n.id,
    type: n.data.type,
    version: n.data.version,
    ...(n.data.label ? { label: n.data.label } : {}),
    position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    config: n.data.config,
  };
}

function toDefEdge(e: GraphEdge): DefEdge | null {
  const from = parseHandle(e.sourceHandle);
  const to = parseHandle(e.targetHandle);
  if (!from || !to) return null;
  return {
    id: e.id,
    kind: from.kind,
    from: { node: e.source, port: from.port },
    to: { node: e.target, port: to.port },
  };
}

export function toDefinition(state: Pick<GraphState, "name" | "description" | "nodes" | "edges">) {
  const def: WorkflowDefinition = {
    schema: WORKFLOW_SCHEMA,
    name: state.name,
    description: state.description,
    nodes: state.nodes.map(toInstance),
    edges: state.edges.map(toDefEdge).filter((e): e is DefEdge => e !== null),
  };
  return def;
}

// ---------------------------------------------------------------------------
// History

function snapshot(state: GraphState): Snapshot {
  return { nodes: state.nodes, edges: state.edges };
}

/** Applies a change to the definition and records the previous graph for undo. */
function commit(
  state: GraphState,
  next: Partial<Snapshot>,
  coalesce: string | null = null,
): GraphState {
  const merge = coalesce !== null && state.coalesce === coalesce && state.past.length > 0;
  return {
    ...state,
    ...next,
    past: merge ? state.past : [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
    future: [],
    revision: state.revision + 1,
    coalesce,
  };
}

export function canUndo(state: GraphState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: GraphState): boolean {
  return state.future.length > 0;
}

export function undo(state: GraphState): GraphState {
  const prev = state.past[state.past.length - 1];
  if (!prev) return state;
  return {
    ...state,
    nodes: prev.nodes,
    edges: prev.edges,
    past: state.past.slice(0, -1),
    future: [snapshot(state), ...state.future],
    revision: state.revision + 1,
    coalesce: null,
    dragOrigin: null,
  };
}

export function redo(state: GraphState): GraphState {
  const next = state.future[0];
  if (!next) return state;
  return {
    ...state,
    nodes: next.nodes,
    edges: next.edges,
    past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
    future: state.future.slice(1),
    revision: state.revision + 1,
    coalesce: null,
    dragOrigin: null,
  };
}

// ---------------------------------------------------------------------------
// Lookups

export function nodeById(state: Pick<GraphState, "nodes">, id: string): GraphNode | undefined {
  return state.nodes.find((n) => n.id === id);
}

export function selectedNodeIds(state: Pick<GraphState, "nodes">): string[] {
  return state.nodes.filter((n) => n.selected).map((n) => n.id);
}

export function selectedEdgeIds(state: Pick<GraphState, "edges">): string[] {
  return state.edges.filter((e) => e.selected).map((e) => e.id);
}

// ---------------------------------------------------------------------------
// Connecting

export interface ConnectionRequest {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
}

export type ConnectionCheck =
  | { ok: true; kind: PortKind; replaces: string | null; portType: string | null }
  | { ok: false; reason: string };

function refuse(reason: string): ConnectionCheck {
  return { ok: false, reason };
}

function title(spec: NodeSpecView, node: GraphNode): string {
  return node.data.label || spec.title;
}

/**
 * Whether a connection is allowed, and why not if it isn't:
 * exec only to exec and data only to data, assignable data types, one edge
 * per data input, no self-loops. A second edge from an exec output replaces
 * the first, so that case is allowed and reports the edge it replaces.
 */
export function checkConnection(
  state: Pick<GraphState, "nodes" | "edges">,
  catalog: CatalogIndex,
  c: ConnectionRequest,
): ConnectionCheck {
  if (c.source === c.target) return refuse("A node can't connect to itself.");
  const from = parseHandle(c.sourceHandle);
  const to = parseHandle(c.targetHandle);
  if (!from || !to) return refuse("Connect a port to a port.");
  if (from.kind !== to.kind) {
    return refuse(
      from.kind === "exec"
        ? "Exec ports connect only to exec ports."
        : "Data ports connect only to data ports.",
    );
  }
  const src = nodeById(state, c.source);
  const dst = nodeById(state, c.target);
  if (!src || !dst) return refuse("That node no longer exists.");
  const srcSpec = catalog.byType.get(src.data.type);
  const dstSpec = catalog.byType.get(dst.data.type);
  if (!srcSpec) return refuse(`Unknown node type ${src.data.type}.`);
  if (!dstSpec) return refuse(`Unknown node type ${dst.data.type}.`);
  const srcPorts = portsOf(srcSpec, src.data.config);
  const dstPorts = portsOf(dstSpec, dst.data.config);
  const duplicate = state.edges.some(
    (e) =>
      e.source === c.source &&
      e.sourceHandle === c.sourceHandle &&
      e.target === c.target &&
      e.targetHandle === c.targetHandle,
  );

  if (from.kind === "exec") {
    if (!srcPorts.execOut.some((p) => p.name === from.port)) {
      return refuse(`${title(srcSpec, src)} has no exec output "${from.port}".`);
    }
    if (!dstPorts.execIn || to.port !== EXEC_IN) {
      return refuse(
        dstSpec.isTrigger
          ? "Triggers start a run, so nothing can lead into them."
          : `${title(dstSpec, dst)} has no exec input "${to.port}".`,
      );
    }
    if (duplicate) return refuse("These ports are already connected.");
    const existing = state.edges.find(
      (e) => e.source === c.source && e.sourceHandle === c.sourceHandle,
    );
    return { ok: true, kind: "exec", replaces: existing?.id ?? null, portType: null };
  }

  const out = srcPorts.outputs.find((p) => p.name === from.port);
  if (!out) return refuse(`${title(srcSpec, src)} has no output "${from.port}".`);
  const input = dstPorts.inputs.find((p) => p.name === to.port);
  if (!input) return refuse(`${title(dstSpec, dst)} has no input "${to.port}".`);
  if (!isAssignable(out.type, input.type)) {
    return refuse(`A ${out.type} output can't connect to a ${input.type} input.`);
  }
  if (duplicate) return refuse("These ports are already connected.");
  if (state.edges.some((e) => e.target === c.target && e.targetHandle === c.targetHandle)) {
    return refuse(`"${input.label ?? input.name}" already has a connection. Remove it first.`);
  }
  return { ok: true, kind: "data", replaces: null, portType: out.type };
}

export function connect(
  state: GraphState,
  catalog: CatalogIndex,
  c: ConnectionRequest,
  newId: IdFactory = randomId,
): { state: GraphState; check: ConnectionCheck } {
  const check = checkConnection(state, catalog, c);
  if (!check.ok) return { state, check };
  const edges = check.replaces ? state.edges.filter((e) => e.id !== check.replaces) : state.edges;
  const edge: GraphEdge = {
    id: newId("e"),
    type: check.kind,
    source: c.source,
    sourceHandle: c.sourceHandle ?? null,
    target: c.target,
    targetHandle: c.targetHandle ?? null,
    data: { portType: check.portType },
  };
  return { state: commit(state, { edges: [...edges, edge] }), check };
}

// ---------------------------------------------------------------------------
// Selection

function withSelection(nodes: GraphNode[], ids: ReadonlySet<string>): GraphNode[] {
  let changed = false;
  const next = nodes.map((n) => {
    const want = ids.has(n.id);
    if (Boolean(n.selected) === want) return n;
    changed = true;
    return { ...n, selected: want };
  });
  return changed ? next : nodes;
}

function withEdgeSelection(edges: GraphEdge[], ids: ReadonlySet<string>): GraphEdge[] {
  let changed = false;
  const next = edges.map((e) => {
    const want = ids.has(e.id);
    if (Boolean(e.selected) === want) return e;
    changed = true;
    return { ...e, selected: want };
  });
  return changed ? next : edges;
}

/** Selects exactly these nodes and edges. Not an undoable change. */
export function select(
  state: GraphState,
  nodeIds: Iterable<string>,
  edgeIds: Iterable<string> = [],
): GraphState {
  const nodes = withSelection(state.nodes, new Set(nodeIds));
  const edges = withEdgeSelection(state.edges, new Set(edgeIds));
  if (nodes === state.nodes && edges === state.edges) return state;
  return { ...state, nodes, edges };
}

export function selectAll(state: GraphState): GraphState {
  return select(
    state,
    state.nodes.map((n) => n.id),
    state.edges.map((e) => e.id),
  );
}

// ---------------------------------------------------------------------------
// Adding, removing and editing

export function addNode(
  state: GraphState,
  spec: NodeSpecView,
  position: { x: number; y: number },
  newId: IdFactory = randomId,
): { state: GraphState; id: string } {
  const id = newId("n");
  const node: GraphNode = {
    id,
    type: "sling",
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    data: { type: spec.type, version: spec.version, label: "", config: defaultConfig(spec) },
    selected: true,
  };
  const nodes = [...withSelection(state.nodes, new Set()), node];
  const edges = withEdgeSelection(state.edges, new Set());
  return { state: commit(state, { nodes, edges }), id };
}

export function removeElements(
  state: GraphState,
  nodeIds: Iterable<string>,
  edgeIds: Iterable<string> = [],
): GraphState {
  const nodes = new Set(nodeIds);
  const edges = new Set(edgeIds);
  if (nodes.size === 0 && edges.size === 0) return state;
  return commit(state, {
    nodes: state.nodes.filter((n) => !nodes.has(n.id)),
    edges: state.edges.filter(
      (e) => !edges.has(e.id) && !nodes.has(e.source) && !nodes.has(e.target),
    ),
  });
}

export function deleteSelection(state: GraphState): GraphState {
  return removeElements(state, selectedNodeIds(state), selectedEdgeIds(state));
}

function replaceNodeData(
  state: GraphState,
  nodeId: string,
  update: (data: NodeData) => NodeData,
): GraphNode[] | null {
  let found = false;
  const nodes = state.nodes.map((n) => {
    if (n.id !== nodeId) return n;
    found = true;
    return { ...n, data: update(n.data) };
  });
  return found ? nodes : null;
}

/**
 * Replaces a node's config. Exec outputs can come from config (switch cases,
 * classifier labels), so edges from ports that no longer exist are removed in
 * the same step. Undo brings them back.
 */
export function updateConfig(
  state: GraphState,
  catalog: CatalogIndex,
  nodeId: string,
  config: Record<string, unknown>,
  coalesce: string | null = `config:${nodeId}`,
): GraphState {
  const nodes = replaceNodeData(state, nodeId, (d) => ({ ...d, config }));
  if (!nodes) return state;
  const node = nodes.find((n) => n.id === nodeId) as GraphNode;
  const spec = catalog.byType.get(node.data.type);
  let edges = state.edges;
  if (spec) {
    const ports = portsOf(spec, config);
    const exec = new Set(ports.execOut.map((p) => handleId("exec", p.name)));
    const data = new Set(ports.outputs.map((p) => handleId("data", p.name)));
    const kept = edges.filter(
      (e) =>
        e.source !== nodeId ||
        exec.has(e.sourceHandle ?? "") ||
        data.has(e.sourceHandle ?? "") ||
        !parseHandle(e.sourceHandle),
    );
    if (kept.length !== edges.length) edges = kept;
  }
  return commit(state, { nodes, edges }, coalesce);
}

export function updateLabel(state: GraphState, nodeId: string, label: string): GraphState {
  const nodes = replaceNodeData(state, nodeId, (d) => ({ ...d, label }));
  return nodes ? commit(state, { nodes }, `label:${nodeId}`) : state;
}

/** Name and description belong to the definition but aren't undoable. */
export function setMeta(
  state: GraphState,
  meta: { name?: string; description?: string },
): GraphState {
  return { ...state, ...meta, revision: state.revision + 1 };
}

// ---------------------------------------------------------------------------
// Copy and paste

export interface Fragment {
  nodes: NodeInstance[];
  edges: DefEdge[];
}

/** Selected nodes and the edges between them. */
export function copySelection(state: GraphState): Fragment | null {
  const picked = state.nodes.filter((n) => n.selected);
  if (picked.length === 0) return null;
  const ids = new Set(picked.map((n) => n.id));
  return {
    nodes: picked.map((n) => structuredClone(toInstance(n))),
    edges: state.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map(toDefEdge)
      .filter((e): e is DefEdge => e !== null),
  };
}

/** Adds a copy of a fragment with fresh IDs, offset, and selects the copy. */
export function paste(
  state: GraphState,
  catalog: CatalogIndex,
  fragment: Fragment,
  offset = { x: 40, y: 40 },
  newId: IdFactory = randomId,
): GraphState {
  if (fragment.nodes.length === 0) return state;
  const map = new Map<string, string>();
  const used = new Set(state.nodes.map((n) => n.id));
  for (const n of fragment.nodes) {
    let id = newId("n");
    while (used.has(id)) id = newId("n");
    used.add(id);
    map.set(n.id, id);
  }
  const added = fragment.nodes.map((n) =>
    toNode(
      {
        ...structuredClone(n),
        id: map.get(n.id) as string,
        position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      },
      true,
    ),
  );
  const byId = new Map<string, GraphNode>(added.map((n) => [n.id, n]));
  const addedEdges: GraphEdge[] = [];
  for (const e of fragment.edges) {
    const source = map.get(e.from.node);
    const target = map.get(e.to.node);
    if (!source || !target) continue;
    const edge = toEdge(
      {
        ...e,
        id: newId("e"),
        from: { node: source, port: e.from.port },
        to: { node: target, port: e.to.port },
      },
      catalog,
      byId,
    );
    addedEdges.push({ ...edge, selected: true });
  }
  return commit(state, {
    nodes: [...withSelection(state.nodes, new Set()), ...added],
    edges: [...withEdgeSelection(state.edges, new Set()), ...addedEdges],
  });
}

// ---------------------------------------------------------------------------
// Changes from React Flow

/**
 * Applies React Flow's node changes. Selection and measured sizes aren't part
 * of the definition. Moves are: a drag lands in history once, when it ends
 * (see `endDrag`), and keyboard nudges in a row share one history entry.
 */
export function applyNodeChanges(state: GraphState, changes: NodeChange<GraphNode>[]): GraphState {
  const relevant = changes.filter(
    (c) => c.type === "position" || c.type === "dimensions" || c.type === "select",
  );
  if (relevant.length === 0) return state;
  const moved = relevant.some((c) => c.type === "position" && c.position);
  const nodes = rfApplyNodeChanges(relevant, state.nodes);
  if (!moved) return { ...state, nodes };
  if (state.dragOrigin) return { ...state, nodes, revision: state.revision + 1 };
  return commit(state, { nodes }, "nudge");
}

/** Only selection comes from React Flow. Deleting goes through `deleteSelection`. */
export function applyEdgeChanges(state: GraphState, changes: EdgeChange<GraphEdge>[]): GraphState {
  const relevant = changes.filter((c) => c.type === "select");
  if (relevant.length === 0) return state;
  return { ...state, edges: rfApplyEdgeChanges(relevant, state.edges) };
}

export function beginDrag(state: GraphState): GraphState {
  if (state.dragOrigin) return state;
  return { ...state, dragOrigin: snapshot(state) };
}

export function endDrag(state: GraphState): GraphState {
  const origin = state.dragOrigin;
  if (!origin) return state;
  const moved =
    origin.nodes !== state.nodes &&
    origin.nodes.some((n, i) => {
      const now = state.nodes[i];
      return (
        !now ||
        now.id !== n.id ||
        now.position.x !== n.position.x ||
        now.position.y !== n.position.y
      );
    });
  if (!moved) return { ...state, dragOrigin: null };
  return {
    ...state,
    dragOrigin: null,
    past: [...state.past, origin].slice(-HISTORY_LIMIT),
    future: [],
    coalesce: null,
  };
}
