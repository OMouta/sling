/**
 * Workflows the assistant writes itself: the node catalog it writes them
 * from, a new workflow from a graph, and a new graph for one that exists.
 * The server checks a graph with the same validator as the editor before the
 * card shows, and the card lists its steps in plain words.
 */
import type { SetupChangeRow, SetupChangeView, WorkflowStepView } from "@sling/core";
import { schema } from "@sling/db";
import {
  type AnyNodeSpec,
  EXEC_IN,
  NAMED_TYPES,
  type NodeInstance,
  type Position,
  type ValidationIssue,
  WORKFLOW_SCHEMA,
  type WorkflowDefinition,
} from "@sling/workflow";
import { type Tool, tool } from "ai";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { readCredentials } from "../workflows/connectors/installations.ts";
import { connectorLog } from "../workflows/connectors/manage.ts";
import { runSetup } from "../workflows/connectors/setup.ts";
import { toJsonSchema } from "../workflows/registry.ts";
import { type StepNames, workflowSteps } from "../workflows/summary.ts";
import type { InstallationRow, WorkflowRow } from "../workflows/views.ts";
import { type CallOptions, errorText, propose, row } from "./setup-change.ts";
import type { ToolScope } from "./tools.ts";

const ASKS =
  " Call it as soon as you know what to make: Sling shows the user the steps to apply or cancel, unless the conversation's mode applies it at once.";

/** How long the card waits to name things like a Discord channel before it shows IDs. */
const NAMING_MS = 4_000;
const COLUMN = 300;
const ROW = 220;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// ------------------------------------------------------------- the graph the model writes

const PORT_REF = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64})?$/;

export const GraphInput = z.object({
  nodes: z
    .array(
      z.object({
        id: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,64}$/)
          .describe("Unique, in letters, digits, _ and -, such as monday or post."),
        type: z.string().min(1).max(120).describe("A node type from workflow_nodes."),
        version: z.number().int().positive().optional().describe("Left out, the newest."),
        label: z.string().max(120).optional().describe("A few words for the editor."),
        config: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Its settings, by key. An account setting takes the account's name."),
      }),
    )
    .min(1)
    .max(100),
  edges: z
    .array(
      z.object({
        from: z
          .string()
          .regex(PORT_REF)
          .describe('An output as "node.port", such as "monday.next" or "week.agenda".'),
        to: z
          .string()
          .regex(PORT_REF)
          .describe(
            'An input as "node.port": "post.in" for what runs next, or a data input such as "post.content".',
          ),
      }),
    )
    .max(300),
});
export type GraphInput = z.infer<typeof GraphInput>;

const GRAPH_HELP =
  'The graph: nodes, and edges between their ports. An edge to a node\'s "in" port is what runs next; any other edge carries a value from an output to an input. A setting can also be an expression, ={{ … }} in JSONata, over trigger, inputs, and vars.';

function split(ref: string, fallback: string) {
  const dot = ref.indexOf(".");
  return dot < 0
    ? { node: ref, port: fallback }
    : { node: ref.slice(0, dot), port: ref.slice(dot + 1) };
}

/** Nodes left to right from the triggers along what runs next, a row each where they branch. */
function layout(
  nodes: NodeInstance[],
  next: Map<string, string[]>,
  isTrigger: (n: NodeInstance) => boolean,
) {
  const depth = new Map<string, number>();
  const queue = nodes.filter(isTrigger).map((n) => n.id);
  for (const id of queue) depth.set(id, 0);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const to of next.get(id) ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, (depth.get(id) ?? 0) + 1);
      queue.push(to);
    }
  }
  const last = Math.max(0, ...depth.values());
  const rows = new Map<number, number>();
  const out = new Map<string, Position>();
  for (const n of nodes) {
    const col = depth.get(n.id) ?? last + 1;
    const r = rows.get(col) ?? 0;
    rows.set(col, r + 1);
    out.set(n.id, { x: col * COLUMN, y: r * ROW });
  }
  return out;
}

async function accountsOf(ctx: AppContext, workspaceId: string): Promise<InstallationRow[]> {
  return ctx.db
    .select()
    .from(schema.connectorInstallations)
    .where(eq(schema.connectorInstallations.workspaceId, workspaceId))
    .orderBy(asc(schema.connectorInstallations.createdAt));
}

function specFor(ctx: AppContext, type: string, version: number | undefined) {
  return version ? ctx.registry.get(type, version) : ctx.registry.latest(type);
}

export interface Prepared {
  definition: WorkflowDefinition;
  /** The accounts it uses, for the card. */
  rows: SetupChangeRow[];
}

/** What the model hears when a graph won't do: every issue, so it can fix them at once. */
function refused(tool: string, issues: ValidationIssue[] | string[]) {
  const lines = issues.map((i) => {
    if (typeof i === "string") return i;
    // Most of the validator's messages already name the node or edge.
    const where = i.nodeId ?? (i.edgeId ? `edge ${i.edgeId}` : "");
    return where && !i.message.includes(i.nodeId ?? i.edgeId ?? "") ? `${where}: ${i.message}` : i.message;
  });
  return {
    error: `The workflow isn't valid, so nothing was shown to the user. Fix these and call ${tool} again.`,
    issues: [...new Set(lines)].slice(0, 30),
  };
}

/**
 * Turns the model's graph into a definition the editor opens: versions
 * filled in, account names swapped for their IDs, edges named and typed, and
 * nodes laid out, keeping where a node already sits in the editor. Then the
 * same checks a publish runs.
 */
export async function prepareGraph(
  ctx: AppContext,
  scope: ToolScope,
  tool: string,
  input: { name: string; description: string; graph: GraphInput; base?: WorkflowDefinition },
): Promise<Prepared | ReturnType<typeof refused>> {
  const accounts = await accountsOf(ctx, scope.workspaceId);
  const problems: string[] = [];
  const used = new Map<string, InstallationRow>();
  const before = new Map(input.base?.nodes.map((n) => [n.id, n]) ?? []);

  const nodes: NodeInstance[] = input.graph.nodes.map((n) => {
    const kept = before.get(n.id);
    const version = n.version ?? (kept?.type === n.type ? kept.version : undefined);
    const spec = specFor(ctx, n.type, version);
    const config = { ...n.config };
    for (const field of spec?.installationFields ?? []) {
      const mine = accounts.filter((a) => a.connectorId === spec?.connector);
      const want = typeof config[field] === "string" ? (config[field] as string).trim() : "";
      const picked = want
        ? mine.find((a) => a.id === want || sameName(a.name, want))
        : mine.length === 1
          ? mine[0]
          : undefined;
      if (picked) {
        config[field] = picked.id;
        used.set(picked.id, picked);
        continue;
      }
      const names = mine.map((a) => a.name).join(", ");
      problems.push(
        `${n.id}: ${field}: ${
          want
            ? `No ${spec?.connector} account called ${want}. ${spec?.connector} accounts: ${names || "none"}.`
            : mine.length === 0
              ? `There's no ${spec?.connector} account yet. Connect one with save_app_account first.`
              : `Pick one of the ${spec?.connector} accounts: ${names}.`
        }`,
      );
    }
    return {
      id: n.id,
      type: n.type,
      version: spec?.version ?? version ?? 1,
      ...(n.label?.trim() ? { label: n.label.trim() } : {}),
      position: kept?.position ?? { x: 0, y: 0 },
      config,
    };
  });
  if (problems.length > 0) return refused(tool, problems);

  const next = new Map<string, string[]>();
  const edges = input.graph.edges.map((e, i) => {
    const from = split(e.from, "next");
    const to = split(e.to, EXEC_IN);
    const exec = to.port === EXEC_IN;
    if (exec) next.set(from.node, [...(next.get(from.node) ?? []), to.node]);
    return { id: `e${i + 1}`, kind: exec ? ("exec" as const) : ("data" as const), from, to };
  });

  const isTrigger = (n: NodeInstance) => ctx.registry.get(n.type, n.version)?.execInput === false;
  const placed = layout(nodes, next, isTrigger);
  const taken = new Set([...before.values()].map((n) => `${n.position.x},${n.position.y}`));
  for (const n of nodes) {
    if (before.has(n.id)) continue;
    const p = placed.get(n.id) ?? { x: 0, y: 0 };
    while (taken.has(`${p.x},${p.y}`)) p.y += ROW;
    taken.add(`${p.x},${p.y}`);
    n.position = p;
  }

  const definition: WorkflowDefinition = {
    schema: WORKFLOW_SCHEMA,
    name: input.name,
    description: input.description,
    nodes,
    edges,
  };
  const issues = await ctx.workflows.issues(scope.workspaceId, definition);
  if (issues.length > 0) return refused(tool, issues);

  const rows = [...used.values()].map((a) =>
    row(ctx.registry.connector(a.connectorId)?.name ?? a.connectorId, a.name),
  );
  return { definition, rows };
}

// ------------------------------------------------------------- naming things on the card

function flatten(options: Record<string, { value: string; label: string }[]> | undefined) {
  const out = new Map<string, string>();
  for (const list of Object.values(options ?? {})) {
    for (const o of list) if (!out.has(o.value)) out.set(o.value, o.label);
  }
  return out;
}

/**
 * The card's steps, with accounts by name, and IDs such as a Discord
 * channel's named by the account's own setup lookup when it answers in time.
 */
export async function stepsFor(
  ctx: AppContext,
  workspaceId: string,
  definition: WorkflowDefinition,
): Promise<WorkflowStepView[]> {
  const accounts = new Map((await accountsOf(ctx, workspaceId)).map((a) => [a.id, a]));
  const workflows = definition.nodes.some((n) => n.type === "core.invoke_workflow")
    ? new Map(
        (
          await ctx.db
            .select({ id: schema.workflows.id, name: schema.workflows.name })
            .from(schema.workflows)
            .where(eq(schema.workflows.workspaceId, workspaceId))
        ).map((w) => [w.id, w.name]),
      )
    : new Map<string, string>();
  const base: StepNames = {
    installation: (id) => {
      const a = accounts.get(id);
      return a ? { name: a.name, config: a.config } : undefined;
    },
    workflow: (id) => workflows.get(id),
  };

  // A first pass says which accounts have something to name.
  const wanted = new Set<string>();
  workflowSteps(definition, ctx.registry, {
    ...base,
    option: (id) => {
      wanted.add(id);
      return undefined;
    },
  });
  const options = new Map<string, Map<string, string>>();
  await Promise.all(
    [...wanted].map(async (id) => {
      const a = accounts.get(id);
      const connector = a ? ctx.registry.connector(a.connectorId) : undefined;
      if (!a || !connector?.setup) return;
      try {
        const lookup = runSetup(connector, {
          credentials: await readCredentials(ctx, a),
          config: a.config,
          log: connectorLog(ctx, connector.id, a.id),
        });
        const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), NAMING_MS).unref());
        const found = await Promise.race([lookup, timeout]);
        if (found) options.set(id, flatten(found.options));
      } catch (err) {
        ctx.log.warn({ err, installationId: id }, "couldn't name a workflow step's settings");
      }
    }),
  );
  return workflowSteps(definition, ctx.registry, {
    ...base,
    option: (id, value) => options.get(id)?.get(value),
  });
}

/** What changed between two versions' steps, one row each. */
export function stepRows(before: WorkflowStepView[], after: WorkflowStepView[]): SetupChangeRow[] {
  const old = new Map(before.map((s) => [s.nodeId, s.text]));
  const rows: SetupChangeRow[] = [];
  for (const s of after) {
    const was = old.get(s.nodeId);
    if (was === undefined) rows.push({ label: "New step", after: s.text });
    else if (was !== s.text) rows.push({ label: "Step", before: was, after: s.text });
  }
  const now = new Set(after.map((s) => s.nodeId));
  for (const s of before) {
    if (!now.has(s.nodeId)) rows.push({ label: "Step", before: s.text, after: "Removed" });
  }
  return rows;
}

// ------------------------------------------------------------- the tools

function portText(p: { name: string; type: string }) {
  return `${p.name}: ${p.type}`;
}

function sendsOf(spec: AnyNodeSpec): boolean {
  if (spec.assistant) return spec.assistant.sends;
  return spec.execInput && spec.category === "action" && Boolean(spec.connector);
}

/** Named types a node's ports use, such as `email` in list<email>. */
function namedTypes(spec: AnyNodeSpec) {
  return [...spec.inputs, ...spec.outputs].flatMap((p) => {
    const t = NAMED_TYPES[/^list<(.+)>$/.exec(p.type)?.[1] ?? p.type];
    return t ? [t] : [];
  });
}

function workflowNodes(ctx: AppContext, scope: ToolScope): Tool {
  return tool({
    description:
      "The workflow node types Sling has: what each one does, its settings, and its ports. Pass types to get those nodes' full settings and the user's accounts that fit them, before you write a graph for create_workflow or change_workflow.",
    inputSchema: z.object({
      types: z
        .array(z.string().min(1).max(120))
        .max(20)
        .optional()
        .describe("Node types to get in full, such as core.schedule."),
    }),
    execute: async ({ types }) => {
      const latest = new Map<string, AnyNodeSpec>();
      for (const s of ctx.registry.specs()) {
        const had = latest.get(s.type);
        if (!had || s.version > had.version) latest.set(s.type, s);
      }
      if (!types?.length) {
        return {
          nodes: [...latest.values()]
            .sort((a, b) => a.type.localeCompare(b.type))
            .map((s) => ({
              type: s.type,
              does: s.description,
              ...(s.execInput ? {} : { trigger: true }),
              ...(sendsOf(s) ? { sends: true } : {}),
              settings: Object.keys(
                (toJsonSchema(s.configSchema).properties ?? {}) as Record<string, unknown>,
              ),
              ...(s.inputs.length ? { inputs: s.inputs.map(portText) } : {}),
              ...(s.outputs.length ? { outputs: s.outputs.map(portText) } : {}),
              ...(s.execOutputs.length ? { next: s.execOutputs.map((p) => p.name) } : {}),
              ...(s.dynamicExecOutputs
                ? { nextFrom: `the ${s.dynamicExecOutputs.fromConfig} setting` }
                : {}),
            })),
          help: GRAPH_HELP,
        };
      }
      const accounts = await accountsOf(ctx, scope.workspaceId);
      const missing = types.filter((t) => !latest.has(t));
      return {
        nodes: types.flatMap((t) => {
          const s = latest.get(t);
          if (!s) return [];
          const fields = s.installationFields ?? [];
          return [
            {
              type: s.type,
              version: s.version,
              title: s.title,
              does: s.description,
              ...(s.execInput ? {} : { trigger: true }),
              ...(sendsOf(s) ? { sends: true } : {}),
              settings: toJsonSchema(s.configSchema),
              ...(s.expressionFields?.length ? { expressionSettings: s.expressionFields } : {}),
              ...(fields.length
                ? {
                    accountSettings: fields,
                    accounts: accounts
                      .filter((a) => a.connectorId === s.connector)
                      .map((a) => a.name),
                  }
                : {}),
              inputs: s.inputs,
              outputs: s.outputs,
              next: s.execInput || s.execOutputs.length ? s.execOutputs.map((p) => p.name) : [],
              ...(s.dynamicExecOutputs ? { nextFrom: s.dynamicExecOutputs } : {}),
              ...(s.execInput ? { onError: "error" } : {}),
            },
          ];
        }),
        types: [
          ...new Set(
            types.flatMap((t) => {
              const s = latest.get(t);
              return s ? namedTypes(s) : [];
            }),
          ),
        ],
        ...(missing.length ? { unknown: missing } : {}),
        help: GRAPH_HELP,
      };
    },
  });
}

function link(ctx: AppContext, id: string) {
  return new URL(`/workflows/${id}`, ctx.config.publicUrl).toString();
}

function createWorkflow(ctx: AppContext, scope: ToolScope): Tool {
  return tool({
    description: `Make a new workflow from a graph you write. Call workflow_nodes first for the node types. Sling checks the graph and sends back what's wrong, or shows the user its steps to apply. For "every …" start with core.schedule and a cron expression, and for one time, such as a reminder, with its at setting. Next to a schedule, add a core.manual trigger wired to the same first step, so the user can try it with Run.${ASKS}`,
    inputSchema: z.object({
      name: z.string().trim().min(1).max(120).describe("Short, such as Weekly calendar."),
      description: z.string().trim().max(2000).default("").describe("One line on what it does."),
      definition: GraphInput.describe(GRAPH_HELP),
      enabled: z.boolean().default(true),
    }),
    execute: async (input, options: CallOptions) => {
      const taken = await ctx.db
        .select({ name: schema.workflows.name })
        .from(schema.workflows)
        .where(eq(schema.workflows.workspaceId, scope.workspaceId));
      if (taken.some((w) => sameName(w.name, input.name))) {
        return {
          error: `There's already a workflow called ${input.name}. Pick another name, or change that one with change_workflow.`,
        };
      }
      const prepared = await prepareGraph(ctx, scope, "create_workflow", {
        name: input.name,
        description: input.description,
        graph: input.definition,
      });
      if ("error" in prepared) return prepared;
      const { definition } = prepared;
      const change: SetupChangeView = {
        title: `Create workflow ${input.name}?`,
        doing: `Creating ${input.name}`,
        done: `Created ${input.name}`,
        rows: [
          row("Name", input.name),
          ...(input.description ? [row("Description", input.description)] : []),
          ...prepared.rows,
          row("On", input.enabled),
        ],
        secrets: [],
        workflow: { steps: await stepsFor(ctx, scope.workspaceId, definition), workflowId: null },
      };
      return propose(ctx, scope, options, {
        tool: "create_workflow",
        subjectType: "workflow",
        subjectId: "",
        change,
        apply: async () => {
          const actor = { workspaceId: scope.workspaceId, userId: scope.ownerId };
          try {
            const made = await ctx.workflows.create(actor, { definition });
            const published = await ctx.workflows.publish(actor, made, "Made in a chat");
            if (!published.ok) {
              // Such as a one-time schedule whose time passed while the card waited.
              await ctx.workflows.remove(actor, made);
              return {
                ok: false,
                error: `It didn't publish: ${published.issues.map((i) => i.message).join("; ")}`,
              };
            }
            let wf: WorkflowRow = (await ctx.workflows.get(scope.workspaceId, made.id)) ?? made;
            if (input.enabled) wf = (await ctx.workflows.setEnabled(actor, wf, true)) ?? wf;
            return {
              ok: true,
              subjectId: wf.id,
              result: {
                workflow: { id: wf.id, name: wf.name, enabled: wf.enabled },
                version: published.version,
                link: link(ctx, wf.id),
              },
            };
          } catch (err) {
            return { ok: false, error: errorText(err) };
          }
        },
      });
    },
  });
}

/** The tools for workflows the assistant writes, by name. */
export function workflowTools(ctx: AppContext, scope: ToolScope) {
  return {
    create_workflow: createWorkflow(ctx, scope),
    workflow_nodes: workflowNodes(ctx, scope),
  };
}
