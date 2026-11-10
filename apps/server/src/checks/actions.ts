/**
 * Checks of actions outside Sling: a node's `verify` after the assistant ran
 * it from chat, and a delivered PR's CI. The first check runs at once, then
 * pg-boss jobs keep checking while it says `waiting`, up to its limit. What
 * it says lands on the chat's step, or on the task's step, and a failure
 * tells the conversation and pushes.
 */
import {
  ACTION_CHECK_STATES,
  type ActionCheckState,
  type ActionCheckView,
  newId,
  type ReplyTrace,
  type ServerEvent,
} from "@sling/core";
import { schema } from "@sling/db";
import { SLING_EVENTS, type VerifyResult } from "@sling/workflow";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { ToolScope } from "../agent/tools.ts";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { githubPull } from "../deploys/steps.ts";
import { conversationKey, conversationObject } from "../workflows/sling-events.ts";
import type { AnyServerNodeSpec } from "../workflows/types.ts";
import { toActionCheckView } from "./action-views.ts";
import { CI_LIMIT_SECONDS, ciStatus, prLabel } from "./ci.ts";
import { nodeContext, scrub } from "./node-context.ts";
import type { ActionCheckStart } from "./service.ts";

type Row = typeof schema.actionChecks.$inferSelect;

export const ACTION_QUEUE = "action-check";
/** How long a node's `verify` may say `waiting` when it doesn't set its own limit. */
export const DEFAULT_VERIFY_SECONDS = 10 * 60;
/** Time between checks of something still waiting, unless it asks for another. */
export const DEFAULT_RETRY_SECONDS = 30;
const MIN_RETRY_SECONDS = 5;
/** How long one call to `verify` may take. */
const VERIFY_TIMEOUT_MS = 30_000;
/** A check that ended before its reply was saved tries to land on it this often. */
const LAND_RETRY_SECONDS = 5;
const LAND_TRIES = 120;
/** The kind an action check of a PR's CI is stored as. */
export const CI_KIND = "ci";

interface Job {
  id: string;
  /** The attempt this job runs, so a duplicate can't run one twice. */
  attempt: number;
  /** Only put what's stored on the reply, which wasn't saved yet. */
  land?: number;
}

function valid(r: unknown): VerifyResult | null {
  if (!r || typeof r !== "object") return null;
  const v = r as Record<string, unknown>;
  if (!ACTION_CHECK_STATES.includes(v.state as ActionCheckState)) return null;
  return {
    state: v.state as ActionCheckState,
    message: typeof v.message === "string" ? v.message : "",
    ...(typeof v.retryAfterSeconds === "number" && Number.isFinite(v.retryAfterSeconds)
      ? { retryAfterSeconds: v.retryAfterSeconds }
      : {}),
  };
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

/**
 * After a node the assistant called from chat returns: checks it at once
 * when its node can, shows that on the step, and gives it back for the
 * tool's result. Later checks reach the step after the reply is saved.
 */
export async function checkToolCall(
  ctx: AppContext,
  scope: ToolScope,
  toolCallId: string,
  call: {
    spec: AnyServerNodeSpec;
    installationId: string;
    config: Record<string, unknown>;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    summary: string;
  },
): Promise<{ state: ActionCheckState; message: string } | null> {
  if (!call.spec.verify) return null;
  let check: ActionCheckView | null = null;
  try {
    check = await ctx.checks.checkAction({
      kind: "tool_call",
      workspaceId: scope.workspaceId,
      ownerId: scope.ownerId,
      conversationId: scope.conversationId,
      toolCallId,
      nodeType: call.spec.type,
      nodeVersion: call.spec.version,
      installationId: call.installationId,
      config: call.config,
      inputs: call.inputs,
      outputs: call.outputs,
      summary: call.summary,
    });
  } catch (err) {
    ctx.log.error({ err, toolCallId }, "couldn't check an action");
  }
  if (!check) return null;
  scope.trace?.toolUpdate(toolCallId, { check });
  return { state: check.state, message: check.message };
}

export class ActionChecks {
  readonly #ctx: AppContext;
  #boss: PgBoss | null = null;
  readonly #inflight = new Set<Promise<unknown>>();
  /** PR steps already handed a check, so the many updates about a task start one. */
  readonly #seen = new Set<string>();

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  get #db() {
    return this.#ctx.db;
  }

  async start(boss: PgBoss): Promise<void> {
    this.#boss = boss;
    await boss.createQueue(ACTION_QUEUE, {
      retryLimit: 3,
      retryDelay: 5,
      expireInSeconds: 120,
      deleteAfterSeconds: 24 * 60 * 60,
    });
    await boss.work<Job>(
      ACTION_QUEUE,
      { pollingIntervalSeconds: 1, localConcurrency: 4 },
      async (jobs) => {
        for (const job of jobs) await this.#job(job.data);
      },
    );
    this.#ctx.hub.listen((workspaceId, ev) => this.#onEvent(workspaceId, ev));
    await this.#resume();
  }

  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  #track(label: string, work: () => Promise<unknown>) {
    const p = work()
      .catch((err) => this.#ctx.log.error({ err }, `${label} failed`))
      .finally(() => this.#inflight.delete(p));
    this.#inflight.add(p);
  }

  /** A delivered PR on GitHub gets its CI checked once the step says it's open. */
  #onEvent(workspaceId: string, ev: ServerEvent) {
    if (ev.type !== "task.updated") return;
    for (const a of ev.task.actions) {
      if (a.kind !== "open_pr" || a.state !== "succeeded" || a.check || !githubPull(a.url)) {
        continue;
      }
      if (this.#seen.has(a.id)) continue;
      this.#seen.add(a.id);
      if (this.#seen.size > 5000) this.#seen.clear();
      this.#track("PR CI check", () =>
        this.begin({
          kind: "task_action",
          workspaceId,
          ownerId: "",
          actionId: a.id,
        }),
      );
    }
  }

  /** Checks still waiting whose jobs were lost, such as in a crash, get one again. */
  async #resume() {
    const waiting = await this.#db
      .select({ id: schema.actionChecks.id, attempts: schema.actionChecks.attempts })
      .from(schema.actionChecks)
      .where(
        and(
          eq(schema.actionChecks.state, "waiting"),
          sql`${schema.actionChecks.nextRunAt} < now() - interval '2 minutes'`,
        ),
      );
    for (const w of waiting) await this.#schedule({ id: w.id, attempt: w.attempts }, new Date());
  }

  async #schedule(job: Job, at: Date) {
    if (!this.#boss) return;
    await this.#boss.send(ACTION_QUEUE, job, { startAfter: at });
  }

  // ------------------------------------------------------------- starting

  async begin(start: ActionCheckStart): Promise<ActionCheckView | null> {
    const now = new Date();
    let values: typeof schema.actionChecks.$inferInsert;
    if (start.kind === "tool_call") {
      const spec = this.#ctx.registry.get(start.nodeType, start.nodeVersion);
      if (!spec?.verify) return null;
      const limit = spec.verifyForSeconds ?? DEFAULT_VERIFY_SECONDS;
      values = {
        id: newId("ack"),
        workspaceId: start.workspaceId,
        ownerId: start.ownerId,
        conversationId: start.conversationId,
        toolCallId: start.toolCallId,
        kind: start.nodeType,
        nodeVersion: start.nodeVersion,
        installationId: start.installationId,
        payload: {
          config: start.config,
          inputs: start.inputs,
          outputs: start.outputs,
          summary: start.summary ?? "",
        },
        giveUpAt: new Date(now.getTime() + limit * 1000),
        nextRunAt: now,
      };
    } else {
      const [action] = await this.#db
        .select()
        .from(schema.actions)
        .where(eq(schema.actions.id, start.actionId));
      if (action?.kind !== "open_pr" || action.state !== "succeeded" || !githubPull(action.url)) {
        return null;
      }
      values = {
        id: newId("ack"),
        workspaceId: action.workspaceId,
        ownerId: action.ownerId,
        actionId: action.id,
        kind: CI_KIND,
        payload: { url: action.url, startedAt: now.toISOString() },
        giveUpAt: new Date(now.getTime() + CI_LIMIT_SECONDS * 1000),
        nextRunAt: now,
      };
    }
    const [row] = await this.#db
      .insert(schema.actionChecks)
      .values(values)
      .onConflictDoNothing()
      .returning();
    if (!row) {
      // Checked already, by an earlier call with the same step.
      const [existing] = await this.#db
        .select()
        .from(schema.actionChecks)
        .where(
          start.kind === "tool_call"
            ? and(
                eq(schema.actionChecks.conversationId, start.conversationId),
                eq(schema.actionChecks.toolCallId, start.toolCallId),
              )
            : eq(schema.actionChecks.actionId, start.actionId),
        );
      return existing ? toActionCheckView(existing) : null;
    }
    const after = await this.#attempt(row, { first: true });
    return toActionCheckView(after);
  }

  // ------------------------------------------------------------- checking

  async #job(job: Job) {
    const [row] = await this.#db
      .select()
      .from(schema.actionChecks)
      .where(eq(schema.actionChecks.id, job.id));
    if (!row) return;
    if (job.land !== undefined) {
      if (!(await this.#land(row)) && job.land < LAND_TRIES) {
        await this.#schedule(
          { ...job, land: job.land + 1 },
          new Date(Date.now() + LAND_RETRY_SECONDS * 1000),
        );
      }
      return;
    }
    if (row.state !== "waiting" || row.attempts !== job.attempt) return;
    await this.#attempt(row, { first: false });
  }

  /** What checks the action says now. */
  async #ask(row: Row): Promise<VerifyResult> {
    if (row.kind === CI_KIND) return ciStatus(this.#ctx, row);
    const spec = this.#ctx.registry.get(row.kind, row.nodeVersion ?? 0);
    if (!spec?.verify) {
      return { state: "unchecked", message: "Sling can't check this kind of action any more." };
    }
    const payload = row.payload as {
      config?: Record<string, unknown>;
      inputs?: Record<string, unknown>;
      outputs?: Record<string, unknown>;
    };
    const { context, secrets } = nodeContext(this.#ctx, spec, {
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
      installationId: row.installationId,
      key: `chat:${row.toolCallId}`,
      attempt: row.attempts + 1,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    try {
      const r = valid(
        await spec.verify(context, {
          config: payload.config ?? {},
          inputs: payload.inputs ?? {},
          outputs: payload.outputs ?? {},
        }),
      );
      if (!r) return { state: "unchecked", message: "The check gave an answer Sling can't read." };
      return { ...r, message: scrub(r.message, secrets) };
    } catch (err) {
      const message = scrub(err instanceof Error ? err.message : String(err), secrets);
      // Couldn't look, this time: try again while there's time.
      return { state: "waiting", message: `Couldn't check yet: ${message}` };
    }
  }

  async #attempt(row: Row, opts: { first: boolean }): Promise<Row> {
    const r = await this.#ask(row);
    const now = new Date();
    const giveUp = row.giveUpAt ?? now;
    let state = r.state;
    let message = oneLine(r.message) || (state === "passed" ? "Checked" : "");
    let next: Date | null = null;
    if (state === "waiting") {
      if (now.getTime() >= giveUp.getTime()) {
        state = "unchecked";
        message = `${message ? `${message.replace(/\.$/, "")}. ` : ""}Sling stopped checking after ${Math.round((giveUp.getTime() - row.createdAt.getTime()) / 60_000)} min.`;
      } else {
        const wait = Math.max(MIN_RETRY_SECONDS, r.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS);
        // The last look is at the limit itself, so a check that waits out its time gets to say so.
        next = new Date(Math.min(now.getTime() + wait * 1000, giveUp.getTime()));
      }
    }
    const [saved] = await this.#db
      .update(schema.actionChecks)
      .set({
        state,
        message,
        attempts: row.attempts + 1,
        checkedAt: now,
        nextRunAt: next,
      })
      .where(
        and(eq(schema.actionChecks.id, row.id), eq(schema.actionChecks.attempts, row.attempts)),
      )
      .returning();
    if (!saved) return row;
    if (next) await this.#schedule({ id: saved.id, attempt: saved.attempts }, next);
    const changed = saved.state !== row.state || saved.message !== row.message || opts.first;
    if (changed && !(opts.first && saved.toolCallId)) {
      // The first check of a chat step goes back with the tool's result instead.
      if (saved.actionId) await this.#publishTask(saved.actionId, saved.kind === CI_KIND);
      else if (!(await this.#land(saved))) {
        await this.#schedule(
          { id: saved.id, attempt: saved.attempts, land: 0 },
          new Date(Date.now() + LAND_RETRY_SECONDS * 1000),
        );
      }
    }
    if (saved.state === "failed" && row.state !== "failed") {
      // A chat's first check goes back with the tool's result, so the reply says it already.
      await this.#failed(saved, { inTurn: opts.first && Boolean(saved.toolCallId) });
    }
    return saved;
  }

  /** Shows the task. A PR's CI also moves it on, since a merge may wait for it. */
  async #publishTask(actionId: string, advance: boolean) {
    const [a] = await this.#db
      .select({ taskId: schema.actions.taskId })
      .from(schema.actions)
      .where(eq(schema.actions.id, actionId));
    if (!a) return;
    if (advance) await this.#ctx.tasks.advance(a.taskId);
    else await this.#ctx.tasks.publish(a.taskId);
  }

  /**
   * Puts what the check says on the chat step it belongs to, once its reply
   * is saved, and tells open chats. False while the reply isn't saved yet.
   */
  async #land(row: Row): Promise<boolean> {
    if (!row.conversationId || !row.toolCallId) return true;
    const check = toActionCheckView(row);
    const callId = row.toolCallId;
    const landed = await this.#db.transaction(async (tx) => {
      const [msg] = await tx
        .select({ id: schema.messages.id, trace: schema.messages.trace })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.conversationId, row.conversationId as string),
            sql`${schema.messages.trace} @> ${JSON.stringify({ steps: [{ id: callId }] })}::jsonb`,
          ),
        )
        .limit(1)
        .for("update");
      if (!msg?.trace) return null;
      const trace: ReplyTrace = {
        ...msg.trace,
        steps: msg.trace.steps.map((s) =>
          s.kind === "tool" && s.id === callId ? { ...s, check } : s,
        ),
      };
      await tx.update(schema.messages).set({ trace }).where(eq(schema.messages.id, msg.id));
      await tx
        .update(schema.actionChecks)
        .set({ messageId: msg.id })
        .where(eq(schema.actionChecks.id, row.id));
      return msg.id;
    });
    if (!landed) return false;
    this.#ctx.hub.publish(row.workspaceId, {
      type: "tool_step.check",
      conversationId: row.conversationId,
      messageId: landed,
      stepId: callId,
      check,
    });
    return true;
  }

  // ------------------------------------------------------------- failures

  /** Tells the conversation, which tells the user, and pushes. */
  async #failed(row: Row, opts: { inTurn: boolean }) {
    const ctx = this.#ctx;
    let conversationId = row.conversationId;
    let what = String((row.payload as { summary?: unknown }).summary ?? "") || row.kind;
    let open = conversationId ? `/c/${conversationId}` : "/";
    let taskId: string | null = null;
    if (row.actionId) {
      const [a] = await this.#db
        .select({
          taskId: schema.actions.taskId,
          url: schema.actions.url,
          title: schema.tasks.title,
          conversationId: schema.tasks.conversationId,
        })
        .from(schema.actions)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.actions.taskId))
        .where(eq(schema.actions.id, row.actionId));
      if (!a) return;
      taskId = a.taskId;
      conversationId = a.conversationId;
      what = `${prLabel(a.url) ?? "The PR"} for "${a.title}"`;
      open = `/tasks/${a.taskId}`;
    }
    await audit(ctx, {
      workspaceId: row.workspaceId,
      actorType: "system",
      verb: "check.action_failed",
      subjectType: row.actionId ? "action" : "conversation",
      subjectId: row.actionId ?? row.conversationId ?? row.id,
      details: { kind: row.kind, message: row.message },
    });
    const watching = conversationId ? ctx.push.showing(row.ownerId, conversationId) : false;
    if (!watching) {
      await ctx.push.notify(
        row.workspaceId,
        row.ownerId,
        {
          title: `Check failed: ${what}`.slice(0, 120),
          body: row.message,
          url: open,
          tag: conversationId ? `conv:${conversationId}` : `check:${row.id}`,
        },
        { urgency: "high", ttlSeconds: 60 * 60 },
      );
    }
    if (!conversationId || opts.inTurn) return;
    const [conv] = await this.#db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId));
    if (!conv) return;
    const note = row.actionId
      ? `${what}: ${row.message} Tell the user, and offer to fix it with a new task if they want.`
      : `Sling checked "${what}" afterwards, and the check failed: ${row.message} Tell the user what happened and what they can do.`;
    const saved = await ctx.agent.addMessage(
      conv,
      "system",
      { role: "system", content: note },
      taskId,
    );
    const workflowId = conv.workflowId ?? (await ctx.workflows.assistantId(conv.workspaceId));
    if (!workflowId) return;
    await ctx.events.emit({
      type: SLING_EVENTS.conversationUpdate,
      workspaceId: conv.workspaceId,
      workflowId,
      payload: {
        conversation: conversationObject(conv),
        key: conversationKey(conv),
        note,
        taskId,
        reason: "check_failed",
      },
      ...(saved ? { dedupeKey: `note:${saved.id}` } : {}),
    });
  }
}
