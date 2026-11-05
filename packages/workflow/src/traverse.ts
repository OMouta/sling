import type { NodeInstance, PortRef, WorkflowDefinition } from "./definition.ts";
import { EXEC_ERROR } from "./definition.ts";
import type { PortSpec, WaitResolution } from "./spec.ts";

/** The loop node. The engine keeps a frame per active loop. */
export const LOOP_NODE = "core.for_each";
/** Ends the run and sets its output. */
export const RETURN_NODE = "core.return";
/** Loop exec outputs. */
export const LOOP_EACH = "each";
export const LOOP_DONE = "done";
/** Exec output a trigger leaves through. */
export const TRIGGER_NEXT = "next";

export const MAX_LOOP_ITEMS = 1000;
export const MAX_NODE_RUNS = 10_000;

export class TraversalError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "TraversalError";
    this.code = code;
  }
}

export interface LoopFrame {
  /** The `core.for_each` node. */
  nodeId: string;
  items: unknown[];
  index: number;
}

/** A node that was running when the cursor was saved. */
export interface InFlight {
  nodeId: string;
  nodeRunId: string;
  iteration: number;
  attempt: number;
}

/** A node parked on a wait. Inputs and config are kept so `resume` sees what `run` saw. */
export interface Parked extends InFlight {
  waitId: string;
  inputs: Record<string, unknown>;
  config: Record<string, unknown>;
  /** Outputs returned with the wait. What `resume` returns is merged over them. */
  outputs: Record<string, unknown>;
  /** Filled in when the wait resolves, before the run is queued again. */
  resolution?: WaitResolution;
}

/** Everything the engine needs to continue a run. Plain JSON. */
export interface Cursor {
  /** Node to run next. Null once the run has nowhere left to go. */
  next: string | null;
  /** Outputs of nodes that ran, by node ID. A loop body's outputs reset each iteration. */
  outputs: Record<string, Record<string, unknown>>;
  vars: Record<string, unknown>;
  frames: LoopFrame[];
  /** Runs per node so far, which is also the node's next iteration number. */
  counts: Record<string, number>;
  /** Node runs in this run, the trigger included. */
  nodeRuns: number;
  inFlight: InFlight | null;
  parked: Parked | null;
}

export interface Graph {
  nodes: Map<string, NodeInstance>;
  /** Exec target by `node:port`. */
  exec: Map<string, string>;
  /** Data source by `node:input`. */
  data: Map<string, PortRef>;
  /** Node IDs in each loop's body, by loop node ID. */
  bodies: Map<string, Set<string>>;
}

const k = (node: string, port: string) => `${node}\u0000${port}`;

/**
 * Indexes a definition for traversal. Assumes it passed validation: the
 * first edge wins where validation would have reported a duplicate.
 */
export function buildGraph(definition: WorkflowDefinition): Graph {
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const exec = new Map<string, string>();
  const data = new Map<string, PortRef>();
  for (const e of definition.edges) {
    if (e.kind === "exec") {
      const key = k(e.from.node, e.from.port);
      if (!exec.has(key)) exec.set(key, e.to.node);
    } else {
      const key = k(e.to.node, e.to.port);
      if (!data.has(key)) data.set(key, e.from);
    }
  }
  const graph: Graph = { nodes, exec, data, bodies: new Map() };
  for (const n of definition.nodes) {
    if (n.type === LOOP_NODE) graph.bodies.set(n.id, loopBody(graph, n.id));
  }
  return graph;
}

/** Nodes reachable from a loop's `each` output without passing back through the loop. */
export function loopBody(graph: Pick<Graph, "exec">, loopId: string): Set<string> {
  const body = new Set<string>();
  const start = graph.exec.get(k(loopId, LOOP_EACH));
  if (!start || start === loopId) return body;
  const next = new Map<string, string[]>();
  for (const [key, target] of graph.exec) {
    const from = key.slice(0, key.indexOf("\u0000"));
    const list = next.get(from) ?? [];
    list.push(target);
    next.set(from, list);
  }
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === loopId || body.has(id)) continue;
    body.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return body;
}

export function execTarget(graph: Graph, nodeId: string, port: string): string | null {
  return graph.exec.get(k(nodeId, port)) ?? null;
}

export function dataSource(graph: Graph, nodeId: string, input: string): PortRef | null {
  return graph.data.get(k(nodeId, input)) ?? null;
}

export function hasErrorRoute(graph: Graph, nodeId: string): boolean {
  return execTarget(graph, nodeId, EXEC_ERROR) !== null;
}

/** The cursor right after a trigger fired with these outputs. */
export function initialCursor(
  graph: Graph,
  triggerNodeId: string,
  outputs: Record<string, unknown>,
): Cursor {
  const c: Cursor = {
    next: null,
    outputs: { [triggerNodeId]: outputs },
    vars: {},
    frames: [],
    counts: { [triggerNodeId]: 1 },
    nodeRuns: 1,
    inFlight: null,
    parked: null,
  };
  return advance(graph, c, triggerNodeId, TRIGGER_NEXT);
}

/** Reads a stored cursor, filling in fields an older shape may lack. */
export function parseCursor(raw: unknown): Cursor {
  const c = (raw ?? {}) as Partial<Cursor>;
  return {
    next: typeof c.next === "string" ? c.next : null,
    outputs: c.outputs ?? {},
    vars: c.vars ?? {},
    frames: Array.isArray(c.frames) ? c.frames : [],
    counts: c.counts ?? {},
    nodeRuns: typeof c.nodeRuns === "number" ? c.nodeRuns : 0,
    inFlight: c.inFlight ?? null,
    parked: c.parked ?? null,
  };
}

/** The iteration number the next run of this node gets. */
export function iterationOf(cursor: Cursor, nodeId: string): number {
  return cursor.counts[nodeId] ?? 0;
}

export function idempotencyKey(runId: string, nodeId: string, iteration: number): string {
  return `${runId}:${nodeId}:${iteration}`;
}

/** Counts a finished node run and stores its outputs. */
export function recordRun(
  cursor: Cursor,
  nodeId: string,
  outputs: Record<string, unknown>,
): Cursor {
  return {
    ...cursor,
    outputs: { ...cursor.outputs, [nodeId]: outputs },
    counts: { ...cursor.counts, [nodeId]: (cursor.counts[nodeId] ?? 0) + 1 },
    nodeRuns: cursor.nodeRuns + 1,
  };
}

function clearBody(graph: Graph, cursor: Cursor, loopId: string): Cursor {
  const body = graph.bodies.get(loopId);
  if (!body || body.size === 0) return cursor;
  const outputs = { ...cursor.outputs };
  for (const id of body) delete outputs[id];
  return { ...cursor, outputs };
}

/**
 * Moves on from a node through one of its exec outputs. An edge into a loop
 * that's running continues that loop. With no edge, the innermost loop moves
 * to its next item, or the run ends.
 */
export function advance(graph: Graph, cursor: Cursor, fromNodeId: string, port: string): Cursor {
  const target = execTarget(graph, fromNodeId, port);
  if (target !== null) {
    const frame = cursor.frames.findLastIndex((f) => f.nodeId === target);
    if (frame >= 0) return continueLoop(graph, cursor, frame);
    return { ...cursor, next: target };
  }
  if (cursor.frames.length > 0) return continueLoop(graph, cursor, cursor.frames.length - 1);
  return { ...cursor, next: null };
}

/** Starts a loop over `items`, or leaves through `done` if there are none. */
export function enterLoop(
  graph: Graph,
  cursor: Cursor,
  loopId: string,
  items: readonly unknown[],
): Cursor {
  if (items.length > MAX_LOOP_ITEMS) {
    throw new TraversalError(
      `A loop can run at most ${MAX_LOOP_ITEMS} times, and got ${items.length} items`,
      "loop_limit",
    );
  }
  if (items.length === 0) return advance(graph, cursor, loopId, LOOP_DONE);
  const frames = [...cursor.frames, { nodeId: loopId, items: [...items], index: 0 }];
  const c = clearBody(graph, { ...cursor, frames }, loopId);
  return startIteration(graph, c, loopId, items[0], 0);
}

function startIteration(
  graph: Graph,
  cursor: Cursor,
  loopId: string,
  item: unknown,
  index: number,
): Cursor {
  const c = { ...cursor, outputs: { ...cursor.outputs, [loopId]: { item, index } } };
  const target = execTarget(graph, loopId, LOOP_EACH);
  if (target === null || target === loopId) {
    // An empty body: nothing runs per item.
    return continueLoop(graph, c, c.frames.length - 1);
  }
  return { ...c, next: target };
}

function continueLoop(graph: Graph, cursor: Cursor, frameIndex: number): Cursor {
  // Leaving inner loops through an edge to an outer one drops their frames.
  const frames = cursor.frames.slice(0, frameIndex + 1);
  const frame = frames[frameIndex] as LoopFrame;
  const nextIndex = frame.index + 1;
  if (nextIndex < frame.items.length) {
    const updated = { ...frame, index: nextIndex };
    const c = clearBody(
      graph,
      { ...cursor, frames: [...frames.slice(0, -1), updated] },
      frame.nodeId,
    );
    return startIteration(graph, c, frame.nodeId, frame.items[nextIndex], nextIndex);
  }
  const c = { ...cursor, frames: frames.slice(0, -1) };
  return advance(graph, c, frame.nodeId, LOOP_DONE);
}

/**
 * Resolves data inputs from the outputs of nodes that already ran. An input
 * whose source didn't run is null. An input with no edge takes the config
 * value of the same name, if any, which may be an expression the caller
 * evaluates.
 */
export function resolveInputs(
  graph: Graph,
  cursor: Cursor,
  node: NodeInstance,
  ports: readonly PortSpec[],
): { inputs: Record<string, unknown>; fromConfig: string[] } {
  const inputs: Record<string, unknown> = {};
  const fromConfig: string[] = [];
  for (const port of ports) {
    const src = dataSource(graph, node.id, port.name);
    if (src) {
      const out = cursor.outputs[src.node];
      const v = out ? out[src.port] : undefined;
      inputs[port.name] = v === undefined ? null : v;
    } else if (node.config[port.name] !== undefined) {
      inputs[port.name] = node.config[port.name];
      fromConfig.push(port.name);
    } else {
      inputs[port.name] = null;
    }
  }
  return { inputs, fromConfig };
}

/** Required inputs that resolved to nothing. */
export function missingInputs(
  ports: readonly PortSpec[],
  inputs: Record<string, unknown>,
): string[] {
  return ports
    .filter((p) => p.required && (inputs[p.name] === null || inputs[p.name] === undefined))
    .map((p) => p.name);
}
