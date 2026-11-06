/**
 * The assistant's tools for the user's apps: one per node that opted in with
 * `assistant` in its spec and has an enabled installation, and run_workflow.
 * A node runs directly, outside any workflow run, with the model's values
 * taken literally. Anything that sends asks the user in the chat first,
 * unless the mode says otherwise, and every call is audited.
 */
import { type PermissionMode, sendPolicy } from "@sling/core";
import { schema } from "@sling/db";
import {
  type NodeContext,
  NodeError,
  type NodeResult,
  type PortSpec,
  parseType,
} from "@sling/workflow";
import { type Tool, tool } from "ai";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { workspaceTimeZone } from "../timezone.ts";
import { loadInstallation } from "../workflows/connectors/installations.ts";
import { redactPayload } from "../workflows/redact.ts";
import { toJsonSchema } from "../workflows/registry.ts";
import type { AnyServerNodeSpec, EngineServices, RunInfo } from "../workflows/types.ts";
import type { Decision } from "./commands.ts";
import { TOOLS_BY_GROUP, type ToolScope } from "./tools.ts";

/** Most connector actions the assistant gets in one turn. */
export const MAX_APP_TOOLS = 30;
/** How long run_workflow waits for a run before it answers with the run's state. */
export const WORKFLOW_WAIT_MS = 60_000;
/** Longest a connector action may run from a chat. */
const ACTION_TIMEOUT_MS = 60_000;
/** Longest a retry waits, so a chat isn't held up by a node's own backoff. */
const MAX_RETRY_WAIT_MS = 2_000;
/** Largest workflow output handed back to the model, as JSON. */
const MAX_OUTPUT_CHARS = 16_000;

/** Names the built-in tools use, which a node's tool never takes. */
const RESERVED = new Set([...Object.values(TOOLS_BY_GROUP).flat(), "run_workflow"]);

/** What a call decided, for the audit. */
export type ActionDecision =
  | "not_needed"
  | "full_access"
  | "approved"
  | "denied"
  | "expired"
  | "refused";

/** A node type as a tool name: dots become underscores. */
export function toolName(type: string): string {
  return type.replace(/\./g, "_");
}

function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * A node's summary template, such as "Email {to}: {subject}", filled from a
 * call's values. Each value is cut to one short line, and the whole to 300
 * characters, so the approval stays readable.
 */
export function fillSummary(
  template: string | undefined,
  values: Record<string, unknown>,
  fallback: string,
): string {
  const filled = (template || fallback).replace(/\{(\w+)\}/g, (_, key: string) => {
    const text = valueText(values[key]).replace(/\s+/g, " ").trim();
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  });
  const line = filled.replace(/\s+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/**
 * What the model sees of a schema: editor hints dropped, and sentences that
 * show `={{ }}` expressions, since values from chat are never evaluated.
 */
function forModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(forModel);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "widget" || k === "$schema") continue;
    if (k === "description" && typeof v === "string") {
      const kept = v
        .split(/(?<=\.)\s+/)
        .filter((s) => !s.includes("={{"))
        .join(" ")
        .trim();
      if (kept) out[k] = kept;
      continue;
    }
    out[k] = forModel(v);
  }
  return out;
}

function portSchema(port: PortSpec): Record<string, unknown> | null {
  const t = parseType(port.type);
  if (!t) return null;
  const primitive = (name: string) => (name === "any" || name === "json" ? {} : { type: name });
  if (t.kind === "primitive") return primitive(t.name);
  if (t.kind === "list" && t.of.kind === "primitive") {
    return { type: "array", items: primitive(t.of.name) };
  }
  // Named types, such as an approval or an email, come from other nodes, not from a chat.
  return null;
}

/** How a node's tool takes its arguments, and where each one goes. */
export interface ArgumentPlan {
  /** JSON Schema for the model. */
  json: Record<string, unknown>;
  /** Arguments that go to the node's config. */
  configKeys: Set<string>;
  /** Arguments that go to its input ports. A key can go to both. */
  inputKeys: Set<string>;
}

/**
 * A node's config fields and input ports, minus its installation fields, as
 * one object. `installation` picks the account when there's more than one.
 */
export function argumentPlan(spec: AnyServerNodeSpec, installations: string[]): ArgumentPlan {
  const config = toJsonSchema(spec.configSchema);
  const properties: Record<string, unknown> = {
    ...((config.properties as Record<string, unknown> | undefined) ?? {}),
  };
  const required = new Set((config.required as string[] | undefined) ?? []);
  const installationFields = new Set(spec.installationFields ?? []);
  for (const f of installationFields) {
    delete properties[f];
    required.delete(f);
  }
  const configKeys = new Set(Object.keys(properties));
  const inputKeys = new Set<string>();
  for (const port of spec.inputs) {
    if (installationFields.has(port.name)) continue;
    // A config field of the same name stands for the port; the node prefers the port.
    if (configKeys.has(port.name)) {
      inputKeys.add(port.name);
      continue;
    }
    const s = portSchema(port);
    if (!s) continue;
    const description = port.description ?? port.label;
    properties[port.name] = description ? { ...s, description } : s;
    if (port.required) required.add(port.name);
    inputKeys.add(port.name);
  }
  if (installations.length > 1 && !("installation" in properties)) {
    properties.installation = {
      type: "string",
      enum: installations,
      description: "Which of the user's accounts to use.",
    };
    required.add("installation");
  }
  const json = forModel({
    type: "object",
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
    additionalProperties: false,
  }) as Record<string, unknown>;
  return { json, configKeys, inputKeys };
}

function zodFrom(json: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    // The node checks its config itself; this only shapes what the model sees.
    return z.record(z.string(), z.unknown());
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function waitMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

interface CallOptions {
  toolCallId: string;
  abortSignal?: AbortSignal;
}

interface InstallationRef {
  id: string;
  name: string;
}

/** The latest version of every node that opted in and can run from chat. */
function flaggedSpecs(ctx: AppContext): AnyServerNodeSpec[] {
  const latest = new Map<string, AnyServerNodeSpec>();
  for (const spec of ctx.registry.specs()) {
    if (!spec.assistant || !spec.execInput || spec.trigger || !spec.run || !spec.connector)
      continue;
    const seen = latest.get(spec.type);
    if (!seen || spec.version > seen.version) latest.set(spec.type, spec);
  }
  return [...latest.values()].sort((a, b) => a.type.localeCompare(b.type));
}

async function conversationMode(ctx: AppContext, id: string): Promise<PermissionMode | null> {
  const [conv] = await ctx.db
    .select({ mode: schema.conversations.mode })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, id));
  return conv?.mode ?? null;
}

const REFUSED =
  "This conversation is Read-only, so nothing can be sent or changed outside Sling from it. Tell the user it needs another mode, which they switch in the app. Don't try another way.";
const DENIED =
  "The user declined, so nothing was sent or changed. Don't try another way around it; ask what they'd like instead.";
const EXPIRED =
  "The user didn't answer in time, so nothing was sent or changed. Don't try another way; ask them again if it still matters.";

/**
 * Decides whether a call may go ahead: reads always do, and sends follow the
 * conversation's mode, asking in the chat when it says to.
 */
async function permit(
  ctx: AppContext,
  scope: ToolScope,
  sends: boolean,
  summary: string,
  options: CallOptions,
): Promise<
  { decision: ActionDecision; go: true } | { decision: ActionDecision; go: false; error: string }
> {
  if (!sends) return { decision: "not_needed", go: true };
  const mode = await conversationMode(ctx, scope.conversationId);
  if (!mode) return { decision: "refused", go: false, error: "conversation not found" };
  const policy = sendPolicy(mode);
  if (policy === "refuse") return { decision: "refused", go: false, error: REFUSED };
  if (policy === "run") return { decision: "full_access", go: true };
  const trace = scope.trace;
  if (!trace) {
    return {
      decision: "refused",
      go: false,
      error: "Can't ask the user to approve this from here.",
    };
  }
  const decision: Decision = await ctx.commands.approval({
    workspaceId: scope.workspaceId,
    conversationId: scope.conversationId,
    kind: "send",
    summary,
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    onChange: (approval) => trace.toolUpdate(options.toolCallId, { approval }),
  });
  if (decision === "approved") return { decision, go: true };
  return { decision, go: false, error: decision === "denied" ? DENIED : EXPIRED };
}

async function record(
  ctx: AppContext,
  scope: ToolScope,
  entry: {
    tool: string;
    subjectType: "installation" | "workflow";
    subjectId: string;
    summary: string;
    decision: ActionDecision;
    ok: boolean;
    error?: string;
    details: Record<string, unknown>;
  },
) {
  await audit(ctx, {
    workspaceId: scope.workspaceId,
    actorType: "agent",
    verb: "assistant.action",
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    details: {
      tool: entry.tool,
      ...entry.details,
      conversationId: scope.conversationId,
      summary: entry.summary,
      decision: entry.decision,
      ok: entry.ok,
      ...(entry.error ? { error: entry.error.slice(0, 500) } : {}),
    },
  });
}

/** Runs a node once, the way the engine would, but outside any workflow run. */
async function runNode(
  ctx: AppContext,
  scope: ToolScope,
  spec: AnyServerNodeSpec,
  installation: InstallationRef,
  args: { config: Record<string, unknown>; inputs: Record<string, unknown> },
  options: CallOptions,
): Promise<
  { ok: true; outputs: Record<string, unknown>; exec: string } | { ok: false; error: string }
> {
  const secrets = new Set<string>();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(ACTION_TIMEOUT_MS)])
    : AbortSignal.timeout(ACTION_TIMEOUT_MS);
  const runId = `chat:${scope.conversationId}`;
  const run: RunInfo = {
    id: runId,
    workflowId: "",
    versionId: "",
    workspaceId: scope.workspaceId,
    ownerId: scope.ownerId,
    triggerNodeId: "",
    installationId: installation.id,
    parentRunId: null,
    vars: {},
  };
  let zone: Promise<string> | null = null;
  const services: EngineServices = {
    app: ctx,
    engine: ctx.engine,
    run,
    evaluate: async () => {
      throw new NodeError("Values from a chat are taken as they are, never as expressions", {
        code: "no_expressions",
      });
    },
    timeZone: () => {
      zone ??= workspaceTimeZone(ctx, scope.workspaceId);
      return zone;
    },
  };
  const log = ctx.log.child({ conversationId: scope.conversationId, node: spec.type });
  const context: NodeContext<EngineServices> = {
    runId,
    nodeId: toolName(spec.type),
    nodeRunId: options.toolCallId,
    workflowId: "",
    workspaceId: scope.workspaceId,
    ownerId: scope.ownerId,
    iteration: 0,
    attempt: 1,
    // A repeat of the same call is the same action, so it sends once.
    idempotencyKey: `chat:${options.toolCallId}`,
    signal,
    log: {
      info: (m, d) => log.info(d ?? {}, m),
      warn: (m, d) => log.warn(d ?? {}, m),
      error: (m, d) => log.error(d ?? {}, m),
    },
    installation: async (id) => {
      const loaded = await loadInstallation(ctx, scope.workspaceId, id);
      // Only accounts of the node's own connector, in this workspace.
      if (loaded.installation.connectorId !== spec.connector) {
        throw new NodeError(`${spec.type} can't use installation ${loaded.installation.name}`, {
          code: "installation_not_allowed",
        });
      }
      for (const s of loaded.secrets) secrets.add(s);
      return loaded.installation as never;
    },
    services,
  };
  const execute = spec.run as NonNullable<AnyServerNodeSpec["run"]>;
  const maxAttempts = spec.idempotent ? Math.max(1, spec.retry?.maxAttempts ?? 1) : 1;
  for (let attempt = 1; ; attempt++) {
    let result: NodeResult;
    try {
      result = await execute({ ...context, attempt }, { inputs: args.inputs, config: args.config });
    } catch (err) {
      const retry = err instanceof NodeError && err.retryable && attempt < maxAttempts;
      if (retry && !signal.aborted) {
        await waitMs(Math.min(spec.retry?.backoffMs ?? 1_000, MAX_RETRY_WAIT_MS), signal);
        if (!signal.aborted) continue;
      }
      const message = redactPayload({ m: errorText(err) }, [...secrets])?.m;
      return { ok: false, error: typeof message === "string" ? message : "The action failed." };
    }
    if ("wait" in result) {
      return {
        ok: false,
        error: "This action waits for something before it finishes, so it can't run from a chat.",
      };
    }
    return {
      ok: true,
      exec: result.exec,
      outputs: redactPayload(result.outputs ?? {}, [...secrets]) ?? {},
    };
  }
}

function connectorAction(
  ctx: AppContext,
  scope: ToolScope,
  spec: AnyServerNodeSpec,
  installations: InstallationRef[],
): Tool {
  const names = installations.map((i) => i.name);
  const plan = argumentPlan(spec, names);
  const use = spec.assistant ?? { sends: false };
  const accounts =
    installations.length === 1
      ? ` It uses the user's ${installations[0]?.name} account.`
      : ` Pick the account with installation.`;
  const asks = use.sends
    ? " It reaches outside Sling, so the user may have to approve it in the chat first."
    : "";
  return tool({
    description: `${spec.title}: ${spec.description}${accounts}${asks}`.slice(0, 1_000),
    inputSchema: zodFrom(plan.json),
    execute: async (raw: unknown, options: CallOptions) => {
      const values = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const chosen =
        installations.length === 1
          ? installations[0]
          : installations.find((i) => i.name === values.installation);
      if (!chosen) return { error: `Pass installation, one of: ${names.join(", ")}.` };
      const config: Record<string, unknown> = {};
      const inputs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        if (plan.configKeys.has(k)) config[k] = v;
        if (plan.inputKeys.has(k)) inputs[k] = v;
      }
      for (const f of spec.installationFields ?? []) config[f] = chosen.id;
      const parsed = spec.configSchema.safeParse(config);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          error: `Invalid arguments: ${issue ? `${issue.path.join(".") || "value"}: ${issue.message}` : "check them"}`,
        };
      }
      const settings = parsed.data as Record<string, unknown>;
      const shown = { ...settings, ...inputs };
      for (const f of spec.installationFields ?? []) delete shown[f];
      const summary = fillSummary(use.summary, shown, spec.title);
      const name = toolName(spec.type);
      const details = {
        nodeType: spec.type,
        installationId: chosen.id,
        installation: chosen.name,
      };

      const allowed = await permit(ctx, scope, use.sends, summary, options);
      if (!allowed.go) {
        await record(ctx, scope, {
          tool: name,
          subjectType: "installation",
          subjectId: chosen.id,
          summary,
          decision: allowed.decision,
          ok: false,
          details,
        });
        return { error: allowed.error };
      }
      const result = await runNode(ctx, scope, spec, chosen, { config: settings, inputs }, options);
      await record(ctx, scope, {
        tool: name,
        subjectType: "installation",
        subjectId: chosen.id,
        summary,
        decision: allowed.decision,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
        details,
      });
      if (!result.ok) return { installation: chosen.name, error: result.error };
      return {
        installation: chosen.name,
        ...(result.exec !== "next" ? { outcome: result.exec } : {}),
        output: result.outputs,
      };
    },
  });
}

// ------------------------------------------------------------- workflows

interface Runnable {
  id: string;
  label: string;
  name: string;
  description: string;
  ownerId: string;
  workspaceId: string;
  versionId: string;
  manualNodeId: string;
  sends: boolean;
}

/**
 * Whether running a version can reach outside Sling: a node that isn't safe
 * to repeat, or one flagged as sending. A node this server doesn't know
 * counts as sending.
 */
export function versionSends(
  ctx: Pick<AppContext, "registry">,
  nodes: { type: string; version: number; config: Record<string, unknown> }[],
): boolean {
  return nodes.some((n) => {
    const spec = ctx.registry.get(n.type, n.version);
    if (!spec) return true;
    const idempotent = spec.idempotentWhen ? spec.idempotentWhen(n.config) : spec.idempotent;
    return !idempotent || spec.assistant?.sends === true;
  });
}

/** Enabled workflows with a published version that starts from a Manual run trigger. */
async function runnableWorkflows(ctx: AppContext, workspaceId: string): Promise<Runnable[]> {
  const rows = await ctx.db
    .select()
    .from(schema.workflows)
    .where(
      and(
        eq(schema.workflows.workspaceId, workspaceId),
        eq(schema.workflows.enabled, true),
        isNotNull(schema.workflows.activeVersionId),
      ),
    )
    .orderBy(asc(schema.workflows.name));
  const out: Runnable[] = [];
  const taken = new Set<string>();
  for (const wf of rows) {
    if (!wf.activeVersionId) continue;
    const version = await ctx.engine.version(wf.activeVersionId);
    const manual = version?.definition.nodes.find((n) => n.type === "core.manual");
    if (!version || !manual) continue;
    // Two workflows can share a name; the second goes by its ID too.
    const label = taken.has(wf.name) ? `${wf.name} (${wf.id})` : wf.name;
    taken.add(label);
    out.push({
      id: wf.id,
      label,
      name: wf.name,
      description: version.definition.description || wf.description || "",
      ownerId: wf.ownerId,
      workspaceId: wf.workspaceId,
      versionId: version.id,
      manualNodeId: manual.id,
      sends: versionSends(ctx, version.definition.nodes),
    });
  }
  return out;
}

function capped(value: unknown): unknown {
  const json = JSON.stringify(value ?? null);
  if (json.length <= MAX_OUTPUT_CHARS) return value ?? null;
  return { truncated: true, preview: json.slice(0, MAX_OUTPUT_CHARS) };
}

function runWorkflowTool(ctx: AppContext, scope: ToolScope, workflows: Runnable[]): Tool {
  const labels = workflows.map((w) => w.label) as [string, ...string[]];
  const list = workflows
    .map((w) => {
      const about = w.description.replace(/\s+/g, " ").trim().slice(0, 160);
      return `- ${w.label}${about ? `: ${about}` : ""}${w.sends ? " (reaches outside Sling, so it may ask the user first)" : ""}`;
    })
    .join("\n");
  return tool({
    description:
      `Run one of the user's workflows that starts from a Manual run trigger. input becomes the trigger's input. It waits up to ${WORKFLOW_WAIT_MS / 1000} seconds and returns what the run's Return node gave; a run still going by then comes back with its state and a link. The workflows:\n${list}`.slice(
        0,
        4_000,
      ),
    inputSchema: z.object({
      workflow: z.enum(labels).describe("The workflow, by name."),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("What the run starts with, as the Manual run trigger's input."),
    }),
    execute: async ({ workflow, input }, options: CallOptions) => {
      const w = workflows.find((x) => x.label === workflow);
      if (!w) return { error: `No workflow called ${workflow}.` };
      const summary = `Run the ${w.name} workflow`;
      const details = { workflowId: w.id, workflow: w.name };
      const allowed = await permit(ctx, scope, w.sends, summary, options);
      if (!allowed.go) {
        await record(ctx, scope, {
          tool: "run_workflow",
          subjectType: "workflow",
          subjectId: w.id,
          summary,
          decision: allowed.decision,
          ok: false,
          details,
        });
        return { error: allowed.error };
      }
      const started = await ctx.engine.startRun({
        workflowId: w.id,
        workspaceId: w.workspaceId,
        ownerId: w.ownerId,
        versionId: w.versionId,
        triggerNodeId: w.manualNodeId,
        outputs: { input: input ?? null },
      });
      if (!started) {
        await record(ctx, scope, {
          tool: "run_workflow",
          subjectType: "workflow",
          subjectId: w.id,
          summary,
          decision: allowed.decision,
          ok: false,
          error: "The run didn't start.",
          details,
        });
        return { error: "The run didn't start." };
      }
      const run = await ctx.engine.waitForRun(started.id, WORKFLOW_WAIT_MS, options.abortSignal);
      const status = run?.status ?? "queued";
      const ok = status === "succeeded";
      const runError = (run?.error as { message?: string } | null)?.message;
      await record(ctx, scope, {
        tool: "run_workflow",
        subjectType: "workflow",
        subjectId: w.id,
        summary,
        decision: allowed.decision,
        ok,
        ...(runError ? { error: runError } : {}),
        details: { ...details, runId: started.id, status },
      });
      if (ok) return { status, output: capped(run?.output) };
      if (status === "failed" || status === "cancelled") {
        return { status, error: runError ?? `The run ${status}.` };
      }
      return {
        status,
        runId: started.id,
        link: new URL(`/workflows/${w.id}/runs/${started.id}`, ctx.config.publicUrl).toString(),
        note: `The run is still ${status === "waiting" ? "waiting, for example on an approval" : "going"}. The user can follow it at the link.`,
      };
    },
  });
}

/**
 * The tools for the user's apps this turn: one per flagged node with an
 * enabled installation, at most 30, and run_workflow when a workflow can be
 * run. Built per turn, so a new installation or workflow shows up in the
 * next one.
 */
export async function appTools(ctx: AppContext, scope: ToolScope): Promise<Record<string, Tool>> {
  const rows = await ctx.db
    .select({
      id: schema.connectorInstallations.id,
      name: schema.connectorInstallations.name,
      connectorId: schema.connectorInstallations.connectorId,
    })
    .from(schema.connectorInstallations)
    .where(
      and(
        eq(schema.connectorInstallations.workspaceId, scope.workspaceId),
        eq(schema.connectorInstallations.enabled, true),
      ),
    )
    .orderBy(asc(schema.connectorInstallations.createdAt));
  const byConnector = new Map<string, InstallationRef[]>();
  for (const r of rows) {
    const list = byConnector.get(r.connectorId) ?? [];
    list.push({ id: r.id, name: r.name });
    byConnector.set(r.connectorId, list);
  }
  const tools: Record<string, Tool> = {};
  let count = 0;
  for (const spec of flaggedSpecs(ctx)) {
    if (count >= MAX_APP_TOOLS) break;
    const installations = byConnector.get(spec.connector as string);
    const name = toolName(spec.type);
    if (!installations?.length || RESERVED.has(name) || name in tools) continue;
    tools[name] = connectorAction(ctx, scope, spec, installations);
    count++;
  }
  const workflows = await runnableWorkflows(ctx, scope.workspaceId);
  if (workflows.length > 0) tools.run_workflow = runWorkflowTool(ctx, scope, workflows);
  return tools;
}
