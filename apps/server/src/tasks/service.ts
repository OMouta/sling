import {
  type ActionKind,
  APPROVAL_TTL_MS,
  canTransitionTask,
  type Delivery,
  type Harness,
  isTerminalAction,
  isTerminalTask,
  MODE_POLICY,
  needsApproval,
  newId,
  type PermissionMode,
  type RoutingView,
  type TaskState,
  taskBranch,
} from "@sling/core";
import { type Db, schema } from "@sling/db";
import { create, type Envelope, EnvelopeSchema, type TaskEvent } from "@sling/runner-protocol";
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { loadRouterInput } from "../routing/inputs.ts";
import { type Environment, route } from "../routing/router.ts";
import { modeToProto } from "../runners/convert.ts";
import type { GatewayHandlers, RunnerSession } from "../runners/gateway.ts";
import { workspaceSettings } from "../sandboxes/settings.ts";
import { approvalView, taskView, toEventView } from "../views.ts";
import { ACTION_KIND_TO_PROTO, DROPPABLE, FINISHED_STATE, toStoredEvent } from "./events.ts";

type TaskRow = typeof schema.tasks.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Per-task cap on stored event payload. */
export const EVENT_BYTES_CAP = 20 * 1024 * 1024;
/** How long a task waits for its Runner to come back before it's interrupted. */
export const OFFLINE_GRACE_MS = 30 * 60 * 1000;
/** Task events are kept this long. */
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const ACTIVE: TaskState[] = ["dispatched", "running"];

export class TaskInputError extends Error {}

/** No machine or sandbox can take the task. Nothing was created. */
export class TaskRoutingError extends TaskInputError {
  readonly routing: RoutingView;
  /** Why, one line per machine, plus why a sandbox can't take it. */
  readonly reasons: string[];

  constructor(message: string, routing: RoutingView, reasons: string[]) {
    super(message);
    this.routing = routing;
    this.reasons = reasons;
  }
}

export interface CreateTaskInput {
  workspaceId: string;
  ownerId: string;
  conversationId: string | null;
  /** A repo name, a remote key such as `github.com/a/site`, or a remote URL. */
  repo: string;
  title: string;
  objective: string;
  mode: PermissionMode;
  deliver: Delivery;
  /** `auto` picks a machine and offers a sandbox when none can take it. */
  environment?: Environment;
  /** Preferred machine for `auto`; the only one for `machine`. */
  machineId?: string | null;
  /** Sandbox provider installation. Defaults to the first enabled one. */
  providerInstallationId?: string | null;
  /** Defaults to the workspace's default agent. */
  harness?: Harness | null;
  /** Labels the machine must have. */
  labels?: string[];
}

export interface CreatedTask {
  task: TaskRow;
  routing: RoutingView;
  /** Set when no machine could take it and a sandbox needs approval first. */
  approvalId: string | null;
}

/** Why a task reached a point where the conversation should hear about it. */
export type SettleReason = "finished" | "approval_needed" | "delivered";

export class TaskService implements GatewayHandlers {
  readonly #ctx: AppContext;
  /** Set by the agent so it can report back in the conversation. */
  onSettled: ((taskId: string, reason: SettleReason) => Promise<void>) | null = null;
  /** Set by the workflow engine. Called when a `workflow` approval is decided or expires. */
  onWorkflowApproval: ((approval: typeof schema.approvals.$inferSelect) => Promise<void>) | null =
    null;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  get #db() {
    return this.#ctx.db;
  }

  // ------------------------------------------------------------- creating

  /**
   * Routes and creates a task. It goes to a machine right away, to a sandbox
   * when one was asked for, or waits for a sandbox approval when no machine
   * can take it. Throws TaskRoutingError when nothing can.
   */
  async create(input: CreateTaskInput): Promise<CreatedTask> {
    const db = this.#db;
    const title = input.title.trim().slice(0, 120);
    const objective = input.objective.trim();
    if (!title || !objective) throw new TaskInputError("A task needs a title and an objective.");
    const repo = input.repo.trim();
    if (!repo) throw new TaskInputError("A task needs a repo.");

    const { defaultHarness } = await workspaceSettings(this.#ctx, input.workspaceId);
    const harness = input.harness ?? defaultHarness;
    const started = performance.now();
    const routerInput = await loadRouterInput(
      this.#ctx,
      input.workspaceId,
      {
        repo,
        harness,
        labels: input.labels ?? [],
        environment: input.environment ?? "auto",
        machineId: input.machineId ?? null,
        providerInstallationId: input.providerInstallationId ?? null,
      },
      input.mode,
    );
    const { decision, routing } = route(routerInput);
    this.#ctx.log.debug(
      { ms: Math.round((performance.now() - started) * 100) / 100, decision: decision.kind },
      "routed task",
    );
    if (decision.kind === "refused") {
      throw new TaskRoutingError(decision.message, routing, decision.reasons);
    }

    const id = newId("tsk");
    const deliver: Delivery = MODE_POLICY[input.mode].writes ? input.deliver : "local";
    const machine = decision.kind === "machine" ? decision : null;
    const [task] = await db
      .insert(schema.tasks)
      .values({
        id,
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        conversationId: input.conversationId,
        runnerId: machine?.runnerId ?? null,
        repoId: machine?.repoId ?? null,
        repoName: decision.repoName,
        title,
        objective,
        mode: input.mode,
        deliver,
        harness,
        environment: machine ? "machine" : "sandbox",
        routing,
        branch: taskBranch(id, title),
      })
      .returning();
    if (!task) throw new Error("insert failed");
    await audit(this.#ctx, {
      workspaceId: input.workspaceId,
      actorType: "agent",
      actorId: input.ownerId,
      verb: "task.created",
      subjectType: "task",
      subjectId: id,
      details: {
        runner: machine?.runnerName ?? null,
        repo: decision.repoName,
        mode: input.mode,
        deliver,
        harness,
        environment: task.environment,
        routing: routing.reason,
      },
    });

    let approvalId: string | null = null;
    if (decision.kind === "machine") {
      await this.publish(id);
      await this.dispatch(id);
    } else if (decision.fallback) {
      approvalId = await this.#ctx.sandboxes.offerFallback(task, decision);
      await this.publish(id);
      await this.#publishApproval(task.workspaceId, approvalId);
      await this.settle(id, "approval_needed");
    } else {
      await this.publish(id);
      await this.#ctx.sandboxes.request(task, decision.provider.id, decision.repo.remoteKey);
    }
    const [fresh] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    return { task: fresh ?? task, routing, approvalId };
  }

  /** Sends a queued task to its Runner if the Runner has room. */
  async dispatch(taskId: string): Promise<void> {
    const claimed = await this.#db.transaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .for("update");
      // biome-ignore lint/complexity/useOptionalChain: the explicit check keeps `task` narrowed below.
      if (!task || task.state !== "queued") return null;
      // A task waiting for a sandbox has no Runner yet. It's dispatched once one is bound.
      const runnerId = task.runnerId;
      if (!runnerId || !this.#ctx.runners.isOnline(runnerId)) return null;
      const [runner] = await tx
        .select()
        .from(schema.runners)
        .where(eq(schema.runners.id, runnerId))
        .for("update");
      if (!runner || runner.revokedAt) return null;
      const [active] = await tx
        .select({ n: count() })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.runnerId, runner.id), inArray(schema.tasks.state, ACTIVE)));
      if ((active?.n ?? 0) >= runner.maxConcurrentTasks) return null;
      await tx
        .update(schema.tasks)
        .set({ state: "dispatched", dispatchedAt: new Date() })
        .where(eq(schema.tasks.id, task.id));
      return { task, runnerId };
    });
    if (!claimed) return;
    // Sent only once `dispatched` is committed: a fast Runner's first event can
    // arrive before this call returns, and must find the task dispatched.
    if (!this.#send(claimed.runnerId, this.#assignEnvelope(claimed.task))) {
      await this.#db
        .update(schema.tasks)
        .set({ state: "queued", dispatchedAt: null })
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.state, "dispatched")));
      return;
    }
    if (claimed.task.sandboxId) await this.#ctx.sandboxes.taskDispatched(claimed.task.sandboxId);
    await this.publish(taskId);
  }

  async dispatchQueued(runnerId: string): Promise<void> {
    const queued = await this.#db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.runnerId, runnerId), eq(schema.tasks.state, "queued")))
      .orderBy(asc(schema.tasks.createdAt));
    for (const t of queued) await this.dispatch(t.id);
  }

  #assignEnvelope(task: TaskRow): Envelope {
    return create(EnvelopeSchema, {
      body: {
        case: "taskAssign",
        value: {
          taskId: task.id,
          repo: task.repoName,
          title: task.title,
          objective: task.objective,
          mode: modeToProto(task.mode),
          harness: task.harness,
          branch: task.branch,
        },
      },
    });
  }

  #send(runnerId: string, envelope: Envelope): boolean {
    return this.#ctx.runners.send(runnerId, envelope);
  }

  // ------------------------------------------------------------- cancel

  async cancel(workspaceId: string, taskId: string, actorId: string): Promise<TaskRow | null> {
    const [task] = await this.#db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, workspaceId)));
    if (!task || isTerminalTask(task.state)) return task ?? null;
    if (task.state === "queued") {
      await this.#setState(task.id, "queued", "cancelled", {
        error: "Cancelled before it started.",
      });
      await this.#expireTaskApprovals(task.id);
      await this.settle(task.id, "finished");
    } else {
      await this.#db
        .update(schema.tasks)
        .set({ cancelRequestedAt: new Date() })
        .where(eq(schema.tasks.id, task.id));
      if (task.runnerId) {
        this.#send(
          task.runnerId,
          create(EnvelopeSchema, { body: { case: "taskCancel", value: { taskId: task.id } } }),
        );
      }
    }
    await audit(this.#ctx, {
      workspaceId,
      actorType: "user",
      actorId,
      verb: "task.cancel_requested",
      subjectType: "task",
      subjectId: task.id,
    });
    await this.publish(task.id);
    return task;
  }

  // ------------------------------------------------------------- gateway

  async connected(
    session: RunnerSession,
    hello: { heldTasks: { taskId: string; running: boolean; lastSeq: bigint }[] },
  ): Promise<string[]> {
    const held = new Map(hello.heldTasks.map((h) => [h.taskId, h]));
    if (held.size === 0) return [];
    const rows = await this.#db
      .select()
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, [...held.keys()]));
    const byId = new Map(rows.map((t) => [t.id, t]));
    const forget: string[] = [];
    const openActions = await this.#db
      .select({ taskId: schema.actions.taskId, state: schema.actions.state })
      .from(schema.actions)
      .where(inArray(schema.actions.taskId, [...held.keys()]));
    for (const [id, h] of held) {
      const t = byId.get(id);
      if (!t || t.runnerId !== session.runnerId) {
        forget.push(id);
        continue;
      }
      const actionsDone = openActions
        .filter((a) => a.taskId === id)
        .every((a) => isTerminalAction(a.state));
      if (isTerminalTask(t.state) && actionsDone && !h.running && t.lastSeq >= Number(h.lastSeq)) {
        forget.push(id);
      }
    }
    return forget;
  }

  async ready(
    session: RunnerSession,
    hello: { heldTasks: { taskId: string; running: boolean }[] },
  ): Promise<void> {
    // A sandbox's Runner gets its waiting task bound here, then dispatched below.
    await this.#ctx.sandboxes.runnerConnected(session.runnerId);
    const held = new Map(hello.heldTasks.map((h) => [h.taskId, h]));
    const active = await this.#db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.runnerId, session.runnerId), inArray(schema.tasks.state, ACTIVE)));
    for (const t of active) {
      const h = held.get(t.id);
      if (!h) {
        if (t.state === "dispatched") {
          // It never reached the Runner. Send it again.
          this.#send(session.runnerId, this.#assignEnvelope(t));
        } else {
          await this.#setState(t.id, t.state, "interrupted", {
            error: "The machine came back without this task. It was probably lost in a crash.",
          });
          await this.settle(t.id, "finished");
        }
        continue;
      }
      await this.#db
        .update(schema.tasks)
        .set({ runnerOfflineSince: null })
        .where(eq(schema.tasks.id, t.id));
      if (t.cancelRequestedAt && h.running) {
        this.#send(
          session.runnerId,
          create(EnvelopeSchema, { body: { case: "taskCancel", value: { taskId: t.id } } }),
        );
      }
      await this.publish(t.id);
    }

    // Actions that were in flight when the connection dropped get sent again.
    // Push and open-PR are idempotent on the Runner side.
    const inflight = await this.#db
      .select({ id: schema.actions.id, taskId: schema.actions.taskId })
      .from(schema.actions)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.actions.taskId))
      .where(
        and(
          eq(schema.tasks.runnerId, session.runnerId),
          inArray(schema.actions.state, ["sent", "ready"]),
        ),
      );
    for (const a of inflight) {
      await this.#db
        .update(schema.actions)
        .set({ state: "ready" })
        .where(eq(schema.actions.id, a.id));
    }
    for (const taskId of new Set(inflight.map((a) => a.taskId))) {
      await this.#advanceActions(taskId);
    }
    await this.dispatchQueued(session.runnerId);
  }

  async inventoryUpdated(session: RunnerSession): Promise<void> {
    await this.#ctx.sandboxes.runnerConnected(session.runnerId);
    await this.dispatchQueued(session.runnerId);
  }

  async disconnected(session: RunnerSession): Promise<void> {
    const rows = await this.#db
      .update(schema.tasks)
      .set({ runnerOfflineSince: new Date() })
      .where(
        and(
          eq(schema.tasks.runnerId, session.runnerId),
          inArray(schema.tasks.state, ACTIVE),
          isNull(schema.tasks.runnerOfflineSince),
        ),
      )
      .returning({ id: schema.tasks.id });
    for (const r of rows) await this.publish(r.id);
  }

  async runnerRevoked(runnerId: string): Promise<void> {
    const rows = await this.#db
      .select()
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.runnerId, runnerId),
          inArray(schema.tasks.state, ["queued", ...ACTIVE]),
        ),
      );
    for (const t of rows) {
      const to: TaskState = t.state === "queued" ? "cancelled" : "interrupted";
      await this.#setState(t.id, t.state, to, { error: "The machine was revoked." });
      await this.settle(t.id, "finished");
    }
    const pending = await this.#db
      .select({ id: schema.actions.id, taskId: schema.actions.taskId })
      .from(schema.actions)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.actions.taskId))
      .where(
        and(
          eq(schema.tasks.runnerId, runnerId),
          inArray(schema.actions.state, ["awaiting_approval", "ready", "sent"]),
        ),
      );
    for (const a of pending) {
      await this.#skipRemaining(a.taskId, "The machine was revoked.");
      await this.publish(a.taskId);
    }
  }

  async taskEvent(session: RunnerSession, ev: TaskEvent): Promise<void> {
    const seq = Number(ev.seq);
    const ack = (upTo: number) =>
      session.send(
        create(EnvelopeSchema, {
          body: { case: "eventAck", value: { taskId: ev.taskId, seq: BigInt(upTo) } },
        }),
      );

    const [task] = await this.#db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, ev.taskId), eq(schema.tasks.runnerId, session.runnerId)));
    if (!task) {
      // Unknown or someone else's task. Ack so the Runner stops resending.
      ack(seq);
      return;
    }
    if (seq <= task.lastSeq) {
      ack(task.lastSeq);
      return;
    }
    if (seq > task.lastSeq + 1) {
      // A gap. Wait for the Runner to resend in order.
      return;
    }

    const stored = toStoredEvent(ev);
    const at = new Date(Number(ev.atMs) || Date.now());
    const size = stored ? JSON.stringify(stored.payload).length : 0;
    let followUp: (() => Promise<void>) | null = null;

    await this.#db.transaction(async (tx) => {
      const overCap = task.eventBytes + size > EVENT_BYTES_CAP;
      if (stored && !(overCap && DROPPABLE.has(stored.type))) {
        await tx
          .insert(schema.taskEvents)
          .values({
            taskId: task.id,
            seq,
            workspaceId: task.workspaceId,
            at,
            type: stored.type,
            payload: stored.payload,
          })
          .onConflictDoNothing();
      } else if (stored && task.eventBytes <= EVENT_BYTES_CAP) {
        await tx
          .insert(schema.taskEvents)
          .values({
            taskId: task.id,
            seq,
            workspaceId: task.workspaceId,
            at,
            type: "truncated",
            payload: { message: "Event storage limit reached. Later output was dropped." },
          })
          .onConflictDoNothing();
      }
      await tx
        .update(schema.tasks)
        .set({ lastSeq: seq, eventBytes: sql`${schema.tasks.eventBytes} + ${size}` })
        .where(eq(schema.tasks.id, task.id));
      followUp = await this.#applyEffects(tx, task, ev);
    });
    ack(seq);

    if (stored) {
      this.#ctx.hub.publish(task.workspaceId, {
        type: "task.event",
        event: toEventView({
          taskId: task.id,
          seq,
          workspaceId: task.workspaceId,
          at,
          type: stored.type,
          payload: stored.payload,
        }),
      });
    }
    if (followUp) await (followUp as () => Promise<void>)();
  }

  /** State changes caused by an event. Returns work to do after commit. */
  async #applyEffects(tx: Tx, task: TaskRow, ev: TaskEvent): Promise<(() => Promise<void>) | null> {
    const k = ev.kind;
    switch (k.case) {
      case "accepted":
        if (canTransitionTask(task.state, "running")) {
          await tx
            .update(schema.tasks)
            .set({ state: "running", startedAt: new Date() })
            .where(eq(schema.tasks.id, task.id));
        }
        return () => this.publish(task.id);
      case "rejected":
        if (canTransitionTask(task.state, "rejected")) {
          await tx
            .update(schema.tasks)
            .set({ state: "rejected", error: k.value.message, finishedAt: new Date() })
            .where(eq(schema.tasks.id, task.id));
        }
        return async () => {
          await this.publish(task.id);
          await this.settle(task.id, "finished");
          if (task.runnerId) await this.dispatchQueued(task.runnerId);
        };
      case "started":
        await tx
          .update(schema.tasks)
          .set({ baseSha: k.value.baseSha, harnessVersion: k.value.harnessVersion })
          .where(eq(schema.tasks.id, task.id));
        await tx.insert(schema.artifacts).values({
          id: newId("art"),
          workspaceId: task.workspaceId,
          ownerId: task.ownerId,
          taskId: task.id,
          type: "branch",
          ref: k.value.branch,
        });
        return () => this.publish(task.id);
      case "usage":
        await tx
          .update(schema.tasks)
          .set({
            usage: {
              inputTokens: Number(k.value.inputTokens),
              cachedInputTokens: Number(k.value.cachedInputTokens),
              outputTokens: Number(k.value.outputTokens),
            },
          })
          .where(eq(schema.tasks.id, task.id));
        return null;
      case "finished": {
        const state = FINISHED_STATE[k.value.outcome] ?? "failed";
        const [current] = await tx
          .select({ state: schema.tasks.state })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, task.id));
        const from = current?.state ?? task.state;
        if (!canTransitionTask(from, state)) return () => this.publish(task.id);
        const stats = k.value.diffStats;
        await tx
          .update(schema.tasks)
          .set({
            state,
            summary: k.value.summary || null,
            error: k.value.error || null,
            commitSha: k.value.commitSha || null,
            diffStats: stats
              ? {
                  filesChanged: stats.filesChanged,
                  insertions: stats.insertions,
                  deletions: stats.deletions,
                }
              : null,
            finishedAt: new Date(),
            runnerOfflineSince: null,
          })
          .where(eq(schema.tasks.id, task.id));
        let createdActions = false;
        if (state === "succeeded" && k.value.commitSha) {
          await tx.insert(schema.artifacts).values({
            id: newId("art"),
            workspaceId: task.workspaceId,
            ownerId: task.ownerId,
            taskId: task.id,
            type: "commit",
            ref: k.value.commitSha,
          });
          createdActions = await this.#createActions(tx, task, k.value.summary);
        }
        return async () => {
          await this.publish(task.id);
          if (createdActions) {
            const reason = await this.#advanceActions(task.id);
            if (reason) await this.settle(task.id, reason);
          } else {
            await this.settle(task.id, "finished");
          }
          if (task.runnerId) await this.dispatchQueued(task.runnerId);
        };
      }
      case "actionResult": {
        const r = k.value;
        const outcome = toStoredEvent(ev)?.payload.outcome as "succeeded" | "failed" | "refused";
        const [action] = await tx
          .update(schema.actions)
          .set({
            state: outcome,
            url: r.url || null,
            message: r.message || null,
            finishedAt: new Date(),
          })
          .where(
            and(
              eq(schema.actions.id, r.actionId),
              eq(schema.actions.taskId, task.id),
              eq(schema.actions.state, "sent"),
            ),
          )
          .returning();
        if (action && outcome === "succeeded" && r.url) {
          await tx.insert(schema.artifacts).values({
            id: newId("art"),
            workspaceId: task.workspaceId,
            ownerId: task.ownerId,
            taskId: task.id,
            type: action.kind === "open_pr" && r.url.includes("/pull/") ? "pr" : "compare",
            ref: action.kind === "open_pr" ? "pull request" : task.branch,
            url: r.url,
          });
        }
        if (action) {
          await audit(
            { db: tx as unknown as Db, log: this.#ctx.log },
            {
              workspaceId: task.workspaceId,
              actorType: "runner",
              actorId: task.runnerId,
              verb: `action.${outcome}`,
              subjectType: "action",
              subjectId: action.id,
              details: { kind: action.kind, url: r.url, message: r.message },
            },
          );
        }
        return async () => {
          const reason = await this.#advanceActions(task.id);
          if (reason) await this.settle(task.id, reason);
        };
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------- actions

  /** Creates push and PR actions after a successful task. */
  async #createActions(tx: Tx, task: TaskRow, summary: string): Promise<boolean> {
    if (!MODE_POLICY[task.mode].writes || task.deliver === "local") return false;
    const kinds: ActionKind[] = task.deliver === "pr" ? ["push", "open_pr"] : ["push"];
    const body = [
      summary.trim() || task.objective,
      "",
      "---",
      `Sling task \`${task.id}\`, ${task.mode} mode.`,
    ].join("\n");
    for (const [position, kind] of kinds.entries()) {
      const requiresApproval = needsApproval(task.mode, kind);
      const actionId = newId("act");
      await tx.insert(schema.actions).values({
        id: actionId,
        workspaceId: task.workspaceId,
        ownerId: task.ownerId,
        taskId: task.id,
        kind,
        position,
        state: requiresApproval ? "awaiting_approval" : "ready",
        requiresApproval,
        prTitle: kind === "open_pr" ? task.title : null,
        prBody: kind === "open_pr" ? body : null,
      });
      if (requiresApproval) {
        await tx.insert(schema.approvals).values({
          id: newId("apv"),
          workspaceId: task.workspaceId,
          ownerId: task.ownerId,
          actionId,
          taskId: task.id,
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
        });
      }
    }
    return true;
  }

  /**
   * Sends the next ready action. Returns a settle reason when the delivery
   * reaches a point the conversation should hear about.
   */
  async #advanceActions(taskId: string): Promise<SettleReason | null> {
    const actions = await this.#db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.taskId, taskId))
      .orderBy(asc(schema.actions.position));
    let reason: SettleReason | null = null;
    for (const a of actions) {
      if (isTerminalAction(a.state)) {
        if (a.state !== "succeeded") {
          await this.#skipRemaining(taskId, "An earlier step didn't succeed.");
          reason = "delivered";
          break;
        }
        continue;
      }
      if (a.state === "awaiting_approval") {
        reason = "approval_needed";
        break;
      }
      if (a.state === "ready") {
        const [task] = await this.#db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId));
        if (!task?.runnerId) break;
        const sent = this.#send(
          task.runnerId,
          create(EnvelopeSchema, {
            body: {
              case: "actionRequest",
              value: {
                actionId: a.id,
                taskId,
                kind: ACTION_KIND_TO_PROTO[a.kind as "push" | "open_pr"],
                prTitle: a.prTitle ?? "",
                prBody: a.prBody ?? "",
              },
            },
          }),
        );
        if (sent) {
          await this.#db
            .update(schema.actions)
            .set({ state: "sent", sentAt: new Date() })
            .where(and(eq(schema.actions.id, a.id), eq(schema.actions.state, "ready")));
        }
        break;
      }
      // "sent": waiting on the Runner.
      break;
    }
    if (!reason && actions.length > 0) {
      const all = await this.#db
        .select({ state: schema.actions.state })
        .from(schema.actions)
        .where(eq(schema.actions.taskId, taskId));
      if (all.every((x) => isTerminalAction(x.state))) reason = "delivered";
    }
    await this.publish(taskId);
    return reason;
  }

  async #skipRemaining(taskId: string, message: string) {
    await this.#db
      .update(schema.actions)
      .set({ state: "skipped", message, finishedAt: new Date() })
      .where(
        and(
          eq(schema.actions.taskId, taskId),
          inArray(schema.actions.state, ["awaiting_approval", "ready"]),
        ),
      );
    await this.#db
      .update(schema.approvals)
      .set({ state: "expired" })
      .where(and(eq(schema.approvals.taskId, taskId), eq(schema.approvals.state, "pending")));
  }

  // ------------------------------------------------------------- approvals

  /**
   * Approves or rejects one approval. `via` is set when the decision came from
   * outside the web app, for example a Discord button.
   */
  async decide(
    workspaceId: string,
    approvalId: string,
    userId: string,
    approve: boolean,
    via?: { via: string; externalUserId: string },
  ): Promise<boolean> {
    const [approval] = await this.#db
      .update(schema.approvals)
      .set({
        state: approve ? "approved" : "rejected",
        decidedBy: userId,
        decidedVia: via?.via ?? null,
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(schema.approvals.id, approvalId),
          eq(schema.approvals.workspaceId, workspaceId),
          eq(schema.approvals.state, "pending"),
        ),
      )
      .returning();
    if (!approval) return false;
    await audit(this.#ctx, {
      workspaceId,
      actorType: "user",
      actorId: userId,
      verb: approve ? "approval.approved" : "approval.rejected",
      subjectType: "approval",
      subjectId: approval.id,
      details: {
        kind: approval.kind,
        taskId: approval.taskId,
        actionId: approval.actionId,
        runId: approval.runId,
        ...(via ? { via: via.via, externalUserId: via.externalUserId } : {}),
      },
    });
    await this.#publishApproval(workspaceId, approval.id);

    if (approval.kind === "workflow") {
      await this.onWorkflowApproval?.(approval);
      return true;
    }
    if (approval.kind === "sandbox_fallback") {
      await this.#ctx.sandboxes.fallbackDecided(approval, approve ? "approved" : "rejected");
      return true;
    }
    const { actionId, taskId } = approval;
    if (!actionId || !taskId) return true;
    await this.#db
      .update(schema.actions)
      .set(
        approve
          ? { state: "ready" }
          : { state: "rejected", message: "Rejected.", finishedAt: new Date() },
      )
      .where(and(eq(schema.actions.id, actionId), eq(schema.actions.state, "awaiting_approval")));
    const reason = await this.#advanceActions(taskId);
    if (reason && reason !== "approval_needed") await this.settle(taskId, reason);
    return true;
  }

  /** Approves or rejects every pending approval on a task at once. */
  async decideTask(workspaceId: string, taskId: string, userId: string, approve: boolean) {
    const pending = await this.#db
      .select({ id: schema.approvals.id })
      .from(schema.approvals)
      .leftJoin(schema.actions, eq(schema.actions.id, schema.approvals.actionId))
      .where(
        and(
          eq(schema.approvals.taskId, taskId),
          eq(schema.approvals.workspaceId, workspaceId),
          eq(schema.approvals.state, "pending"),
          inArray(schema.approvals.kind, ["task_action", "sandbox_fallback"]),
        ),
      )
      .orderBy(sql`${schema.actions.position} asc nulls first`);
    let n = 0;
    for (const p of pending) {
      if (await this.decide(workspaceId, p.id, userId, approve)) n++;
      if (!approve) break;
    }
    return n;
  }

  async #publishApproval(workspaceId: string, approvalId: string) {
    const view = await approvalView(this.#ctx, approvalId);
    if (view) this.#ctx.hub.publish(workspaceId, { type: "approval.updated", approval: view });
  }

  // ------------------------------------------------------------- sweeps

  /** Runs every minute: offline timeouts, approval expiry, stuck queues. */
  async sweep(): Promise<void> {
    const db = this.#db;
    const lost = await db
      .select()
      .from(schema.tasks)
      .where(
        and(
          inArray(schema.tasks.state, ACTIVE),
          isNotNull(schema.tasks.runnerOfflineSince),
          lt(schema.tasks.runnerOfflineSince, new Date(Date.now() - OFFLINE_GRACE_MS)),
        ),
      );
    for (const t of lost) {
      await this.#setState(t.id, t.state, "interrupted", {
        error: "The machine stayed offline for more than 30 minutes.",
      });
      await this.settle(t.id, "finished");
    }

    const expired = await db
      .update(schema.approvals)
      .set({ state: "expired" })
      .where(and(eq(schema.approvals.state, "pending"), lt(schema.approvals.expiresAt, new Date())))
      .returning();
    for (const a of expired) {
      await this.#publishApproval(a.workspaceId, a.id);
      if (a.kind === "workflow") {
        await this.onWorkflowApproval?.(a);
        continue;
      }
      if (a.kind === "sandbox_fallback") {
        await this.#ctx.sandboxes.fallbackDecided(a, "expired");
        continue;
      }
      if (!a.actionId || !a.taskId) continue;
      await db
        .update(schema.actions)
        .set({ state: "expired", message: "The approval expired.", finishedAt: new Date() })
        .where(
          and(eq(schema.actions.id, a.actionId), eq(schema.actions.state, "awaiting_approval")),
        );
      const reason = await this.#advanceActions(a.taskId);
      if (reason) await this.settle(a.taskId, reason);
    }

    const queued = await db
      .selectDistinct({ runnerId: schema.tasks.runnerId })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.state, "queued"), isNotNull(schema.tasks.runnerId)));
    for (const q of queued) {
      if (q.runnerId && this.#ctx.runners.isOnline(q.runnerId)) {
        await this.dispatchQueued(q.runnerId);
      }
    }
  }

  /** Runs daily: drops task events past the retention window. */
  async pruneEvents(): Promise<number> {
    const rows = await this.#db
      .delete(schema.taskEvents)
      .where(lt(schema.taskEvents.at, new Date(Date.now() - EVENT_RETENTION_MS)))
      .returning({ taskId: schema.taskEvents.taskId });
    return rows.length;
  }

  /**
   * Ends a task from outside its Runner, for example when its sandbox is
   * destroyed. A queued task becomes `queuedTo`, a running one interrupted,
   * and delivery steps that can't run any more are skipped. Settles it.
   */
  async end(
    taskId: string,
    error: string,
    queuedTo: "failed" | "cancelled" = "failed",
  ): Promise<void> {
    const [task] = await this.#db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    if (!task) return;
    if (!isTerminalTask(task.state)) {
      const to: TaskState = task.state === "queued" ? queuedTo : "interrupted";
      if (!(await this.#setState(task.id, task.state, to, { error }))) return;
      await this.#expireTaskApprovals(task.id);
      await this.settle(task.id, "finished");
      return;
    }
    const open = await this.#db
      .update(schema.actions)
      .set({ state: "failed", message: error, finishedAt: new Date() })
      .where(and(eq(schema.actions.taskId, task.id), eq(schema.actions.state, "sent")))
      .returning({ id: schema.actions.id });
    const pending = await this.#db
      .select({ id: schema.actions.id })
      .from(schema.actions)
      .where(
        and(
          eq(schema.actions.taskId, task.id),
          inArray(schema.actions.state, ["awaiting_approval", "ready"]),
        ),
      );
    if (open.length === 0 && pending.length === 0) return;
    await this.#skipRemaining(task.id, error);
    await this.publish(task.id);
    await this.settle(task.id, "delivered");
  }

  async #expireTaskApprovals(taskId: string) {
    const rows = await this.#db
      .update(schema.approvals)
      .set({ state: "expired" })
      .where(and(eq(schema.approvals.taskId, taskId), eq(schema.approvals.state, "pending")))
      .returning();
    for (const a of rows) await this.#publishApproval(a.workspaceId, a.id);
  }

  // ------------------------------------------------------------- helpers

  async #setState(
    taskId: string,
    from: TaskState,
    to: TaskState,
    extra: { error?: string } = {},
  ): Promise<boolean> {
    if (!canTransitionTask(from, to)) return false;
    const rows = await this.#db
      .update(schema.tasks)
      .set({
        state: to,
        ...(extra.error ? { error: extra.error } : {}),
        ...(isTerminalTask(to) ? { finishedAt: new Date(), runnerOfflineSince: null } : {}),
      })
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.state, from)))
      .returning({ id: schema.tasks.id });
    await this.publish(taskId);
    return rows.length > 0;
  }

  /** Tells the conversation, the workflows, and the sandbox service that a task reached a settle point. */
  async settle(taskId: string, reason: SettleReason) {
    try {
      await this.onSettled?.(taskId, reason);
    } catch (err) {
      this.#ctx.log.error({ err, taskId }, "settle hook failed");
    }
  }

  async publish(taskId: string): Promise<void> {
    const view = await taskView(this.#ctx, taskId);
    if (!view) return;
    const [row] = await this.#db
      .select({ workspaceId: schema.tasks.workspaceId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    if (row) this.#ctx.hub.publish(row.workspaceId, { type: "task.updated", task: view });
  }
}
