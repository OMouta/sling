import {
  type ActionKind,
  type AgentChoice,
  APPROVAL_TTL_MS,
  canTransitionTask,
  type Delivery,
  type Harness,
  isTerminalAction,
  isTerminalTask,
  MODE_POLICY,
  newId,
  type PermissionMode,
  type RoutingView,
  STEP_KINDS,
  type TaskState,
  taskBranch,
} from "@sling/core";
import { type Db, schema } from "@sling/db";
import { create, type Envelope, EnvelopeSchema, type TaskEvent } from "@sling/runner-protocol";
import { and, asc, count, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { effectiveChat } from "../agent/chat-settings.ts";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { conversationPersonality } from "../personalities/service.ts";
import { loadRouterInput } from "../routing/inputs.ts";
import { type Environment, route } from "../routing/router.ts";
import { stepRule } from "../rules/steps.ts";
import { modeToProto } from "../runners/convert.ts";
import type { GatewayHandlers, RunnerSession } from "../runners/gateway.ts";
import { workspaceSettings } from "../sandboxes/settings.ts";
import { approvalView, taskView, toEventView } from "../views.ts";
import { ACTION_KIND_TO_PROTO, DROPPABLE, FINISHED_STATE, toStoredEvent } from "./events.ts";
import { deliveryPlan, deploySteps, reachedState } from "./plan.ts";

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

/** Why a task can't deploy later, with the status to answer. */
export class DeployLaterError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409 = 409) {
    super(message);
    this.status = status;
  }
}

/** Steps a task's own machine runs from its spool. The rest can run anywhere. */
const RUNNER_STEPS: ActionKind[] = ["push", "open_pr"];
/** Steps that come after the PR, through the repo's deploy target. */
const DEPLOY_STEPS: ActionKind[] = ["merge", "deploy", "verify"];

/**
 * The steps that count, in order. Deploying again after a deploy that didn't
 * go through adds new merge, deploy, and verify steps; the earlier ones stay
 * for the record, and only the newest of each kind counts.
 */
export function currentSteps<T extends { kind: string }>(ordered: T[]): T[] {
  const last = new Map<string, T>();
  for (const a of ordered) last.set(a.kind, a);
  return ordered.filter((a) => last.get(a.kind) === a);
}

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
  /** Defaults to the conversation's agent, then the workspace's. */
  harness?: Harness | null;
  /**
   * Model, effort, and fast tier for the agent. Undefined takes the
   * conversation's choice; they apply only when it names the same agent.
   */
  agent?: AgentChoice | null;
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
    const choice =
      input.agent !== undefined
        ? input.agent
        : (await effectiveChat(this.#ctx, input.workspaceId, input.conversationId)).agent;
    const harness = input.harness ?? choice?.harness ?? defaultHarness;
    const agent = choice?.harness === harness ? choice : null;
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
    if (input.deliver === "deploy") {
      const key =
        decision.kind === "machine"
          ? (routerInput.machines
              .find((m) => m.id === decision.runnerId)
              ?.repos.find((r) => r.id === decision.repoId)?.remoteKey ?? null)
          : decision.repo.remoteKey;
      await this.#checkDeploy(input, decision.repoName, key);
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
        agentModel: agent?.model ?? null,
        agentEffort: agent?.effort ?? null,
        agentFast: agent?.fast ?? false,
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
        model: agent?.model ?? null,
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

  /**
   * A deploy delivery needs a mode that writes, a deploy target for the repo,
   * and, from a chat, a personality that may deploy.
   */
  async #checkDeploy(input: CreateTaskInput, repoName: string, key: string | null) {
    if (!MODE_POLICY[input.mode].writes) {
      throw new TaskInputError(
        `${MODE_POLICY[input.mode].label} can't deploy. The user can switch the mode in the app.`,
      );
    }
    if (input.conversationId) {
      const [conv] = await this.#db
        .select({
          workspaceId: schema.conversations.workspaceId,
          personalityId: schema.conversations.personalityId,
        })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, input.conversationId));
      const personality = conv ? await conversationPersonality(this.#db, conv) : null;
      if (!personality?.tools.includes("deploys")) {
        throw new TaskInputError(
          `${personality?.name ?? "This chat's personality"} can't deploy. A personality with the Deploys tools can.`,
        );
      }
    }
    if (!key) {
      throw new TaskInputError(`${repoName} has no remote, so it can't have a deploy target.`);
    }
    const target = await this.#ctx.deploys.forRemote(input.workspaceId, key);
    if (!target) {
      throw new TaskInputError(
        `${repoName} (${key}) has no deploy target, so it can't deploy. Add one on the Deploys page.`,
      );
    }
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
          model: task.agentModel ?? "",
          effort: task.agentEffort ?? "",
          fast: task.agentFast,
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
    // Only push and PR need the task's spool; merges and deploys run from the remote.
    const openActions = await this.#db
      .select({ taskId: schema.actions.taskId, state: schema.actions.state })
      .from(schema.actions)
      .where(
        and(
          inArray(schema.actions.taskId, [...held.keys()]),
          inArray(schema.actions.kind, RUNNER_STEPS),
        ),
      );
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
    // Push and open-PR are idempotent on the Runner side. A merge or deploy
    // isn't sent again: the machine sends its result again instead.
    const inflight = await this.#db
      .select({ id: schema.actions.id, taskId: schema.actions.taskId })
      .from(schema.actions)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.actions.taskId))
      .where(
        and(
          eq(schema.tasks.runnerId, session.runnerId),
          inArray(schema.actions.state, ["sent", "ready"]),
          inArray(schema.actions.kind, RUNNER_STEPS),
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
    await this.#ctx.deploys.machineConnected(session.runnerId);
  }

  async inventoryUpdated(session: RunnerSession): Promise<void> {
    await this.#ctx.sandboxes.runnerConnected(session.runnerId);
    await this.dispatchQueued(session.runnerId);
    await this.#ctx.deploys.machineConnected(session.runnerId);
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
    // Push and PR can't run without the machine. Merges and deploys can, elsewhere.
    const pending = await this.#db
      .selectDistinct({ taskId: schema.actions.taskId })
      .from(schema.actions)
      .innerJoin(schema.tasks, eq(schema.tasks.id, schema.actions.taskId))
      .where(
        and(
          eq(schema.tasks.runnerId, runnerId),
          inArray(schema.actions.state, ["awaiting_approval", "ready", "sent"]),
          inArray(schema.actions.kind, RUNNER_STEPS),
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
          await this.advance(task.id);
          // A sandbox goes once its push and PR are done, without waiting for a deploy.
          if (task.sandboxId) await this.#ctx.sandboxes.onTaskSettled(task.id);
        };
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------- actions

  /** The repo's normalized remote: from the machine's repo, or the sandbox's. */
  async #remoteKeyOf(db: Db | Tx, task: TaskRow): Promise<string | null> {
    if (task.repoId) {
      const [repo] = await db
        .select({ remoteKey: schema.repos.remoteKey })
        .from(schema.repos)
        .where(eq(schema.repos.id, task.repoId));
      if (repo?.remoteKey) return repo.remoteKey;
    }
    if (task.sandboxId) {
      const [sbx] = await db
        .select({ remoteKey: schema.sandboxes.remoteKey })
        .from(schema.sandboxes)
        .where(eq(schema.sandboxes.id, task.sandboxId));
      if (sbx) return sbx.remoteKey;
    }
    return null;
  }

  /**
   * The steps after a successful task: push, then the PR, then for a deploy
   * the merge, the deploy unless the host deploys on merge, and verify.
   * Merge, deploy, and verify start queued; their approvals come once the
   * steps reach them.
   */
  async #createActions(tx: Tx, task: TaskRow, summary: string): Promise<boolean> {
    const first = deliveryPlan(task.deliver, task.mode, null);
    if (first.length === 0) return false;
    const body = [
      summary.trim() || task.objective,
      "",
      "---",
      `Sling task \`${task.id}\`, ${task.mode} mode.`,
    ].join("\n");
    for (const [position, step] of first.entries()) {
      const { kind } = step;
      // An allow rule answers for the user, so the step goes without asking.
      const ruled = step.requiresApproval ? await stepRule(this.#ctx, tx, task, kind) : null;
      const requiresApproval = step.requiresApproval && !ruled;
      const state = ruled ? "ready" : step.state;
      const actionId = newId("act");
      await tx.insert(schema.actions).values({
        id: actionId,
        workspaceId: task.workspaceId,
        ownerId: task.ownerId,
        taskId: task.id,
        kind,
        position,
        state,
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
      if (ruled) await this.#ctx.rules.used(ruled.rule, { ...ruled.call, actionId }, tx);
    }
    if (task.deliver === "deploy") await this.#addDeploySteps(tx, task, first.length);
    return true;
  }

  /** Adds queued merge, deploy, and verify steps for the repo's deploy target. */
  async #addDeploySteps(tx: Tx, task: TaskRow, position: number): Promise<number> {
    const key = await this.#remoteKeyOf(tx, task);
    const [target] = key
      ? await tx
          .select()
          .from(schema.deployTargets)
          .where(
            and(
              eq(schema.deployTargets.workspaceId, task.workspaceId),
              eq(schema.deployTargets.remoteKey, key),
            ),
          )
      : [];
    const steps = deploySteps(task.mode, target?.method ?? "command");
    for (const [i, step] of steps.entries()) {
      await tx.insert(schema.actions).values({
        id: newId("act"),
        workspaceId: task.workspaceId,
        ownerId: task.ownerId,
        taskId: task.id,
        kind: step.kind,
        position: position + i,
        ...(target
          ? { state: step.state }
          : {
              state: "skipped" as const,
              message: "The repo's deploy target was removed.",
              finishedAt: new Date(),
            }),
        requiresApproval: step.requiresApproval,
        targetId: target?.id ?? null,
      });
    }
    return steps.length;
  }

  /** Runs the task's next steps, and tells the conversation when it should hear. */
  async advance(taskId: string): Promise<void> {
    const reason = await this.#advanceActions(taskId);
    if (reason) await this.settle(taskId, reason);
  }

  /**
   * Starts the next step that can go. Returns a settle reason when the
   * delivery reaches a point the conversation should hear about: a step
   * waits for approval, or every step has ended.
   */
  async #advanceActions(taskId: string): Promise<SettleReason | null> {
    let reason: SettleReason | null = null;
    let steps: (typeof schema.actions.$inferSelect)[] = [];
    // Reaching queued steps changes them, so look again; a handful of passes covers every step.
    for (let pass = 0; pass < STEP_KINDS.length + 1; pass++) {
      const rows = await this.#db
        .select()
        .from(schema.actions)
        .where(eq(schema.actions.taskId, taskId))
        .orderBy(asc(schema.actions.position));
      steps = currentSteps(rows);
      reason = null;
      let allDone = steps.length > 0;
      let reached = false;
      for (const a of steps) {
        if (isTerminalAction(a.state)) {
          if (a.state !== "succeeded") {
            await this.#skipRemaining(taskId, "An earlier step didn't succeed.");
            reason = "delivered";
            allDone = false;
            break;
          }
          continue;
        }
        allDone = false;
        if (a.state === "awaiting_approval") reason = "approval_needed";
        else if (a.state === "queued") reached = await this.#reach(taskId, steps, a);
        else if (a.state === "ready") await this.#startStep(taskId, a);
        // "sent": waiting on whoever runs it.
        break;
      }
      if (allDone) reason = "delivered";
      if (!reached) break;
    }
    await this.publish(taskId);
    return reason;
  }

  /**
   * The steps reached a queued one. Verify just becomes ready. Reaching merge
   * gives merge and deploy their approvals now, the way the mode says, so
   * "Approve deployment?" always comes after the PR exists.
   */
  async #reach(
    taskId: string,
    steps: (typeof schema.actions.$inferSelect)[],
    step: typeof schema.actions.$inferSelect,
  ): Promise<boolean> {
    if (step.kind !== "merge" && step.kind !== "deploy") {
      await this.#db
        .update(schema.actions)
        .set({ state: "ready" })
        .where(and(eq(schema.actions.id, step.id), eq(schema.actions.state, "queued")));
      return true;
    }
    const [task] = await this.#db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    if (!task) return false;
    const gated = steps.filter(
      (s) => s.state === "queued" && (s.kind === "merge" || s.kind === "deploy"),
    );
    const targetIds = [...new Set(gated.flatMap((s) => (s.targetId ? [s.targetId] : [])))];
    const targets = targetIds.length
      ? await this.#db
          .select({
            id: schema.deployTargets.id,
            name: schema.deployTargets.name,
            method: schema.deployTargets.method,
          })
          .from(schema.deployTargets)
          .where(inArray(schema.deployTargets.id, targetIds))
      : [];
    const pr = steps.find((s) => s.kind === "open_pr");
    const created: string[] = [];
    await this.#db.transaction(async (tx) => {
      for (const s of gated) {
        const state = reachedState(task.mode, s.kind);
        const ask = state === "awaiting_approval";
        const [moved] = await tx
          .update(schema.actions)
          .set({ state, requiresApproval: ask })
          .where(and(eq(schema.actions.id, s.id), eq(schema.actions.state, "queued")))
          .returning({ id: schema.actions.id });
        if (!moved || !ask) continue;
        const target = targets.find((t) => t.id === s.targetId);
        const id = newId("apv");
        await tx.insert(schema.approvals).values({
          id,
          workspaceId: task.workspaceId,
          ownerId: task.ownerId,
          actionId: s.id,
          taskId: task.id,
          title:
            s.kind === "merge"
              ? `Merge: ${task.title}`
              : `Deploy${target ? ` to ${target.name}` : ""}: ${task.title}`,
          payload: {
            targetId: target?.id ?? null,
            targetName: target?.name ?? null,
            method: target?.method ?? null,
            prUrl: pr?.url ?? null,
          },
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
        });
        created.push(id);
      }
    });
    for (const id of created) await this.#publishApproval(task.workspaceId, id);
    return true;
  }

  /** Starts a ready step: push and PR on the task's machine, the rest through the deploy target. */
  async #startStep(taskId: string, a: typeof schema.actions.$inferSelect): Promise<void> {
    const [task] = await this.#db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    if (!task) return;
    if (a.kind !== "push" && a.kind !== "open_pr") {
      await this.#ctx.deploys.startStep(task, a);
      return;
    }
    const runnerId = task.runnerId;
    if (!runnerId) return;
    // Marked sent first, so a fast answer finds it in flight.
    const [claimed] = await this.#db
      .update(schema.actions)
      .set({ state: "sent", sentAt: new Date() })
      .where(and(eq(schema.actions.id, a.id), eq(schema.actions.state, "ready")))
      .returning({ id: schema.actions.id });
    if (!claimed) return;
    const sent = this.#send(
      runnerId,
      create(EnvelopeSchema, {
        body: {
          case: "actionRequest",
          value: {
            actionId: a.id,
            taskId,
            kind: ACTION_KIND_TO_PROTO[a.kind],
            prTitle: a.prTitle ?? "",
            prBody: a.prBody ?? "",
          },
        },
      }),
    );
    if (!sent) {
      await this.#db
        .update(schema.actions)
        .set({ state: "ready", sentAt: null })
        .where(and(eq(schema.actions.id, a.id), eq(schema.actions.state, "sent")));
    }
  }

  /**
   * Adds merge, deploy, and verify to a task whose PR is open, as the Deploy
   * button and the assistant's deploy_task do. They start from merge, with
   * approvals as the task's mode says.
   */
  async deployLater(workspaceId: string, taskId: string, userId: string): Promise<void> {
    const added = await this.#db.transaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, workspaceId)))
        .for("update");
      if (!task) throw new DeployLaterError("No such task.", 404);
      const rows = await tx
        .select()
        .from(schema.actions)
        .where(eq(schema.actions.taskId, task.id))
        .orderBy(asc(schema.actions.position));
      const steps = currentSteps(rows);
      const pr = steps.find((a) => a.kind === "open_pr");
      if (pr?.state !== "succeeded") {
        throw new DeployLaterError("Only a task whose pull request is open can deploy.");
      }
      if (steps.some((a) => DEPLOY_STEPS.includes(a.kind) && !isTerminalAction(a.state))) {
        throw new DeployLaterError("This task is already deploying.");
      }
      const key = await this.#remoteKeyOf(tx, task);
      const [target] = key
        ? await tx
            .select({ id: schema.deployTargets.id })
            .from(schema.deployTargets)
            .where(
              and(
                eq(schema.deployTargets.workspaceId, workspaceId),
                eq(schema.deployTargets.remoteKey, key),
              ),
            )
        : [];
      if (!target) {
        throw new DeployLaterError(
          `${task.repoName} has no deploy target, so it can't deploy. Add one on the Deploys page.`,
        );
      }
      const next = (rows.at(-1)?.position ?? -1) + 1;
      await this.#addDeploySteps(tx, task, next);
      await tx.update(schema.tasks).set({ deliver: "deploy" }).where(eq(schema.tasks.id, task.id));
      return task;
    });
    await audit(this.#ctx, {
      workspaceId,
      actorType: "user",
      actorId: userId,
      verb: "task.deploy_requested",
      subjectType: "task",
      subjectId: added.id,
    });
    await this.advance(added.id);
  }

  async #skipRemaining(taskId: string, message: string) {
    await this.#db
      .update(schema.actions)
      .set({ state: "skipped", message, finishedAt: new Date() })
      .where(
        and(
          eq(schema.actions.taskId, taskId),
          inArray(schema.actions.state, ["queued", "awaiting_approval", "ready"]),
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
   * outside the web app, for example a Discord button or a notification.
   */
  async decide(
    workspaceId: string,
    approvalId: string,
    userId: string,
    approve: boolean,
    via?: { via: string; externalUserId?: string },
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
        ...(via ? { via: via.via } : {}),
        ...(via?.externalUserId ? { externalUserId: via.externalUserId } : {}),
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
    const cutoff = new Date(Date.now() - EVENT_RETENTION_MS);
    const deadline = Date.now() + 10_000;
    let deleted = 0;
    do {
      const result = await this.#db.execute(sql`
        with batch as (
          select task_id, seq from task_events
          where at < ${cutoff} order by at limit 1000
          for update skip locked
        ), removed as (
          delete from task_events e using batch b
          where e.task_id = b.task_id and e.seq = b.seq returning 1
        ) select count(*)::int as count from removed
      `);
      const n = Number(result.rows[0]?.count ?? 0);
      deleted += n;
      if (n < 1000) break;
    } while (Date.now() < deadline);
    return deleted;
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
    // Only push and PR need the task's machine or sandbox. A merge, deploy,
    // or verify after them goes on without it.
    const open = await this.#db
      .update(schema.actions)
      .set({ state: "failed", message: error, finishedAt: new Date() })
      .where(
        and(
          eq(schema.actions.taskId, task.id),
          eq(schema.actions.state, "sent"),
          inArray(schema.actions.kind, RUNNER_STEPS),
        ),
      )
      .returning({ id: schema.actions.id });
    const pending = await this.#db
      .select({ id: schema.actions.id })
      .from(schema.actions)
      .where(
        and(
          eq(schema.actions.taskId, task.id),
          inArray(schema.actions.state, ["queued", "awaiting_approval", "ready"]),
          inArray(schema.actions.kind, RUNNER_STEPS),
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
