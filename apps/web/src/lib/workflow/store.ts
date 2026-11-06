import type { NodeRunStatus, NodeRunView } from "@sling/core";
import type { NodeSpecView, ValidationIssue } from "@sling/workflow";
import { createContext, useContext, useSyncExternalStore } from "react";
import { type CatalogIndex, handleId } from "./catalog.ts";
import * as g from "./graph.ts";

/**
 * Handle IDs with an edge, per node, written `out:<handle>` and `in:<handle>`.
 * Rebuilt when the edges change; a node whose set didn't change keeps the
 * same object, so its component doesn't re-render.
 */
export type ConnectedIndex = ReadonlyMap<string, ReadonlySet<string>>;

/** Overlays that aren't part of the definition: validation issues and run status. */
export interface Decorations {
  issues: ValidationIssue[];
  nodeIssues: ReadonlyMap<string, ValidationIssue[]>;
  edgeIssues: ReadonlySet<string>;
  statuses: ReadonlyMap<string, NodeRunStatus>;
  /** Exec edges a run followed. */
  takenEdges: ReadonlySet<string>;
}

export interface EditorSnapshot {
  graph: g.GraphState;
  connected: ConnectedIndex;
  decor: Decorations;
}

const EMPTY_DECOR: Decorations = {
  issues: [],
  nodeIssues: new Map(),
  edgeIssues: new Set(),
  statuses: new Map(),
  takenEdges: new Set(),
};

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function indexConnected(edges: g.GraphEdge[], prev?: ConnectedIndex): ConnectedIndex {
  const sets = new Map<string, Set<string>>();
  const add = (node: string, key: string) => {
    let s = sets.get(node);
    if (!s) {
      s = new Set();
      sets.set(node, s);
    }
    s.add(key);
  };
  for (const e of edges) {
    add(e.source, `out:${e.sourceHandle ?? ""}`);
    add(e.target, `in:${e.targetHandle ?? ""}`);
  }
  const out = new Map<string, ReadonlySet<string>>();
  for (const [id, set] of sets) {
    const old = prev?.get(id);
    out.set(id, old && sameSet(old, set) ? old : set);
  }
  return out;
}

export function issueDecor(issues: ValidationIssue[]): Partial<Decorations> {
  const nodeIssues = new Map<string, ValidationIssue[]>();
  const edgeIssues = new Set<string>();
  for (const issue of issues) {
    if (issue.nodeId)
      nodeIssues.set(issue.nodeId, [...(nodeIssues.get(issue.nodeId) ?? []), issue]);
    if (issue.edgeId) edgeIssues.add(issue.edgeId);
  }
  return { issues, nodeIssues, edgeIssues };
}

/** The latest node run per node, in run order. */
export function latestNodeRuns(nodeRuns: NodeRunView[]): Map<string, NodeRunView> {
  const latest = new Map<string, NodeRunView>();
  for (const nr of sortNodeRuns(nodeRuns)) latest.set(nr.nodeId, nr);
  return latest;
}

export function sortNodeRuns(nodeRuns: NodeRunView[]): NodeRunView[] {
  return nodeRuns
    .map((nr, i) => ({ nr, i }))
    .sort((a, b) => a.nr.startedAt.localeCompare(b.nr.startedAt) || a.i - b.i)
    .map((x) => x.nr);
}

export function runDecor(nodeRuns: NodeRunView[], edges: g.GraphEdge[]): Partial<Decorations> {
  const latest = latestNodeRuns(nodeRuns);
  const statuses = new Map<string, NodeRunStatus>();
  for (const [id, nr] of latest) statuses.set(id, nr.status);
  const taken = new Set<string>();
  const ports = new Set(
    nodeRuns
      .filter((nr) => nr.execPort)
      .map((nr) => `${nr.nodeId}|${handleId("exec", nr.execPort as string)}`),
  );
  for (const e of edges) {
    if (e.type === "exec" && ports.has(`${e.source}|${e.sourceHandle}`)) taken.add(e.id);
  }
  return { statuses, takenEdges: taken };
}

/**
 * Holds one canvas's graph. Components subscribe with selectors through
 * `useGraph`, so a drag re-renders only the nodes and edges it touches.
 */
export class GraphStore {
  readonly catalog: CatalogIndex;
  readonly readOnly: boolean;
  #snap: EditorSnapshot;
  #listeners = new Set<() => void>();

  constructor(catalog: CatalogIndex, graph: g.GraphState, readOnly = false) {
    this.catalog = catalog;
    this.readOnly = readOnly;
    this.#snap = { graph, connected: indexConnected(graph.edges), decor: EMPTY_DECOR };
  }

  get = (): EditorSnapshot => this.#snap;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #emit() {
    for (const l of this.#listeners) l();
  }

  update(fn: (graph: g.GraphState) => g.GraphState) {
    const prev = this.#snap;
    const graph = fn(prev.graph);
    if (graph === prev.graph) return;
    this.#snap = {
      ...prev,
      graph,
      connected:
        graph.edges === prev.graph.edges
          ? prev.connected
          : indexConnected(graph.edges, prev.connected),
    };
    this.#emit();
  }

  decorate(patch: Partial<Decorations>) {
    this.#snap = { ...this.#snap, decor: { ...this.#snap.decor, ...patch } };
    this.#emit();
  }

  spec(type: string): NodeSpecView | undefined {
    return this.catalog.byType.get(type);
  }

  connect(c: g.ConnectionRequest): g.ConnectionCheck {
    let check: g.ConnectionCheck = { ok: false, reason: "" };
    this.update((graph) => {
      const r = g.connect(graph, this.catalog, c);
      check = r.check;
      return r.state;
    });
    return check;
  }

  /** Adds a step after the selected one when it can, else at `fallback`. Returns its ID. */
  addStep(spec: NodeSpecView, fallback: { x: number; y: number }): string {
    let id = "";
    this.update((graph) => {
      const r = g.addAfterSelection(graph, this.catalog, spec, fallback);
      id = r.id;
      return r.state;
    });
    return id;
  }

  addNode(spec: NodeSpecView, position: { x: number; y: number }): string {
    let id = "";
    this.update((graph) => {
      const r = g.addNode(graph, spec, position);
      id = r.id;
      return r.state;
    });
    return id;
  }
}

export const GraphStoreContext = createContext<GraphStore | null>(null);

export function useGraphStore(): GraphStore {
  const store = useContext(GraphStoreContext);
  if (!store) throw new Error("useGraphStore needs a GraphStoreContext provider");
  return store;
}

/** Subscribes to part of the store. The selector must return a stable value. */
export function useGraph<T>(selector: (s: EditorSnapshot) => T): T {
  const store = useGraphStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
