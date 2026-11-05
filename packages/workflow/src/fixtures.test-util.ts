import { z } from "zod";
import type { Edge, NodeInstance, WorkflowDefinition } from "./definition.ts";
import { expressionSource, isExpression, WORKFLOW_SCHEMA } from "./definition.ts";
import { checkExpression } from "./expression.ts";
import { type PortedSpec, specLookup } from "./ports.ts";

const base = { version: 1, inputs: [], outputs: [], execOutputs: [{ name: "next" }] };

/** Small specs shaped like the real core nodes, for validation and traversal tests. */
export const SPECS: PortedSpec[] = [
  {
    ...base,
    type: "t.trigger",
    execInput: false,
    outputs: [
      { name: "payload", type: "json" },
      { name: "items", type: "list<any>" },
      { name: "text", type: "string" },
    ],
  },
  {
    ...base,
    type: "t.step",
    execInput: true,
    inputs: [{ name: "value", type: "any" }],
    outputs: [{ name: "result", type: "json" }],
  },
  {
    ...base,
    type: "t.text",
    execInput: true,
    inputs: [{ name: "text", type: "string", required: true }],
    outputs: [{ name: "length", type: "number" }],
  },
  {
    ...base,
    type: "t.email",
    execInput: true,
    inputs: [{ name: "email", type: "email" }],
  },
  {
    ...base,
    type: "core.if",
    execInput: true,
    inputs: [{ name: "value", type: "any" }],
    execOutputs: [{ name: "true" }, { name: "false" }],
    checkConfig: (config) => {
      const c = config.condition;
      if (typeof c !== "string") return [{ field: "condition", message: "required" }];
      const err = checkExpression(isExpression(c) ? expressionSource(c) : c);
      return err ? [{ field: "condition", message: err }] : [];
    },
  },
  {
    ...base,
    type: "core.for_each",
    execInput: true,
    inputs: [{ name: "items", type: "list<any>", required: true }],
    outputs: [
      { name: "item", type: "any" },
      { name: "index", type: "number" },
    ],
    execOutputs: [{ name: "each" }, { name: "done" }],
  },
  {
    ...base,
    type: "t.switch",
    execInput: true,
    execOutputs: [],
    dynamicExecOutputs: { fromConfig: "cases", field: "port", extra: [{ name: "default" }] },
  },
  {
    ...base,
    type: "t.cfg",
    execInput: true,
    expressionFields: ["url"],
    configSchema: z.object({
      url: z.url().describe("Where to send it"),
      count: z.number().int().min(1).default(1).describe("How many"),
    }),
  },
];

export const registry = specLookup(SPECS);

export function node(id: string, type: string, config: Record<string, unknown> = {}): NodeInstance {
  return { id, type, version: 1, position: { x: 0, y: 0 }, config };
}

let edgeSeq = 0;
/** `exec("a.next", "b")` or `data("a.result", "b.value")`. */
export function exec(from: string, to: string): Edge {
  const [fn, fp] = from.split(".") as [string, string];
  return {
    id: `e${++edgeSeq}`,
    kind: "exec",
    from: { node: fn, port: fp },
    to: { node: to, port: "in" },
  };
}

export function data(from: string, to: string): Edge {
  const [fn, fp] = from.split(".") as [string, string];
  const [tn, tp] = to.split(".") as [string, string];
  return {
    id: `e${++edgeSeq}`,
    kind: "data",
    from: { node: fn, port: fp },
    to: { node: tn, port: tp },
  };
}

export function definition(nodes: NodeInstance[], edges: Edge[]): WorkflowDefinition {
  return { schema: WORKFLOW_SCHEMA, name: "Test", description: "", nodes, edges };
}
