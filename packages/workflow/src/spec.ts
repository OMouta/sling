import type { z } from "zod";
import type { PortType } from "./types.ts";

export type NodeCategory =
  | "trigger"
  | "logic"
  | "data"
  | "ai"
  | "action"
  | "state"
  | "human"
  | "agent"
  | "composition";

export interface PortSpec {
  name: string;
  type: PortType;
  label?: string;
  description?: string;
  /** Inputs only. A required input with no edge fails validation. */
  required?: boolean;
}

export interface ExecPortSpec {
  name: string;
  label?: string;
}

/**
 * Exec outputs that come from config, for nodes like `core.switch` whose
 * branches the user names. `config[fromConfig]` must be an array of strings,
 * or of objects whose `field` property is the port name.
 */
export interface DynamicExecOutputs {
  fromConfig: string;
  field?: string;
  /** Always present after the dynamic ones, for example `default`. */
  extra?: ExecPortSpec[];
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

/** Something that happened, offered to every trigger of that event type. */
export interface TriggerEvent {
  type: string;
  workspaceId: string;
  /** Set for connector events, so triggers only see their own installation. */
  installationId?: string;
  payload: unknown;
  at: Date;
}

export interface TriggerMatch {
  outputs: Record<string, unknown>;
  /** Runs with the same key run one at a time, in order. */
  concurrencyKey?: string;
}

export interface TriggerSpec<Config> {
  /** Event type this trigger subscribes to, for example "email.received". */
  event: string;
  /**
   * Returns the trigger's outputs if the event matches its config, else null.
   * May return a promise; extension triggers always do.
   */
  match(event: TriggerEvent, config: Config): TriggerMatch | null | Promise<TriggerMatch | null>;
}

export type WaitSpec =
  | { kind: "timer"; until: Date }
  | { kind: "approval"; approvalId: string }
  | { kind: "task"; taskId: string }
  | { kind: "event"; eventType: string; key: string; timeoutAt?: Date };

export type WaitResolution =
  | { kind: "timer" }
  | { kind: "approval"; state: "approved" | "rejected" | "expired" }
  | { kind: "task"; task: Record<string, unknown>; reason: string }
  | { kind: "event"; payload: unknown }
  | { kind: "timeout" };

export type NodeResult =
  | { exec: string; outputs?: Record<string, unknown> }
  | { wait: WaitSpec; outputs?: Record<string, unknown> };

/** Throw from `run` to fail a node. `retryable` only matters for idempotent nodes. */
export class NodeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(
    message: string,
    options: { code?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "NodeError";
    this.code = options.code ?? "node_failed";
    this.retryable = options.retryable ?? false;
  }
}

export interface NodeLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface Installation<
  Credentials = Record<string, unknown>,
  Config = Record<string, unknown>,
> {
  id: string;
  connectorId: string;
  name: string;
  credentials: Credentials;
  config: Config;
}

/** What a node gets while it runs. Built by the server for every node run. */
export interface NodeContext<Services = unknown> {
  runId: string;
  nodeId: string;
  nodeRunId: string;
  workflowId: string;
  workspaceId: string;
  ownerId: string;
  /** Loop iteration, 0 outside loops. */
  iteration: number;
  /** 1 on the first try. */
  attempt: number;
  /** `<runId>:<nodeId>:<iteration>`. Pass it to services that dedupe. */
  idempotencyKey: string;
  signal: AbortSignal;
  log: NodeLogger;
  /** Decrypted credentials and config of an installation in this workspace. */
  installation<C = Record<string, unknown>, Cfg = Record<string, unknown>>(
    id: string,
  ): Promise<Installation<C, Cfg>>;
  /** Server-only services. Connector nodes must not rely on these. */
  services: Services;
}

/**
 * Lets the assistant call a node from chat, as a tool. Only nodes with an exec
 * input that finish without waiting can opt in.
 */
export interface AssistantUse {
  /**
   * True when the node reaches outside Sling, such as sending a message or
   * creating an event. The conversation's mode then decides whether it asks
   * first, runs, or is refused.
   */
  sends: boolean;
  /**
   * What the call does, for the approval and the audit, with `{field}` filled
   * from its arguments. For example `"Email {to}: {subject}"`.
   */
  summary?: string;
  /**
   * Config fields an "Always allow" rule may pin, such as `["to"]` for an
   * email. A rule pins a string exactly, or as a suffix after a leading `*`,
   * and leaves the fields it doesn't pin free. Only for nodes that send.
   */
  ruleFields?: string[];
}

/**
 * What a node's `verify` found. `passed` and `failed` are final. `waiting`
 * asks Sling to call it again. `unchecked` means it couldn't tell, such as
 * when the account gives no way to read the result back.
 */
export interface VerifyResult {
  state: "passed" | "failed" | "waiting" | "unchecked";
  /** One line for the person, such as "In Work, Mon 9 Nov 10:00" or "Bounced: mailbox not found". */
  message: string;
  /** With `waiting`: when to look again. Sling picks a default without it. */
  retryAfterSeconds?: number;
}

export interface NodeVerifyArgs<Config> {
  inputs: Record<string, unknown>;
  config: Config;
  /** What `run` returned on its outputs. */
  outputs: Record<string, unknown>;
}

export interface NodeRunArgs<Config> {
  inputs: Record<string, unknown>;
  config: Config;
}

export interface NodeSpec<Config = Record<string, unknown>, Services = unknown> {
  type: string;
  version: number;
  title: string;
  description: string;
  category: NodeCategory;
  /** Connector that provides this node, if any. */
  connector?: string;
  /**
   * Zod schema for the node's settings. The editor renders a form from its
   * JSON Schema. Hint the widget with `.meta({ widget: "textarea" })` for
   * multi-line text such as prompts, or `.meta({ widget: "json" })` for JSON.
   * Give every field a `.describe()` so the form has help text.
   */
  configSchema: z.ZodType<Config>;
  /** Config keys whose string values may be JSONata (`={{ … }}`). */
  expressionFields?: string[];
  /** Config keys holding an installation ID, so the editor can offer a picker. */
  installationFields?: string[];
  inputs: PortSpec[];
  outputs: PortSpec[];
  /** False for triggers. */
  execInput: boolean;
  execOutputs: ExecPortSpec[];
  dynamicExecOutputs?: DynamicExecOutputs;
  /** Safe to run twice with the same inputs. Required for automatic retries. */
  idempotent: boolean;
  retry?: RetryPolicy;
  /** Present on trigger nodes. */
  trigger?: TriggerSpec<Config>;
  /** Present when the assistant may call this node from chat. */
  assistant?: AssistantUse;
  /** Absent on trigger nodes. */
  run?(ctx: NodeContext<Services>, args: NodeRunArgs<Config>): Promise<NodeResult>;
  /** Called when a wait this node returned resolves. Defaults to following `next`. */
  resume?(
    ctx: NodeContext<Services>,
    args: NodeRunArgs<Config> & { resolution: WaitResolution },
  ): Promise<NodeResult>;
  /**
   * Checks that what `run` did outside Sling happened: reads an event back,
   * fetches a sent message, or looks for a bounce. Sling calls it right after
   * the node runs from chat, and again while it answers `waiting`, for up to
   * `verifyForSeconds`. `ctx.attempt` counts the calls. A node without it
   * claims no check.
   */
  verify?(ctx: NodeContext<Services>, args: NodeVerifyArgs<Config>): Promise<VerifyResult>;
  /** How long `verify` may keep answering `waiting`. 10 minutes when absent. */
  verifyForSeconds?: number;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds specs of every config shape.
export type AnyNodeSpec = NodeSpec<any, any>;

/** Exec outputs for a node instance, including config-driven and error ports. */
export function execOutputsOf(spec: AnyNodeSpec, config: Record<string, unknown>): ExecPortSpec[] {
  const out = [...spec.execOutputs];
  const dyn = spec.dynamicExecOutputs;
  if (dyn) {
    const raw = config[dyn.fromConfig];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const name =
          typeof item === "string"
            ? item
            : dyn.field && item && typeof item === "object"
              ? String((item as Record<string, unknown>)[dyn.field] ?? "")
              : "";
        if (name && !out.some((p) => p.name === name)) out.push({ name });
      }
    }
    for (const extra of dyn.extra ?? []) {
      if (!out.some((p) => p.name === extra.name)) out.push(extra);
    }
  }
  return out;
}

/** Event types the server emits for Sling's own triggers. */
export const SLING_EVENTS = {
  manual: "core.manual",
  schedule: "core.schedule",
  webhook: "core.webhook",
  chatMessage: "app.chat_message",
  conversationUpdate: "sling.conversation_update",
  taskSettled: "sling.task_settled",
  approvalRequested: "sling.approval_requested",
} as const;
