import type { ValidationIssue } from "./api.ts";
import {
  EXEC_IN,
  expressionSource,
  isExpression,
  type NodeInstance,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from "./definition.ts";
import { checkExpression } from "./expression.ts";
import {
  dataOutputs,
  execOutputNames,
  isTrigger,
  type PortedSpec,
  type SpecLookup,
} from "./ports.ts";
import { LOOP_EACH, LOOP_NODE } from "./traverse.ts";
import { isAssignable } from "./types.ts";

interface SafeParser {
  safeParse(value: unknown): {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
}

function hasSafeParse(schema: unknown): schema is SafeParser {
  return (
    typeof schema === "object" &&
    schema !== null &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

/** Parses unknown JSON as a definition, returning shape issues instead of throwing. */
export function parseDefinition(
  raw: unknown,
): { ok: true; definition: WorkflowDefinition } | { ok: false; issues: ValidationIssue[] } {
  const r = WorkflowDefinitionSchema.safeParse(raw);
  if (r.success) return { ok: true, definition: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({
      code: "invalid_shape",
      message: `${i.path.join(".") || "definition"}: ${i.message}`,
    })),
  };
}

/**
 * Config keys that may hold `={{ … }}`: the spec's expression fields, and
 * keys named after an input, which are that input's default.
 */
export function expressionKeys(spec: Pick<PortedSpec, "expressionFields" | "inputs">): string[] {
  const keys = new Set(spec.expressionFields ?? []);
  for (const p of spec.inputs) keys.add(p.name);
  return [...keys];
}

function checkConfig(node: NodeInstance, spec: PortedSpec, issues: ValidationIssue[]) {
  const exprFields = new Set(expressionKeys(spec));
  const holdsExpression = (field: unknown) =>
    typeof field === "string" && exprFields.has(field) && isExpression(node.config[field]);

  if (hasSafeParse(spec.configSchema)) {
    const r = spec.configSchema.safeParse(node.config);
    if (!r.success) {
      for (const i of r.error?.issues ?? []) {
        // An expression's value is only known at run time.
        if (holdsExpression(i.path[0])) continue;
        const path = i.path.map(String).join(".");
        issues.push({
          code: "invalid_config",
          message: path ? `${path}: ${i.message}` : i.message,
          nodeId: node.id,
          ...(path ? { port: String(i.path[0]) } : {}),
        });
      }
    }
  }
  for (const key of exprFields) {
    const v = node.config[key];
    if (!isExpression(v)) continue;
    const err = checkExpression(expressionSource(v));
    if (err) {
      issues.push({ code: "invalid_expression", message: `${key}: ${err}`, nodeId: node.id });
    }
  }
  for (const extra of spec.checkConfig?.(node.config) ?? []) {
    issues.push({
      code: "invalid_config",
      message: extra.field ? `${extra.field}: ${extra.message}` : extra.message,
      nodeId: node.id,
    });
  }
}

/**
 * Checks a definition against the node registry. Returns every problem
 * found, each pointing at the node, edge, or port it's about. An empty list
 * means the definition can be published.
 */
export function validate(definition: WorkflowDefinition, registry: SpecLookup): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = new Map<string, NodeInstance>();
  const specs = new Map<string, PortedSpec>();

  for (const n of definition.nodes) {
    if (nodes.has(n.id)) {
      issues.push({
        code: "duplicate_node_id",
        message: `Two nodes share the ID ${n.id}`,
        nodeId: n.id,
      });
      continue;
    }
    nodes.set(n.id, n);
    const spec = registry.get(n.type, n.version);
    if (!spec) {
      issues.push({
        code: "unknown_node_type",
        message: `Unknown node type ${n.type} version ${n.version}`,
        nodeId: n.id,
      });
      continue;
    }
    specs.set(n.id, spec);
    checkConfig(n, spec, issues);
  }

  const edgeIds = new Set<string>();
  const execOut = new Map<string, string>();
  const dataIn = new Map<string, string>();
  const execEdges: { id: string; from: string; to: string }[] = [];
  const connectedInputs = new Set<string>();

  for (const e of definition.edges) {
    if (edgeIds.has(e.id)) {
      issues.push({
        code: "duplicate_edge_id",
        message: `Two edges share the ID ${e.id}`,
        edgeId: e.id,
      });
      continue;
    }
    edgeIds.add(e.id);
    const src = nodes.get(e.from.node);
    const dst = nodes.get(e.to.node);
    if (!src || !dst) {
      const missing = src ? e.to.node : e.from.node;
      issues.push({
        code: "unknown_node",
        message: `Edge ${e.id} points at a node that doesn't exist: ${missing}`,
        edgeId: e.id,
        nodeId: missing,
      });
      continue;
    }
    const srcSpec = specs.get(src.id);
    const dstSpec = specs.get(dst.id);
    if (!srcSpec || !dstSpec) continue;

    const execOuts = execOutputNames(srcSpec, src.config);
    const dataOuts = dataOutputs(srcSpec);
    const fromIsExec = execOuts.includes(e.from.port);
    const fromData = dataOuts.find((p) => p.name === e.from.port);
    const toIsExec = dstSpec.execInput && e.to.port === EXEC_IN;
    const toData = dstSpec.inputs.find((p) => p.name === e.to.port);

    const portIssue = (side: "from" | "to", isOther: boolean) => {
      const ref = e[side];
      issues.push({
        code: isOther ? "kind_mismatch" : "unknown_port",
        message: isOther
          ? `Edge ${e.id} is a ${e.kind} edge, but ${ref.node}.${ref.port} is a ${e.kind === "exec" ? "data" : "exec"} port`
          : `${ref.node} has no ${e.kind} ${side === "from" ? "output" : "input"} called ${ref.port}`,
        edgeId: e.id,
        nodeId: ref.node,
        port: ref.port,
      });
    };

    if (e.kind === "exec") {
      let ok = true;
      if (!fromIsExec) {
        portIssue("from", fromData !== undefined);
        ok = false;
      }
      if (!toIsExec) {
        portIssue("to", toData !== undefined);
        ok = false;
      }
      if (!ok) continue;
      const key = `${src.id}\u0000${e.from.port}`;
      if (execOut.has(key)) {
        issues.push({
          code: "duplicate_exec_edge",
          message: `Exec output ${src.id}.${e.from.port} already connects to ${execOut.get(key)}`,
          edgeId: e.id,
          nodeId: src.id,
          port: e.from.port,
        });
        continue;
      }
      execOut.set(key, dst.id);
      execEdges.push({ id: e.id, from: src.id, to: dst.id });
    } else {
      let ok = true;
      if (!fromData) {
        portIssue("from", fromIsExec);
        ok = false;
      }
      if (!toData) {
        portIssue("to", e.to.port === EXEC_IN && dstSpec.execInput);
        ok = false;
      }
      if (!ok || !fromData || !toData) continue;
      const key = `${dst.id}\u0000${e.to.port}`;
      connectedInputs.add(key);
      if (dataIn.has(key)) {
        issues.push({
          code: "duplicate_input",
          message: `Input ${dst.id}.${e.to.port} already has an edge (${dataIn.get(key)})`,
          edgeId: e.id,
          nodeId: dst.id,
          port: e.to.port,
        });
        continue;
      }
      dataIn.set(key, e.id);
      if (!isAssignable(fromData.type, toData.type)) {
        issues.push({
          code: "type_mismatch",
          message: `${src.id}.${fromData.name} is ${fromData.type}, which can't connect to ${dst.id}.${toData.name} (${toData.type})`,
          edgeId: e.id,
          nodeId: dst.id,
          port: toData.name,
        });
      }
    }
  }

  for (const [id, spec] of specs) {
    const node = nodes.get(id) as NodeInstance;
    for (const p of spec.inputs) {
      if (!p.required || connectedInputs.has(`${id}\u0000${p.name}`)) continue;
      const v = node.config[p.name];
      if (v === undefined || v === null || v === "") {
        issues.push({
          code: "missing_input",
          message: `Input ${p.name} on ${id} needs an edge or a value in config`,
          nodeId: id,
          port: p.name,
        });
      }
    }
  }

  // Reachability and cycles, over valid exec edges only.
  const next = new Map<string, { id: string; to: string }[]>();
  for (const e of execEdges) {
    const list = next.get(e.from) ?? [];
    list.push({ id: e.id, to: e.to });
    next.set(e.from, list);
  }
  const triggers = [...specs].filter(([, s]) => isTrigger(s)).map(([id]) => id);
  if (triggers.length === 0) {
    issues.push({ code: "no_trigger", message: "The workflow needs a trigger node" });
  } else {
    const seen = new Set<string>(triggers);
    const stack = [...triggers];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      for (const e of next.get(id) ?? []) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          stack.push(e.to);
        }
      }
    }
    for (const [id, spec] of specs) {
      if (!seen.has(id) && !isTrigger(spec)) {
        issues.push({
          code: "unreachable",
          message: `${id} can't be reached from a trigger`,
          nodeId: id,
        });
      }
    }
  }

  // An edge from inside a loop's body back to the loop moves to the next
  // item. Any other cycle never ends.
  const loopBack = new Set<string>();
  for (const [id, n] of nodes) {
    if (n.type !== LOOP_NODE) continue;
    const body = new Set<string>();
    const start = execOut.get(`${id}\u0000${LOOP_EACH}`);
    const stack = start ? [start] : [];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === id || body.has(cur)) continue;
      body.add(cur);
      for (const e of next.get(cur) ?? []) stack.push(e.to);
    }
    for (const e of execEdges) {
      if (e.to === id && (body.has(e.from) || e.from === id)) loopBack.add(e.id);
    }
  }
  const state = new Map<string, 1 | 2>();
  const reported = new Set<string>();
  const visit = (start: string) => {
    // Iterative DFS: 1 = on the stack, 2 = done.
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: string; i: number };
      const out = (next.get(top.id) ?? []).filter((e) => !loopBack.has(e.id));
      if (top.i >= out.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const e = out[top.i++] as { id: string; to: string };
      const s = state.get(e.to);
      if (s === 1) {
        if (!reported.has(e.id)) {
          reported.add(e.id);
          issues.push({
            code: "cycle",
            message: `Exec edge ${e.id} from ${top.id} to ${e.to} closes a cycle. Use core.for_each to repeat steps.`,
            edgeId: e.id,
            nodeId: e.to,
          });
        }
      } else if (s === undefined) {
        state.set(e.to, 1);
        stack.push({ id: e.to, i: 0 });
      }
    }
  };
  for (const id of nodes.keys()) if (!state.has(id)) visit(id);

  return issues;
}
