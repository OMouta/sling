import { newId } from "@sling/core";
import { schema } from "@sling/db";
import {
  advance,
  buildGraph,
  type Cursor,
  EXEC_ERROR,
  ExpressionError,
  type ExpressionScope,
  enterLoop,
  evaluateConfig,
  evaluateExpression,
  execOutputNames,
  expressionSource,
  type Graph,
  hasErrorRoute,
  idempotencyKey,
  initialCursor,
  isExpression,
  iterationOf,
  LOOP_NODE,
  MAX_NODE_RUNS,
  missingInputs,
  NodeError,
  type NodeInstance,
  type NodeResult,
  type Parked,
  parseCursor,
  RETURN_NODE,
  recordRun,
  resolveInputs,
  TraversalError,
  type WaitResolution,
  type WaitSpec,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from "@sling/workflow";
import { and, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { approvalView } from "../views.ts";
import { loadInstallation } from "./connectors/installations.ts";
import { redactPayload } from "./redact.ts";
import { taskSettlement } from "./sling-events.ts";
import type { AnyServerNodeSpec, EngineServices, RunInfo, ServerNodeContext } from "./types.ts";
import { type RunRow, toNodeRunView, toRunView, workflowSummary } from "./views.ts";

export const RUN_QUEUE = "workflow-run";
export const TIMER_QUEUE = "workflow-timer";
/** Event a parent run waits on while its child runs. */
export const RUN_FINISHED = "workflow.run_finished";
/** Node runs older than this lose their stored inputs and outputs. */
export const PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How often an idempotent node is re-run after restarts before the engine gives up. */
const MAX_INTERRUPTED_ATTEMPTS = 5;
/** Largest outputs a node may hand to later nodes, as JSON. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** How deep `core.invoke_workflow` may nest. */
export const MAX_RUN_DEPTH = 10;

interface RunJob {
  runId: string;
}
interface TimerJob {
  waitId: string;
}

interface CachedVersion {
  id: string;
  workflowId: string;
  number: number;
  definition: WorkflowDefinition;
  graph: Graph;
}

export interface StartRunInput {
  workflowId: string;
  workspaceId: string;
  ownerId: string;
  versionId: string;
  triggerNodeId: string;
  outputs: Record<string, unknown>;
  concurrencyKey?: string | null;
  dedupeKey?: string | null;
  installationId?: string | null;
  parentRunId?: string | null;
  parentNodeRunId?: string | null;
}

/** Stored in `workflow_runs.trigger_payload`, so a retry can start the same way. */
interface TriggerPayload {
  outputs: Record<string, unknown>;
  installationId: string | null;
}

type Step =
  | { kind: "continue"; cursor: Cursor }
  /** The run parked, finished, failed, or was cancelled. Nothing more to do in this job. */
  | { kind: "stop" };

interface NodeRunState {
  id: string;
  iteration: number;
  attempt: number;
  startedAt: Date;
  inputs: Record<string, unknown>;
  config: Record<string, unknown>;
}

interface Prepared {
  inputs: Record<string, unknown>;
  config: Record<string, unknown>;
  scope: ExpressionScope;
}

class RunGone extends Error {}

function toNodeError(err: unknown): NodeError {
  if (err instanceof NodeError) return err;
  if (err instanceof ExpressionError || err instanceof TraversalError) {
    return new NodeError(err.message, { code: err.code, cause: err });
  }
  if (err && typeof err === "object" && (err as { name?: string }).name === "NodeError") {
    const e = err as { message?: string; code?: string; retryable?: boolean };
    return new NodeError(e.message ?? "Node failed", {
      code: e.code ?? "node_failed",
      retryable: e.retryable ?? false,
    });
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new NodeError(err.message, { code: "aborted", cause: err });
  }
  return new NodeError(err instanceof Error ? err.message : String(err), {
    code: "node_failed",
    cause: err,
  });
}

/**
 * Config after expressions are evaluated. An expression's result is kept if
 * the field accepts it; otherwise it's turned into a string, which is what a
 * string field written as an expression means.
 */
function parseConfig(
  spec: AnyServerNodeSpec,
  config: Record<string, unknown>,
  evaluated: string[],
): Record<string, unknown> {
  const s = spec.configSchema as z.ZodType;
  const shape = s instanceof z.ZodObject ? (s.shape as Record<string, z.ZodType>) : null;
  const candidate: Record<string, unknown> = { ...config };
  for (const key of evaluated) {
    const v = candidate[key];
    if (v === null) {
      delete candidate[key];
      continue;
    }
    const field = shape?.[key];
    if (!field || typeof v === "string" || field.safeParse(v).success) continue;
    candidate[key] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  const r = s.safeParse(candidate);
  if (!r.success) {
    const detail = r.error.issues
      .map((i) => `${i.path.map(String).join(".") || "config"}: ${i.message}`)
      .join("; ");
    throw new NodeError(`Invalid config: ${detail}`, { code: "invalid_config" });
  }
  return r.data as Record<string, unknown>;
}

function isIdempotent(spec: AnyServerNodeSpec, config: Record<string, unknown>): boolean {
  return spec.idempotentWhen ? spec.idempotentWhen(config) : spec.idempotent;
}

function errorOf(e: NodeError) {
  return { message: e.message.slice(0, 2000), code: e.code };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

/**
 * Runs workflows. One pg-boss job drives a run: it runs nodes in a loop and
 * saves the cursor after each one, so a crash resumes from the last finished
 * node. Runs sharing a concurrency key run one at a time, oldest first.
 * Waiting runs hold no job; resolving the wait queues a new one.
 */
export class Engine {
  readonly #ctx: AppContext;
  #boss: PgBoss | null = null;
  #stopping = false;
  readonly #active = new Map<string, AbortController>();
  readonly #versions = new Map<string, CachedVersion>();
  /** Engine time per node, excluding the node's own work, in ms. Most recent last. */
  readonly overheadMs: number[] = [];

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  get #db() {
    return this.#ctx.db;
  }

  // ------------------------------------------------------------- lifecycle

  /** Creates queues, recovers interrupted runs, and starts the workers. */
  async start(boss: PgBoss, opts: { concurrency?: number } = {}): Promise<void> {
    this.#boss = boss;
    this.#stopping = false;
    await boss.createQueue(RUN_QUEUE, {
      policy: "key_strict_fifo",
      notify: true,
      retryLimit: 20,
      retryDelay: 1,
      expireInSeconds: 6 * 60 * 60,
    });
    await boss.createQueue(TIMER_QUEUE, { notify: true, retryLimit: 5, retryDelay: 5 });
    await this.recover();
    await boss.work<RunJob>(
      RUN_QUEUE,
      { localConcurrency: opts.concurrency ?? 10, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) await this.#execute(job.data.runId);
      },
    );
    await boss.work<TimerJob>(TIMER_QUEUE, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
      for (const job of jobs) await this.#timerFired(job.data.waitId);
    });
  }

  /**
   * Stops picking up work. Runs in progress stop after their current node
   * and continue on the next start.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
  }

  /**
   * Startup recovery. Jobs left behind by a previous process are dropped,
   * and every run that was queued or running gets a fresh job. A node that
   * was mid-run is handled when that job starts.
   */
  async recover(): Promise<void> {
    const boss = this.#boss;
    if (boss) {
      const stale = (await boss.findJobs(RUN_QUEUE, { limit: 10_000 })).filter((j) =>
        ["active", "retry", "failed"].includes((j as { state?: string }).state ?? ""),
      );
      if (stale.length > 0) {
        await boss.deleteJob(
          RUN_QUEUE,
          stale.map((j) => j.id),
        );
      }
    }
    const runs = await this.#db
      .select()
      .from(schema.workflowRuns)
      .where(inArray(schema.workflowRuns.status, ["queued", "running"]))
      .orderBy(schema.workflowRuns.createdAt);
    for (const r of runs) await this.enqueue(r);
    if (runs.length > 0) this.#ctx.log.info({ runs: runs.length }, "requeued workflow runs");
  }

  // ------------------------------------------------------------- versions

  /** An immutable version, parsed and indexed once. */
  async version(versionId: string): Promise<CachedVersion | null> {
    const hit = this.#versions.get(versionId);
    if (hit) return hit;
    const [row] = await this.#db
      .select()
      .from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.id, versionId));
    if (!row) return null;
    const definition = WorkflowDefinitionSchema.parse(row.definition);
    const v: CachedVersion = {
      id: row.id,
      workflowId: row.workflowId,
      number: row.number,
      definition,
      graph: buildGraph(definition),
    };
    if (this.#versions.size > 500) {
      const oldest = this.#versions.keys().next().value;
      if (oldest) this.#versions.delete(oldest);
    }
    this.#versions.set(versionId, v);
    return v;
  }

  // ------------------------------------------------------------- starting runs

  /**
   * Creates a run at a trigger node and queues it. Returns null when the
   * dedupe key was already used for this workflow.
   */
  async startRun(input: StartRunInput): Promise<RunRow | null> {
    const version = await this.version(input.versionId);
    if (!version) throw new Error(`No workflow version ${input.versionId}`);
    const trigger = version.graph.nodes.get(input.triggerNodeId);
    if (!trigger) throw new Error(`No trigger node ${input.triggerNodeId}`);
    const cursor = initialCursor(version.graph, trigger.id, input.outputs);
    const runId = newId("run");
    const payload: TriggerPayload = {
      outputs: input.outputs,
      installationId: input.installationId ?? null,
    };
    const now = new Date();
    const run = await this.#db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.workflowRuns)
        .values({
          id: runId,
          workspaceId: input.workspaceId,
          ownerId: input.ownerId,
          workflowId: input.workflowId,
          versionId: input.versionId,
          status: "queued",
          triggerNodeId: trigger.id,
          triggerType: trigger.type,
          triggerPayload: payload,
          concurrencyKey: input.concurrencyKey ?? null,
          cursor: cursor as unknown as Record<string, unknown>,
          parentRunId: input.parentRunId ?? null,
          parentNodeRunId: input.parentNodeRunId ?? null,
          dedupeKey: input.dedupeKey ?? null,
          nodeRunCount: 1,
        })
        .onConflictDoNothing({
          target: [schema.workflowRuns.workflowId, schema.workflowRuns.dedupeKey],
          where: sql`${schema.workflowRuns.dedupeKey} is not null`,
        })
        .returning();
      if (!row) return null;
      await tx.insert(schema.nodeRuns).values({
        id: newId("nrn"),
        runId,
        workspaceId: input.workspaceId,
        nodeId: trigger.id,
        nodeType: trigger.type,
        iteration: 0,
        attempt: 1,
        status: "succeeded",
        execPort: "next",
        inputs: null,
        outputs: redactPayload(input.outputs),
        idempotencyKey: idempotencyKey(runId, trigger.id, 0),
        startedAt: now,
        finishedAt: now,
      });
      return row;
    });
    if (!run) return null;
    await this.#publishRun(run);
    await this.#publishWorkflow(run.workflowId);
    await this.enqueue(run);
    return run;
  }

  /** Queues a job for a run. Safe to call twice: a job for a finished run does nothing. */
  async enqueue(run: Pick<RunRow, "id" | "concurrencyKey">): Promise<void> {
    if (!this.#boss) throw new Error("The workflow engine isn't started");
    await this.#boss.send(
      RUN_QUEUE,
      { runId: run.id },
      { singletonKey: run.concurrencyKey ?? run.id },
    );
  }

  // ------------------------------------------------------------- executing

  async #execute(runId: string): Promise<void> {
    if (this.#stopping || this.#active.has(runId)) return;
    const abort = new AbortController();
    this.#active.set(runId, abort);
    try {
      await this.#drive(runId, abort.signal);
    } catch (err) {
      if (err instanceof RunGone) return;
      this.#ctx.log.error({ err, runId }, "workflow run failed in the engine");
      try {
        const run = await this.#loadRun(runId);
        if (run && (run.status === "running" || run.status === "queued")) {
          await this.#finishRun(run, "failed", null, {
            message: `The engine hit an error: ${err instanceof Error ? err.message : String(err)}`,
            code: "engine_error",
          });
        }
      } catch (inner) {
        this.#ctx.log.error({ err: inner, runId }, "couldn't mark the run failed");
      }
    } finally {
      this.#active.delete(runId);
    }
  }

  async #loadRun(runId: string): Promise<RunRow | null> {
    const [run] = await this.#db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, runId));
    return run ?? null;
  }

  async #drive(runId: string, signal: AbortSignal): Promise<void> {
    let run = await this.#loadRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return;
    const version = await this.version(run.versionId);
    if (!version) {
      await this.#finishRun(run, "failed", null, {
        message: "The workflow version is missing",
        code: "missing_version",
      });
      return;
    }
    const graph = version.graph;
    if (run.status === "queued") {
      const [updated] = await this.#db
        .update(schema.workflowRuns)
        .set({ status: "running", startedAt: run.startedAt ?? new Date() })
        .where(and(eq(schema.workflowRuns.id, run.id), eq(schema.workflowRuns.status, "queued")))
        .returning();
      if (!updated) return;
      run = updated;
      await this.#publishRun(run);
    }

    let cursor = parseCursor(run.cursor);
    let step: Step;
    if (cursor.parked?.resolution) {
      step = await this.#resumeParked(run, graph, cursor, signal);
    } else if (cursor.inFlight) {
      step = await this.#recoverInFlight(run, graph, cursor, signal);
    } else {
      step = { kind: "continue", cursor };
    }

    while (step.kind === "continue") {
      cursor = step.cursor;
      if (signal.aborted || this.#stopping) return;
      if (cursor.next === null) {
        await this.#finishRun(run, "succeeded", null, null, cursor);
        return;
      }
      if (cursor.nodeRuns >= MAX_NODE_RUNS) {
        await this.#finishRun(run, "failed", null, {
          message: `The run reached the limit of ${MAX_NODE_RUNS} node runs`,
          code: "node_run_limit",
          nodeId: cursor.next,
        });
        return;
      }
      step = await this.#runNext(run, graph, cursor, signal, 1);
    }
  }

  #execution(run: RunRow, nodeId: string, iteration: number, attempt: number) {
    const payload = run.triggerPayload as TriggerPayload;
    return {
      runId: run.id,
      workflowId: run.workflowId,
      nodeId,
      iteration,
      attempt,
      triggerNodeId: run.triggerNodeId,
      triggerType: run.triggerType,
      installationId: payload?.installationId ?? null,
      startedAt: (run.startedAt ?? run.createdAt).toISOString(),
    };
  }

  /** Resolves inputs, evaluates expressions, and parses config for the node at the cursor. */
  async #prepare(
    run: RunRow,
    graph: Graph,
    cursor: Cursor,
    node: NodeInstance,
    spec: AnyServerNodeSpec,
    iteration: number,
    attempt: number,
  ): Promise<Prepared> {
    const { inputs, fromConfig } = resolveInputs(graph, cursor, node, spec.inputs);
    const trigger = cursor.outputs[run.triggerNodeId] ?? {};
    const execution = this.#execution(run, node.id, iteration, attempt);
    if (fromConfig.length > 0) {
      const edgeInputs = { ...inputs };
      for (const k of fromConfig) delete edgeInputs[k];
      const defaultsScope = { inputs: edgeInputs, trigger, vars: cursor.vars, execution };
      for (const k of fromConfig) {
        const v = inputs[k];
        if (isExpression(v)) {
          try {
            inputs[k] = await evaluateExpression(expressionSource(v), defaultsScope);
          } catch (err) {
            const e = toNodeError(err);
            throw new NodeError(`${k}: ${e.message}`, { code: e.code });
          }
        }
      }
    }
    const scope: ExpressionScope = { inputs, trigger, vars: cursor.vars, execution };
    const { config: raw, evaluated } = await evaluateConfig(
      node.config,
      spec.expressionFields ?? [],
      scope,
    );
    const config = parseConfig(spec, raw, evaluated);
    const missing = missingInputs(spec.inputs, inputs);
    if (missing.length > 0) {
      throw new NodeError(`No value for required input ${missing.join(", ")}`, {
        code: "missing_input",
      });
    }
    return { inputs, config, scope };
  }

  #nodeContext(
    run: RunRow,
    node: NodeInstance,
    state: NodeRunState,
    scope: ExpressionScope,
    vars: Record<string, unknown>,
    secrets: Set<string>,
    signal: AbortSignal,
  ): ServerNodeContext {
    const payload = run.triggerPayload as TriggerPayload;
    const info: RunInfo = {
      id: run.id,
      workflowId: run.workflowId,
      versionId: run.versionId,
      workspaceId: run.workspaceId,
      ownerId: run.ownerId,
      triggerNodeId: run.triggerNodeId,
      installationId: payload?.installationId ?? null,
      parentRunId: run.parentRunId,
      vars,
    };
    const log = this.#ctx.log.child({ runId: run.id, nodeId: node.id });
    const services: EngineServices = {
      app: this.#ctx,
      engine: this,
      run: info,
      evaluate: (source) => evaluateExpression(source, { ...scope, vars }),
    };
    return {
      runId: run.id,
      nodeId: node.id,
      nodeRunId: state.id,
      workflowId: run.workflowId,
      workspaceId: run.workspaceId,
      ownerId: run.ownerId,
      iteration: state.iteration,
      attempt: state.attempt,
      idempotencyKey: idempotencyKey(run.id, node.id, state.iteration),
      signal,
      log: {
        info: (message, data) => log.info(data ?? {}, message),
        warn: (message, data) => log.warn(data ?? {}, message),
        error: (message, data) => log.error(data ?? {}, message),
      },
      installation: async (id) => {
        const inst = await loadInstallation(this.#ctx, run.workspaceId, id);
        for (const s of inst.secrets) secrets.add(s);
        return inst.installation as never;
      },
      services,
    };
  }

  #recordOverhead(ms: number) {
    this.overheadMs.push(ms);
    if (this.overheadMs.length > 10_000) this.overheadMs.splice(0, this.overheadMs.length - 10_000);
  }

  /** Runs the node at the cursor, with retries, and moves the cursor on. */
  async #runNext(
    run: RunRow,
    graph: Graph,
    cursor: Cursor,
    signal: AbortSignal,
    firstAttempt: number,
  ): Promise<Step> {
    const started = performance.now();
    const nodeId = cursor.next as string;
    const node = graph.nodes.get(nodeId);
    if (!node) {
      await this.#finishRun(run, "failed", null, {
        message: `The cursor points at a missing node ${nodeId}`,
        code: "missing_node",
        nodeId,
      });
      return { kind: "stop" };
    }
    const iteration = iterationOf(cursor, nodeId);
    const spec = this.#ctx.registry.get(node.type, node.version);
    const vars = { ...cursor.vars };
    const secrets = new Set<string>();

    let prepared: Prepared | null = null;
    let failure: NodeError | null = null;
    if (!spec?.run) {
      failure = new NodeError(`Node type ${node.type} version ${node.version} isn't available`, {
        code: "unknown_node_type",
      });
    } else {
      try {
        prepared = await this.#prepare(run, graph, cursor, node, spec, iteration, firstAttempt);
      } catch (err) {
        failure = toNodeError(err);
      }
    }

    if (!spec?.run || !prepared || failure) {
      // Nothing ran. Record the failure on its own node run.
      const state: NodeRunState = {
        id: newId("nrn"),
        iteration,
        attempt: firstAttempt,
        startedAt: new Date(),
        inputs: prepared?.inputs ?? {},
        config: {},
      };
      await this.#beginNodeRun(run, cursor, node, state, null);
      this.#recordOverhead(performance.now() - started);
      return this.#fail(run, graph, cursor, node, state, failure as NodeError, vars, secrets);
    }

    const { inputs, config, scope } = prepared;
    const idempotent = isIdempotent(spec, config);
    const maxAttempts = idempotent ? Math.max(1, spec.retry?.maxAttempts ?? 1) : 1;
    let overhead = performance.now() - started;

    for (let attempt = firstAttempt; ; attempt++) {
      const t0 = performance.now();
      const state: NodeRunState = {
        id: newId("nrn"),
        iteration,
        attempt,
        startedAt: new Date(),
        inputs,
        config,
      };
      await this.#beginNodeRun(run, cursor, node, state, inputs);
      const ctx = this.#nodeContext(run, node, state, scope, vars, secrets, signal);
      const t1 = performance.now();
      overhead += t1 - t0;
      let result: NodeResult | null = null;
      let error: NodeError | null = null;
      try {
        result = await (spec.run as NonNullable<AnyServerNodeSpec["run"]>)(ctx, { inputs, config });
      } catch (err) {
        error = toNodeError(err);
      }
      const t2 = performance.now();
      if (signal.aborted) return { kind: "stop" };
      if (error) {
        if (error.retryable && attempt < maxAttempts) {
          await this.#markNodeRun(run, state, "failed", { error: errorOf(error) }, secrets);
          const backoff = (spec.retry?.backoffMs ?? 1000) * 2 ** (attempt - firstAttempt);
          this.#recordOverhead(overhead + (performance.now() - t2));
          overhead = 0;
          await sleep(backoff, signal);
          if (signal.aborted) return { kind: "stop" };
          continue;
        }
        const step = await this.#fail(run, graph, cursor, node, state, error, vars, secrets);
        this.#recordOverhead(overhead + (performance.now() - t2));
        return step;
      }
      const step = await this.#settle(
        run,
        graph,
        cursor,
        node,
        spec,
        state,
        result as NodeResult,
        vars,
        secrets,
      );
      this.#recordOverhead(overhead + (performance.now() - t2));
      return step;
    }
  }

  /** Inserts a running node run and records it as in flight on the run. */
  async #beginNodeRun(
    run: RunRow,
    cursor: Cursor,
    node: NodeInstance,
    state: NodeRunState,
    inputs: Record<string, unknown> | null,
  ): Promise<void> {
    const next: Cursor = {
      ...cursor,
      inFlight: {
        nodeId: node.id,
        nodeRunId: state.id,
        iteration: state.iteration,
        attempt: state.attempt,
      },
    };
    const row = {
      id: state.id,
      runId: run.id,
      workspaceId: run.workspaceId,
      nodeId: node.id,
      nodeType: node.type,
      iteration: state.iteration,
      attempt: state.attempt,
      status: "running" as const,
      inputs: redactPayload(inputs),
      idempotencyKey: idempotencyKey(run.id, node.id, state.iteration),
      startedAt: state.startedAt,
    };
    const ok = await this.#db.transaction(async (tx) => {
      const [r] = await tx
        .update(schema.workflowRuns)
        .set({ cursor: next as unknown as Record<string, unknown> })
        .where(and(eq(schema.workflowRuns.id, run.id), eq(schema.workflowRuns.status, "running")))
        .returning({ id: schema.workflowRuns.id });
      if (!r) return false;
      await tx.insert(schema.nodeRuns).values(row);
      return true;
    });
    if (!ok) throw new RunGone();
    this.#ctx.hub.publish(run.workspaceId, {
      type: "node_run.updated",
      nodeRun: toNodeRunView({
        ...row,
        execPort: null,
        outputs: null,
        error: null,
        finishedAt: null,
      }),
    });
  }

  /** Updates a node run on its own, outside a cursor change. */
  async #markNodeRun(
    run: RunRow,
    state: NodeRunState,
    status: "failed" | "running",
    patch: { error?: { message: string; code: string } },
    secrets: Set<string>,
  ) {
    const [row] = await this.#db
      .update(schema.nodeRuns)
      .set({
        status,
        error: patch.error ?? null,
        finishedAt: status === "failed" ? new Date() : null,
      })
      .where(eq(schema.nodeRuns.id, state.id))
      .returning();
    void secrets;
    if (row) {
      this.#ctx.hub.publish(run.workspaceId, {
        type: "node_run.updated",
        nodeRun: toNodeRunView(row),
      });
    }
  }

  /**
   * Saves a node run's outcome and the run's new cursor in one transaction.
   * Throws RunGone if the run stopped running meanwhile (it was cancelled).
   */
  async #commitNode(
    run: RunRow,
    state: NodeRunState,
    patch: {
      status: "succeeded" | "failed" | "waiting";
      execPort?: string | null;
      outputs?: Record<string, unknown> | null;
      error?: { message: string; code: string } | null;
    },
    cursor: Cursor,
    secrets: Set<string>,
    runPatch: Partial<typeof schema.workflowRuns.$inferInsert> = {},
    wait?: typeof schema.runWaits.$inferInsert,
  ): Promise<RunRow> {
    const finishedAt = patch.status === "waiting" ? null : new Date();
    const outputs = redactPayload(patch.outputs ?? null, [...secrets]);
    const updated = await this.#db.transaction(async (tx) => {
      const [r] = await tx
        .update(schema.workflowRuns)
        .set({
          cursor: cursor as unknown as Record<string, unknown>,
          nodeRunCount: cursor.nodeRuns,
          ...runPatch,
        })
        .where(and(eq(schema.workflowRuns.id, run.id), eq(schema.workflowRuns.status, "running")))
        .returning();
      if (!r) return null;
      const [nr] = await tx
        .update(schema.nodeRuns)
        .set({
          status: patch.status,
          execPort: patch.execPort ?? null,
          outputs,
          error: patch.error ?? null,
          finishedAt,
        })
        .where(eq(schema.nodeRuns.id, state.id))
        .returning();
      if (wait) await tx.insert(schema.runWaits).values(wait);
      return { run: r, nodeRun: nr };
    });
    if (!updated) throw new RunGone();
    if (updated.nodeRun) {
      this.#ctx.hub.publish(run.workspaceId, {
        type: "node_run.updated",
        nodeRun: toNodeRunView(updated.nodeRun),
      });
    }
    return updated.run;
  }

  /** Handles what a node returned: follow an exec output, enter a loop, return, or park. */
  async #settle(
    run: RunRow,
    graph: Graph,
    cursor: Cursor,
    node: NodeInstance,
    spec: AnyServerNodeSpec,
    state: NodeRunState,
    result: NodeResult,
    vars: Record<string, unknown>,
    secrets: Set<string>,
  ): Promise<Step> {
    const outputs = result.outputs ?? {};
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(outputs));
    } catch {
      return this.#fail(
        run,
        graph,
        cursor,
        node,
        state,
        new NodeError("The node returned outputs that aren't JSON", { code: "bad_outputs" }),
        vars,
        secrets,
      );
    }
    if (size > MAX_OUTPUT_BYTES) {
      return this.#fail(
        run,
        graph,
        cursor,
        node,
        state,
        new NodeError(`The node's outputs are ${size} bytes, over the ${MAX_OUTPUT_BYTES} limit`, {
          code: "output_too_large",
        }),
        vars,
        secrets,
      );
    }

    if ("wait" in result)
      return this.#park(run, cursor, node, state, result.wait, outputs, vars, secrets);

    const port = result.exec;
    const base: Cursor = {
      ...recordRun(cursor, node.id, outputs),
      vars,
      inFlight: null,
      parked: null,
    };

    if (node.type === RETURN_NODE) {
      const output = outputs.value ?? null;
      const done = { ...base, next: null, frames: [] };
      const updated = await this.#commitNode(
        run,
        state,
        { status: "succeeded", execPort: null, outputs },
        done,
        secrets,
      );
      await this.#finishRun(updated, "succeeded", output, null, done);
      return { kind: "stop" };
    }

    if (!execOutputNames(spec, node.config).includes(port)) {
      return this.#fail(
        run,
        graph,
        cursor,
        node,
        state,
        new NodeError(`The node chose an exec output it doesn't have: ${port}`, {
          code: "bad_exec_port",
        }),
        vars,
        secrets,
      );
    }

    let next: Cursor;
    try {
      next =
        node.type === LOOP_NODE
          ? enterLoop(graph, base, node.id, (state.inputs.items as unknown[]) ?? [])
          : advance(graph, base, node.id, port);
    } catch (err) {
      return this.#fail(run, graph, cursor, node, state, toNodeError(err), vars, secrets);
    }
    const updated = await this.#commitNode(
      run,
      state,
      { status: "succeeded", execPort: port, outputs },
      next,
      secrets,
    );
    Object.assign(run, updated);
    return { kind: "continue", cursor: next };
  }

  /** A node failed: follow its error output if connected, else fail the run. */
  async #fail(
    run: RunRow,
    graph: Graph,
    cursor: Cursor,
    node: NodeInstance,
    state: NodeRunState,
    error: NodeError,
    vars: Record<string, unknown>,
    secrets: Set<string>,
  ): Promise<Step> {
    const err = errorOf(error);
    if (hasErrorRoute(graph, node.id)) {
      const base: Cursor = {
        ...recordRun(cursor, node.id, { error: err }),
        vars,
        inFlight: null,
        parked: null,
      };
      const next = advance(graph, base, node.id, EXEC_ERROR);
      const updated = await this.#commitNode(
        run,
        state,
        { status: "failed", execPort: EXEC_ERROR, error: err },
        next,
        secrets,
      );
      Object.assign(run, updated);
      return { kind: "continue", cursor: next };
    }
    const done: Cursor = { ...cursor, vars, inFlight: null, parked: null };
    const updated = await this.#commitNode(
      run,
      state,
      { status: "failed", error: err },
      done,
      secrets,
    );
    await this.#finishRun(updated, "failed", null, { ...err, nodeId: node.id }, done);
    return { kind: "stop" };
  }

  // ------------------------------------------------------------- waits

  async #park(
    run: RunRow,
    cursor: Cursor,
    node: NodeInstance,
    state: NodeRunState,
    wait: WaitSpec,
    outputs: Record<string, unknown>,
    vars: Record<string, unknown>,
    secrets: Set<string>,
  ): Promise<Step> {
    const waitId = newId("wai");
    const parked: Parked = {
      nodeId: node.id,
      nodeRunId: state.id,
      iteration: state.iteration,
      attempt: state.attempt,
      waitId,
      inputs: state.inputs,
      config: state.config,
      outputs,
    };
    const next: Cursor = { ...cursor, vars, inFlight: null, parked };
    const row: typeof schema.runWaits.$inferInsert = {
      id: waitId,
      runId: run.id,
      nodeRunId: state.id,
      workspaceId: run.workspaceId,
      kind: wait.kind,
      key:
        wait.kind === "approval"
          ? wait.approvalId
          : wait.kind === "task"
            ? wait.taskId
            : wait.kind === "event"
              ? wait.key
              : null,
      eventType: wait.kind === "event" ? wait.eventType : null,
      resumeAt:
        wait.kind === "timer"
          ? wait.until
          : wait.kind === "event"
            ? (wait.timeoutAt ?? null)
            : null,
    };
    const updated = await this.#commitNode(
      run,
      state,
      { status: "waiting", outputs },
      next,
      secrets,
      { status: "waiting" },
      row,
    );
    await this.#publishRun(updated);
    if (row.resumeAt) {
      await this.#boss?.send(TIMER_QUEUE, { waitId }, { startAfter: row.resumeAt });
    }
    await this.#recheckWait(row);
    return { kind: "stop" };
  }

  /**
   * Covers a wait whose event happened before the wait was saved, for
   * example a task that settled while the node was still returning.
   */
  async #recheckWait(w: typeof schema.runWaits.$inferInsert) {
    if (w.kind === "approval" && w.key) {
      const [a] = await this.#db
        .select({ state: schema.approvals.state })
        .from(schema.approvals)
        .where(eq(schema.approvals.id, w.key));
      if (a && a.state !== "pending") {
        await this.resolveWait(w.id, {
          kind: "approval",
          state:
            a.state === "approved" ? "approved" : a.state === "rejected" ? "rejected" : "expired",
        });
      }
    } else if (w.kind === "task" && w.key) {
      const settled = await taskSettlement(this.#ctx, w.key);
      if (settled) await this.resolveWait(w.id, { kind: "task", ...settled });
    } else if (w.kind === "event" && w.eventType === RUN_FINISHED && w.key) {
      const child = await this.#loadRun(w.key);
      if (child && ["succeeded", "failed", "cancelled"].includes(child.status)) {
        await this.resolveWait(w.id, { kind: "event", payload: this.#finishedPayload(child) });
      }
    }
  }

  /**
   * Wakes a parked run. Only the first resolution of a wait counts. Returns
   * whether this call resolved it.
   */
  async resolveWait(waitId: string, resolution: WaitResolution): Promise<boolean> {
    const run = await this.#db.transaction(async (tx) => {
      const [w] = await tx
        .delete(schema.runWaits)
        .where(eq(schema.runWaits.id, waitId))
        .returning();
      if (!w) return null;
      const [r] = await tx
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, w.runId))
        .for("update");
      if (r?.status !== "waiting") return null;
      const cursor = parseCursor(r.cursor);
      if (cursor.parked?.waitId !== w.id) return null;
      const next: Cursor = { ...cursor, parked: { ...cursor.parked, resolution } };
      const [u] = await tx
        .update(schema.workflowRuns)
        .set({ status: "queued", cursor: next as unknown as Record<string, unknown> })
        .where(eq(schema.workflowRuns.id, r.id))
        .returning();
      return u ?? null;
    });
    if (!run) return false;
    await this.#publishRun(run);
    await this.enqueue(run);
    return true;
  }

  /** Calls the parked node's `resume`, then carries on like a normal node result. */
  async #resumeParked(
    run: RunRow,
    graph: Graph,
    cursor: Cursor,
    signal: AbortSignal,
  ): Promise<Step> {
    const p = cursor.parked as Parked & { resolution: WaitResolution };
    const node = graph.nodes.get(p.nodeId);
    const spec = node ? this.#ctx.registry.get(node.type, node.version) : undefined;
    const state: NodeRunState = {
      id: p.nodeRunId,
      iteration: p.iteration,
      attempt: p.attempt,
      startedAt: new Date(),
      inputs: p.inputs,
      config: p.config,
    };
    if (!node || !spec) {
      await this.#finishRun(run, "failed", null, {
        message: `Node ${p.nodeId} isn't available to resume`,
        code: "unknown_node_type",
        nodeId: p.nodeId,
      });
      return { kind: "stop" };
    }
    // Keep `parked` while resuming: if the process dies here, the next start resumes again.
    const resuming: Cursor = {
      ...cursor,
      inFlight: {
        nodeId: node.id,
        nodeRunId: p.nodeRunId,
        iteration: p.iteration,
        attempt: p.attempt,
      },
    };
    await this.#db
      .update(schema.workflowRuns)
      .set({ cursor: resuming as unknown as Record<string, unknown> })
      .where(eq(schema.workflowRuns.id, run.id));
    const [nr] = await this.#db
      .update(schema.nodeRuns)
      .set({ status: "running" })
      .where(eq(schema.nodeRuns.id, p.nodeRunId))
      .returning();
    if (nr) {
      this.#ctx.hub.publish(run.workspaceId, {
        type: "node_run.updated",
        nodeRun: toNodeRunView(nr),
      });
    }

    const vars = { ...cursor.vars };
    const secrets = new Set<string>();
    const scope: ExpressionScope = {
      inputs: p.inputs,
      trigger: cursor.outputs[run.triggerNodeId] ?? {},
      vars,
      execution: this.#execution(run, node.id, p.iteration, p.attempt),
    };
    const base: Cursor = { ...cursor, parked: null, inFlight: null };
    let result: NodeResult;
    try {
      if (spec.resume) {
        const ctx = this.#nodeContext(run, node, state, scope, vars, secrets, signal);
        result = await spec.resume(ctx, {
          inputs: p.inputs,
          config: p.config,
          resolution: p.resolution,
        });
      } else if (p.resolution.kind === "timeout") {
        throw new NodeError("Timed out waiting", { code: "timeout" });
      } else {
        result = { exec: "next" };
      }
    } catch (err) {
      if (signal.aborted) return { kind: "stop" };
      return this.#fail(run, graph, base, node, state, toNodeError(err), vars, secrets);
    }
    if (signal.aborted) return { kind: "stop" };
    // What the node returned with the wait stays available unless resume replaces it.
    const merged = {
      ...result,
      outputs: { ...(p.outputs ?? {}), ...(result.outputs ?? {}) },
    } as NodeResult;
    return this.#settle(run, graph, base, node, spec, state, merged, vars, secrets);
  }

  /** A node was running when the process stopped. Re-run it only if that's safe. */
  async #recoverInFlight(
    run: RunRow,
    graph: Graph,
    cursor: Cursor,
    signal: AbortSignal,
  ): Promise<Step> {
    const f = cursor.inFlight as NonNullable<Cursor["inFlight"]>;
    const node = graph.nodes.get(f.nodeId);
    const spec = node ? this.#ctx.registry.get(node.type, node.version) : undefined;
    const state: NodeRunState = {
      id: f.nodeRunId,
      iteration: f.iteration,
      attempt: f.attempt,
      startedAt: new Date(),
      inputs: {},
      config: {},
    };
    const clean: Cursor = { ...cursor, inFlight: null, next: f.nodeId };
    const idempotent = spec && node ? isIdempotent(spec, node.config) : false;
    if (node && spec && idempotent && f.attempt < MAX_INTERRUPTED_ATTEMPTS) {
      await this.#markNodeRun(
        run,
        state,
        "failed",
        { error: { message: "Interrupted by a restart. Running it again.", code: "interrupted" } },
        new Set(),
      );
      this.#ctx.log.info({ runId: run.id, nodeId: f.nodeId }, "re-running an interrupted node");
      return this.#runNext(run, graph, clean, signal, f.attempt + 1);
    }
    if (!node) {
      await this.#finishRun(run, "failed", null, {
        message: "Interrupted, outcome unknown",
        code: "interrupted",
        nodeId: f.nodeId,
      });
      return { kind: "stop" };
    }
    this.#ctx.log.warn({ runId: run.id, nodeId: f.nodeId }, "node interrupted, outcome unknown");
    return this.#fail(
      run,
      graph,
      clean,
      node,
      state,
      new NodeError("Interrupted, outcome unknown", { code: "interrupted" }),
      { ...cursor.vars },
      new Set(),
    );
  }

  async #timerFired(waitId: string): Promise<void> {
    const [w] = await this.#db.select().from(schema.runWaits).where(eq(schema.runWaits.id, waitId));
    if (!w) return;
    await this.resolveWait(w.id, w.kind === "timer" ? { kind: "timer" } : { kind: "timeout" });
  }

  /** Task service hook: an approval of kind `workflow` was decided or expired. */
  async onApprovalSettled(approval: typeof schema.approvals.$inferSelect): Promise<void> {
    const waits = await this.#db
      .select()
      .from(schema.runWaits)
      .where(and(eq(schema.runWaits.kind, "approval"), eq(schema.runWaits.key, approval.id)));
    const state =
      approval.state === "approved"
        ? "approved"
        : approval.state === "rejected"
          ? "rejected"
          : "expired";
    for (const w of waits) await this.resolveWait(w.id, { kind: "approval", state });
  }

  /** A Sling task settled: wake runs waiting on it. */
  async onTaskSettled(taskId: string, task: Record<string, unknown>, reason: string) {
    const waits = await this.#db
      .select()
      .from(schema.runWaits)
      .where(and(eq(schema.runWaits.kind, "task"), eq(schema.runWaits.key, taskId)));
    for (const w of waits) await this.resolveWait(w.id, { kind: "task", task, reason });
  }

  /** Wakes runs waiting on an event of this type and key. */
  async onEvent(eventType: string, key: string, payload: unknown): Promise<number> {
    const waits = await this.#db
      .select()
      .from(schema.runWaits)
      .where(
        and(
          eq(schema.runWaits.kind, "event"),
          eq(schema.runWaits.eventType, eventType),
          eq(schema.runWaits.key, key),
        ),
      );
    let n = 0;
    for (const w of waits) if (await this.resolveWait(w.id, { kind: "event", payload })) n++;
    return n;
  }

  // ------------------------------------------------------------- finishing

  #finishedPayload(run: RunRow) {
    return {
      runId: run.id,
      status: run.status,
      output: run.output ?? null,
      error: run.error ?? null,
    };
  }

  async #finishRun(
    run: RunRow,
    status: "succeeded" | "failed",
    output: unknown,
    error: { message: string; code: string; nodeId?: string } | null,
    cursor?: Cursor,
  ): Promise<void> {
    const [updated] = await this.#db
      .update(schema.workflowRuns)
      .set({
        status,
        output: output ?? null,
        error,
        finishedAt: new Date(),
        ...(cursor
          ? { cursor: { ...cursor, inFlight: null } as unknown as Record<string, unknown> }
          : {}),
      })
      .where(
        and(
          eq(schema.workflowRuns.id, run.id),
          inArray(schema.workflowRuns.status, ["queued", "running"]),
        ),
      )
      .returning();
    if (!updated) return;
    await this.#publishRun(updated);
    await this.#publishWorkflow(updated.workflowId);
    await this.#notifyParent(updated);
  }

  async #notifyParent(run: RunRow) {
    if (!run.parentRunId) return;
    await this.onEvent(RUN_FINISHED, run.id, this.#finishedPayload(run));
  }

  // ------------------------------------------------------------- cancel and retry

  /** Cancels a run that hasn't finished, and any child runs it's waiting on. */
  async cancel(workspaceId: string, runId: string): Promise<RunRow | null> {
    const [updated] = await this.#db
      .update(schema.workflowRuns)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        error: { message: "Cancelled", code: "cancelled" },
      })
      .where(
        and(
          eq(schema.workflowRuns.id, runId),
          eq(schema.workflowRuns.workspaceId, workspaceId),
          inArray(schema.workflowRuns.status, ["queued", "running", "waiting"]),
        ),
      )
      .returning();
    if (!updated) {
      const [row] = await this.#db
        .select()
        .from(schema.workflowRuns)
        .where(
          and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.workspaceId, workspaceId)),
        );
      return row ?? null;
    }
    this.#active.get(runId)?.abort();
    const waits = await this.#db
      .delete(schema.runWaits)
      .where(eq(schema.runWaits.runId, runId))
      .returning();
    const open = await this.#db
      .update(schema.nodeRuns)
      .set({
        status: "failed",
        error: { message: "Cancelled", code: "cancelled" },
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(schema.nodeRuns.runId, runId),
          inArray(schema.nodeRuns.status, ["running", "waiting"]),
        ),
      )
      .returning();
    for (const nr of open) {
      this.#ctx.hub.publish(workspaceId, { type: "node_run.updated", nodeRun: toNodeRunView(nr) });
    }
    for (const w of waits) {
      if (w.kind === "approval" && w.key) {
        const [a] = await this.#db
          .update(schema.approvals)
          .set({ state: "expired" })
          .where(and(eq(schema.approvals.id, w.key), eq(schema.approvals.state, "pending")))
          .returning();
        if (a) {
          const view = await approvalView(this.#ctx, a.id);
          if (view)
            this.#ctx.hub.publish(workspaceId, { type: "approval.updated", approval: view });
        }
      }
      if (w.kind === "event" && w.eventType === RUN_FINISHED && w.key) {
        await this.cancel(workspaceId, w.key);
      }
    }
    await this.#publishRun(updated);
    await this.#publishWorkflow(updated.workflowId);
    await this.#notifyParent(updated);
    return updated;
  }

  /**
   * Starts a new run from the same trigger and payload. It uses the active
   * version if that still has the trigger node, else the run's own version.
   */
  async retry(workspaceId: string, runId: string): Promise<RunRow | null> {
    const [old] = await this.#db
      .select()
      .from(schema.workflowRuns)
      .where(
        and(eq(schema.workflowRuns.id, runId), eq(schema.workflowRuns.workspaceId, workspaceId)),
      );
    if (!old) return null;
    const [wf] = await this.#db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, old.workflowId));
    if (!wf) return null;
    let versionId = old.versionId;
    if (wf.activeVersionId) {
      const active = await this.version(wf.activeVersionId);
      if (active?.graph.nodes.has(old.triggerNodeId)) versionId = active.id;
    }
    const payload = old.triggerPayload as TriggerPayload;
    return this.startRun({
      workflowId: wf.id,
      workspaceId: wf.workspaceId,
      ownerId: wf.ownerId,
      versionId,
      triggerNodeId: old.triggerNodeId,
      outputs: payload?.outputs ?? {},
      installationId: payload?.installationId ?? null,
      concurrencyKey: old.concurrencyKey,
    });
  }

  /** How many runs up the parent chain this run is. */
  async depth(runId: string): Promise<number> {
    let depth = 0;
    let id: string | null = runId;
    while (id && depth <= MAX_RUN_DEPTH) {
      const [r] = await this.#db
        .select({ parent: schema.workflowRuns.parentRunId })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, id));
      id = r?.parent ?? null;
      if (id) depth++;
    }
    return depth;
  }

  // ------------------------------------------------------------- housekeeping

  /** Drops stored inputs and outputs of node runs past the retention window. */
  async prunePayloads(now = Date.now()): Promise<number> {
    const rows = await this.#db
      .update(schema.nodeRuns)
      .set({ inputs: null, outputs: null })
      .where(
        and(
          lt(schema.nodeRuns.startedAt, new Date(now - PAYLOAD_RETENTION_MS)),
          or(isNotNull(schema.nodeRuns.inputs), isNotNull(schema.nodeRuns.outputs)),
        ),
      )
      .returning({ id: schema.nodeRuns.id });
    return rows.length;
  }

  // ------------------------------------------------------------- realtime

  async #publishRun(run: RunRow) {
    const version = await this.version(run.versionId);
    const [wf] = await this.#db
      .select({ name: schema.workflows.name })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, run.workflowId));
    this.#ctx.hub.publish(run.workspaceId, {
      type: "run.updated",
      run: toRunView(run, wf?.name ?? "", version?.number ?? 0),
    });
  }

  async #publishWorkflow(workflowId: string) {
    const [wf] = await this.#db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, workflowId));
    if (!wf) return;
    this.#ctx.hub.publish(wf.workspaceId, {
      type: "workflow.updated",
      workflow: await workflowSummary(this.#ctx, wf),
    });
  }
}
