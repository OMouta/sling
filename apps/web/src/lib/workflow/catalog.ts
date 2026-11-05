import {
  type AnyNodeSpec,
  EXEC_ERROR,
  EXEC_IN,
  type ExecPortSpec,
  execOutputsOf,
  type NamedTypeView,
  type NodeCatalog,
  type NodeCategory,
  type NodeSpecView,
  type PortSpec,
  parseType,
} from "@sling/workflow";
import { defaultsFor } from "../schemaForm.ts";

/** The node catalog, indexed for lookups while rendering and connecting. */
export interface CatalogIndex {
  nodes: NodeSpecView[];
  byType: ReadonlyMap<string, NodeSpecView>;
  types: ReadonlyMap<string, NamedTypeView>;
}

export function indexCatalog(catalog: NodeCatalog): CatalogIndex {
  return {
    nodes: catalog.nodes,
    byType: new Map(catalog.nodes.map((n) => [n.type, n])),
    types: new Map(catalog.types.map((t) => [t.name, t])),
  };
}

export type PortKind = "exec" | "data";

/**
 * React Flow handle IDs carry the port kind, so an exec port and a data port
 * may share a name on the same node.
 */
export function handleId(kind: PortKind, port: string): string {
  return `${kind === "exec" ? "x" : "d"}:${port}`;
}

export function parseHandle(
  id: string | null | undefined,
): { kind: PortKind; port: string } | null {
  if (!id || id.length < 3 || id[1] !== ":") return null;
  const kind = id[0] === "x" ? "exec" : id[0] === "d" ? "data" : null;
  return kind ? { kind, port: id.slice(2) } : null;
}

/**
 * Data output every node that can fail gets next to its `error` exec output.
 * It holds `{ message, code }` when the failure follows that port.
 */
export const ERROR_OUTPUT: PortSpec = {
  name: EXEC_ERROR,
  type: "json",
  label: "error",
  description: "The failure, as { message, code }",
};

export interface NodePorts {
  execIn: boolean;
  execOut: ExecPortSpec[];
  inputs: PortSpec[];
  outputs: PortSpec[];
}

/** `execOutputsOf` reads only the exec fields, which the view carries too. */
export function execOutputs(spec: NodeSpecView, config: Record<string, unknown>): ExecPortSpec[] {
  const shape: Pick<AnyNodeSpec, "execOutputs" | "dynamicExecOutputs"> = {
    execOutputs: spec.execOutputs,
    dynamicExecOutputs: spec.dynamicExecOutputs ?? undefined,
  };
  return execOutputsOf(shape as AnyNodeSpec, config);
}

/** Every port a node instance has, including config-driven and error ports. */
export function portsOf(spec: NodeSpecView, config: Record<string, unknown>): NodePorts {
  const execOut = execOutputs(spec, config);
  const outputs = [...spec.outputs];
  if (!spec.isTrigger) {
    if (!execOut.some((p) => p.name === EXEC_ERROR)) execOut.push({ name: EXEC_ERROR });
    if (!outputs.some((p) => p.name === EXEC_ERROR)) outputs.push(ERROR_OUTPUT);
  }
  return {
    execIn: spec.execInput && !spec.isTrigger,
    execOut,
    inputs: spec.inputs,
    outputs,
  };
}

export function hasExecInput(ports: NodePorts, port: string): boolean {
  return ports.execIn && port === EXEC_IN;
}

export function defaultConfig(spec: NodeSpecView): Record<string, unknown> {
  return defaultsFor(spec.configSchema);
}

export const CATEGORY_ORDER: NodeCategory[] = [
  "trigger",
  "logic",
  "data",
  "ai",
  "agent",
  "action",
  "human",
  "state",
  "composition",
];

export const CATEGORY_LABEL: Record<NodeCategory, string> = {
  trigger: "Triggers",
  logic: "Logic",
  data: "Data",
  ai: "AI",
  agent: "Agent",
  action: "Actions",
  human: "Human",
  state: "State",
  composition: "Composition",
};

const CATEGORY_COLOR: Record<NodeCategory, string> = {
  trigger: "#f59e0b",
  logic: "#8b5cf6",
  data: "#06b6d4",
  ai: "#ec4899",
  agent: "#6366f1",
  action: "#3b82f6",
  human: "#f97316",
  state: "#10b981",
  composition: "#64748b",
};

export function categoryColor(category: string): string {
  return CATEGORY_COLOR[category as NodeCategory] ?? "#64748b";
}

const TYPE_COLOR: Record<string, string> = {
  any: "#9ca3af",
  string: "#22c55e",
  number: "#3b82f6",
  boolean: "#ef4444",
  json: "#a855f7",
  email: "#14b8a6",
  "discord.message": "#6366f1",
  conversation: "#06b6d4",
  task: "#eab308",
  approval: "#f97316",
  "http.response": "#ec4899",
};

const FALLBACK = ["#84cc16", "#0ea5e9", "#d946ef", "#f43f5e", "#14b8a6", "#f59e0b"];

/** Color for a port type. Lists take their element's color. */
export function typeColor(type: string | null | undefined): string {
  if (!type) return TYPE_COLOR.any as string;
  const parsed = parseType(type);
  let base = type;
  if (parsed?.kind === "list") {
    let inner = parsed.of;
    while (inner.kind === "list") inner = inner.of;
    base = inner.name;
  }
  const known = TYPE_COLOR[base];
  if (known) return known;
  let h = 0;
  for (const ch of base) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length] as string;
}

export function isListType(type: string): boolean {
  return parseType(type)?.kind === "list";
}
