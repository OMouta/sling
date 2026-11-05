import { schema } from "@sling/db";
import {
  bareExpression,
  checkExpression,
  isTruthy,
  MAX_LOOP_ITEMS,
  NodeError,
  type PortedSpec,
} from "@sling/workflow";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { MAX_RUN_DEPTH, RUN_FINISHED } from "../engine.ts";
import { defineNode } from "../types.ts";

const next = [{ name: "next" }];
const PORT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Publish-time syntax check for config fields that always hold JSONata. */
export function jsonataCheck(...fields: string[]): NonNullable<PortedSpec["checkConfig"]> {
  return (config) => {
    const out: { field: string; message: string }[] = [];
    for (const f of fields) {
      const v = config[f];
      if (typeof v !== "string") continue;
      const err = checkExpression(bareExpression(v));
      if (err) out.push({ field: f, message: err });
    }
    return out;
  };
}

const jsonata = (help: string) => z.string().min(1).describe(help).meta({ widget: "jsonata" });

export const ifNode = defineNode({
  type: "core.if",
  version: 1,
  title: "If",
  description: "Takes the true or false branch depending on a JSONata condition.",
  category: "logic",
  configSchema: z.object({
    condition: jsonata(
      "JSONata condition. Truthy takes the true branch. It sees inputs, trigger, vars, and execution, for example inputs.value.from.address in ['boss@example.com'].",
    ),
  }),
  checkConfig: jsonataCheck("condition"),
  inputs: [
    { name: "value", type: "any", description: "Available to the condition as inputs.value." },
  ],
  outputs: [],
  execInput: true,
  execOutputs: [{ name: "true" }, { name: "false" }],
  idempotent: true,
  run: async (ctx, { config }) => {
    const v = await ctx.services.evaluate(bareExpression(config.condition));
    return { exec: isTruthy(v) ? "true" : "false" };
  },
});

export const switchNode = defineNode({
  type: "core.switch",
  version: 1,
  title: "Switch",
  description:
    "Checks cases in order and leaves through the first one whose condition is truthy, else default.",
  category: "logic",
  configSchema: z.object({
    cases: z
      .array(
        z.object({
          port: z
            .string()
            .regex(PORT_NAME)
            .describe("Name of the exec output this case leaves through."),
          when: jsonata("JSONata condition for this case."),
        }),
      )
      .default([])
      .describe("Cases, checked in order."),
  }),
  checkConfig: (config) => {
    const cases = Array.isArray(config.cases)
      ? (config.cases as { port?: string; when?: string }[])
      : [];
    const out: { field: string; message: string }[] = [];
    const seen = new Set<string>();
    for (const [i, c] of cases.entries()) {
      if (c.port === "default" || c.port === "error") {
        out.push({ field: `cases.${i}.port`, message: `${c.port} is reserved` });
      } else if (c.port && seen.has(c.port)) {
        out.push({ field: `cases.${i}.port`, message: `Two cases are called ${c.port}` });
      }
      if (c.port) seen.add(c.port);
      const err = typeof c.when === "string" ? checkExpression(bareExpression(c.when)) : null;
      if (err) out.push({ field: `cases.${i}.when`, message: err });
    }
    return out;
  },
  inputs: [
    { name: "value", type: "any", description: "Available to the conditions as inputs.value." },
  ],
  outputs: [],
  execInput: true,
  execOutputs: [],
  dynamicExecOutputs: { fromConfig: "cases", field: "port", extra: [{ name: "default" }] },
  idempotent: true,
  run: async (ctx, { config }) => {
    for (const c of config.cases) {
      if (isTruthy(await ctx.services.evaluate(bareExpression(c.when)))) return { exec: c.port };
    }
    return { exec: "default" };
  },
});

export const transformNode = defineNode({
  type: "core.transform",
  version: 1,
  title: "Transform",
  description: "Builds a new value with JSONata.",
  category: "data",
  configSchema: z.object({
    expression: jsonata(
      "JSONata that builds the result. It sees inputs, trigger, vars, and execution, for example { 'to': inputs.value.from.address }.",
    ),
  }),
  checkConfig: jsonataCheck("expression"),
  inputs: [{ name: "value", type: "any", description: "Available as inputs.value." }],
  outputs: [{ name: "result", type: "json", description: "What the expression returned." }],
  execInput: true,
  execOutputs: next,
  idempotent: true,
  run: async (ctx, { config }) => ({
    exec: "next",
    outputs: { result: await ctx.services.evaluate(bareExpression(config.expression)) },
  }),
});

export const forEachNode = defineNode({
  type: "core.for_each",
  version: 1,
  title: "For each",
  description: `Runs the nodes after each once per item, then leaves through done. At most ${MAX_LOOP_ITEMS} items.`,
  category: "logic",
  configSchema: z.object({
    items: z
      .string()
      .optional()
      .describe("Items to loop over when the items input has no edge, as an expression."),
  }),
  expressionFields: ["items"],
  inputs: [
    { name: "items", type: "list<any>", required: true, description: "The list to loop over." },
  ],
  outputs: [
    { name: "item", type: "any", description: "The current item." },
    { name: "index", type: "number", description: "The current item's position, from 0." },
  ],
  execInput: true,
  execOutputs: [{ name: "each" }, { name: "done" }],
  idempotent: true,
  run: async (_ctx, { inputs }) => {
    const items = inputs.items;
    if (!Array.isArray(items)) {
      throw new NodeError("The items input isn't a list", { code: "invalid_input" });
    }
    if (items.length > MAX_LOOP_ITEMS) {
      throw new NodeError(
        `A loop can run at most ${MAX_LOOP_ITEMS} times, and got ${items.length} items`,
        {
          code: "loop_limit",
        },
      );
    }
    return {
      exec: items.length > 0 ? "each" : "done",
      outputs: { item: items[0] ?? null, index: 0 },
    };
  },
});

const MAX_WAIT_SECONDS = 90 * 24 * 60 * 60;

export const waitNode = defineNode({
  type: "core.wait",
  version: 1,
  title: "Wait",
  description: "Pauses the run for a while or until a time. The wait survives restarts.",
  category: "logic",
  configSchema: z.object({
    mode: z
      .enum(["duration", "until"])
      .default("duration")
      .describe("Wait for a number of seconds, or until a point in time."),
    seconds: z
      .number()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .default(60)
      .describe("How long to wait, in seconds."),
    until: z
      .string()
      .optional()
      .describe("ISO time to wait until, for example 2026-12-01T09:00:00Z. May be an expression."),
  }),
  expressionFields: ["until"],
  inputs: [],
  outputs: [],
  execInput: true,
  execOutputs: next,
  idempotent: true,
  run: async (_ctx, { config }) => {
    let until: Date;
    if (config.mode === "until") {
      until = new Date(config.until ?? "");
      if (Number.isNaN(until.getTime())) {
        throw new NodeError(`Not a time: ${config.until}`, { code: "invalid_config" });
      }
    } else {
      until = new Date(Date.now() + config.seconds * 1000);
    }
    if (until.getTime() <= Date.now()) return { exec: "next" };
    return { wait: { kind: "timer", until } };
  },
});

export const setVarNode = defineNode({
  type: "core.set_var",
  version: 1,
  title: "Set variable",
  description: "Stores a value for the rest of the run. Later nodes read it as vars.<name>.",
  category: "data",
  configSchema: z.object({
    name: z.string().regex(VAR_NAME).describe("Variable name: letters, digits, and _."),
    value: z
      .string()
      .optional()
      .describe("Value to store when the value input has no edge. May be an expression."),
  }),
  expressionFields: ["value"],
  inputs: [{ name: "value", type: "any", required: true, description: "The value to store." }],
  outputs: [],
  execInput: true,
  execOutputs: next,
  idempotent: true,
  run: async (ctx, { inputs, config }) => {
    ctx.services.run.vars[config.name] = inputs.value ?? null;
    return { exec: "next" };
  },
});

export const getVarNode = defineNode({
  type: "core.get_var",
  version: 1,
  title: "Get variable",
  description: "Reads a value stored earlier in the run with Set variable.",
  category: "data",
  configSchema: z.object({
    name: z.string().regex(VAR_NAME).describe("Variable name."),
  }),
  inputs: [],
  outputs: [
    { name: "value", type: "any", description: "The stored value, or null if it isn't set." },
  ],
  execInput: true,
  execOutputs: next,
  idempotent: true,
  run: async (ctx, { config }) => ({
    exec: "next",
    outputs: { value: ctx.services.run.vars[config.name] ?? null },
  }),
});

interface RunFinished {
  runId: string;
  status: string;
  output: unknown;
  error: { message: string; code: string } | null;
}

export const invokeWorkflowNode = defineNode({
  type: "core.invoke_workflow",
  version: 1,
  title: "Invoke workflow",
  description:
    "Runs another workflow's active version as a child run, starting at its Manual run trigger, and waits for it to finish.",
  category: "composition",
  configSchema: z.object({
    workflowId: z
      .string()
      .min(1)
      .describe("The workflow to run. It needs a published version with a Manual run trigger.")
      .meta({ widget: "workflow" }),
  }),
  inputs: [
    { name: "input", type: "json", description: "Becomes the child's manual trigger input." },
  ],
  outputs: [
    { name: "output", type: "json", description: "What the child returned with a Return node." },
  ],
  execInput: true,
  execOutputs: next,
  idempotent: false,
  run: async (ctx, { inputs, config }) => {
    const { app, engine } = ctx.services;
    if ((await engine.depth(ctx.runId)) >= MAX_RUN_DEPTH) {
      throw new NodeError(`Workflows can nest at most ${MAX_RUN_DEPTH} deep`, {
        code: "depth_limit",
      });
    }
    const [target] = await app.db
      .select()
      .from(schema.workflows)
      .where(
        and(
          eq(schema.workflows.id, config.workflowId),
          eq(schema.workflows.workspaceId, ctx.workspaceId),
        ),
      );
    if (!target?.activeVersionId) {
      throw new NodeError("That workflow doesn't exist or has no published version", {
        code: "no_workflow",
      });
    }
    const version = await engine.version(target.activeVersionId);
    const manual = version?.definition.nodes.find((n) => n.type === "core.manual");
    if (!version || !manual) {
      throw new NodeError(`${target.name} has no Manual run trigger`, {
        code: "no_manual_trigger",
      });
    }
    const child = await engine.startRun({
      workflowId: target.id,
      workspaceId: target.workspaceId,
      ownerId: target.ownerId,
      versionId: version.id,
      triggerNodeId: manual.id,
      outputs: { input: inputs.input ?? null },
      parentRunId: ctx.runId,
      parentNodeRunId: ctx.nodeRunId,
    });
    if (!child) throw new NodeError("The child run didn't start", { code: "child_not_started" });
    return {
      wait: { kind: "event", eventType: RUN_FINISHED, key: child.id },
      outputs: { runId: child.id },
    };
  },
  resume: async (_ctx, { resolution }) => {
    if (resolution.kind !== "event") throw new NodeError("Timed out", { code: "timeout" });
    const done = resolution.payload as RunFinished;
    if (done.status !== "succeeded") {
      throw new NodeError(`The child run ${done.status}: ${done.error?.message ?? "no detail"}`, {
        code: "child_failed",
      });
    }
    return { exec: "next", outputs: { output: done.output ?? null, runId: done.runId } };
  },
});

export const returnNode = defineNode({
  type: "core.return",
  version: 1,
  title: "Return",
  description: "Ends the run and sets its output. A parent's Invoke workflow node receives it.",
  category: "composition",
  configSchema: z.object({
    value: z
      .string()
      .optional()
      .describe("The output when the value input has no edge. May be an expression."),
  }),
  expressionFields: ["value"],
  inputs: [{ name: "value", type: "json", description: "The run's output." }],
  outputs: [],
  execInput: true,
  execOutputs: [],
  idempotent: true,
  run: async (_ctx, { inputs }) => ({ exec: "return", outputs: { value: inputs.value ?? null } }),
});

export const logicNodes = [
  ifNode,
  switchNode,
  transformNode,
  forEachNode,
  waitNode,
  setVarNode,
  getVarNode,
  invokeWorkflowNode,
  returnNode,
];
