import { parseType } from "@sling/workflow";
import { type CatalogIndex, parseHandle, portsOf } from "./catalog.ts";
import type { GraphState } from "./graph.ts";

/** A path an expression can read, such as `inputs.email.subject`. */
export interface FieldPath {
  path: string;
  type: string;
  description?: string;
}

export interface AvailableFields {
  inputs: FieldPath[];
  trigger: FieldPath[];
  vars: FieldPath[];
}

type Schema = Record<string, unknown>;

function schemaType(s: Schema): string {
  const t = s.type;
  if (Array.isArray(t)) return t.filter((x) => x !== "null").join(" | ") || "any";
  if (typeof t === "string") return t;
  return "any";
}

/** Fields of a JSON Schema object, two levels deep. */
export function schemaPaths(prefix: string, schema: Schema, depth = 2): FieldPath[] {
  const out: FieldPath[] = [];
  const props = schema.properties as Record<string, Schema> | undefined;
  if (!props || depth === 0) return out;
  for (const [key, prop] of Object.entries(props)) {
    const path = /^[A-Za-z_$][\w$]*$/.test(key) ? `${prefix}.${key}` : `${prefix}.\`${key}\``;
    out.push({
      path,
      type: schemaType(prop),
      ...(typeof prop.description === "string" ? { description: prop.description } : {}),
    });
    out.push(...schemaPaths(path, prop, depth - 1));
  }
  return out;
}

/** A port's own path plus, for named types, the fields inside it. */
export function portPaths(catalog: CatalogIndex, prefix: string, type: string): FieldPath[] {
  const out: FieldPath[] = [{ path: prefix, type }];
  const parsed = parseType(type);
  if (parsed?.kind === "named") {
    const named = catalog.types.get(parsed.name);
    if (named) out.push(...schemaPaths(prefix, named.schema));
  }
  return out;
}

const VAR_NAME_KEYS = ["name", "key", "variable"];

/**
 * What an expression on `nodeId` can read: the node's connected data inputs
 * (with the fields of named types), the trigger's outputs, and run variables
 * set anywhere in the workflow.
 */
export function availableFields(
  state: Pick<GraphState, "nodes" | "edges">,
  catalog: CatalogIndex,
  nodeId: string,
): AvailableFields {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const node = byId.get(nodeId);
  const spec = node ? catalog.byType.get(node.data.type) : undefined;

  const inputs: FieldPath[] = [];
  for (const e of state.edges) {
    if (e.target !== nodeId || e.type !== "data") continue;
    const to = parseHandle(e.targetHandle);
    const from = parseHandle(e.sourceHandle);
    const src = byId.get(e.source);
    const srcSpec = src ? catalog.byType.get(src.data.type) : undefined;
    if (!to || !from || !src || !srcSpec) continue;
    const out = portsOf(srcSpec, src.data.config).outputs.find((p) => p.name === from.port);
    const declared = spec?.inputs.find((p) => p.name === to.port);
    inputs.push(...portPaths(catalog, `inputs.${to.port}`, out?.type ?? declared?.type ?? "any"));
  }

  const trigger: FieldPath[] = [];
  const seen = new Set<string>();
  for (const n of state.nodes) {
    const s = catalog.byType.get(n.data.type);
    if (!s?.isTrigger) continue;
    for (const p of s.outputs) {
      for (const f of portPaths(catalog, `trigger.${p.name}`, p.type)) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        trigger.push(f);
      }
    }
  }

  const vars: FieldPath[] = [];
  const varNames = new Set<string>();
  for (const n of state.nodes) {
    if (n.data.type !== "core.set_var") continue;
    for (const k of VAR_NAME_KEYS) {
      const v = n.data.config[k];
      if (typeof v === "string" && /^[A-Za-z_$][\w$]*$/.test(v)) {
        varNames.add(v);
        break;
      }
    }
  }
  for (const name of [...varNames].sort()) vars.push({ path: `vars.${name}`, type: "any" });

  return { inputs, trigger, vars };
}
