import type { DeployCheckResult, VerifyDetail } from "@sling/core";
import { schema } from "@sling/db";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { describeResult, probe, runChecks, showsCommit, statusMatches } from "./checks.ts";
import type { DeployService, TargetRow } from "./service.ts";

type ActionRow = typeof schema.actions.$inferSelect;

export const VERIFY_QUEUE = "deploy-verify";
/** Time between rounds of checks. */
export const VERIFY_INTERVAL_MS = 10_000;
/** A verify that's still running this long past its deadline lost its job. */
const LOST_AFTER_MS = 2 * 60_000;

interface VerifyJob {
  actionId: string;
  /** The round this job runs, so a duplicate job can't run one twice. */
  attempt: number;
}

export interface VerifyTiming {
  settleMs: number;
  timeoutMs: number;
  intervalMs: number;
}

/** What one round of checks saw. */
export interface Round {
  checks: DeployCheckResult[];
  /** Null without a version URL. */
  versionSeen: boolean | null;
}

export type Next = { kind: "passed" } | { kind: "failed" } | { kind: "again"; at: number };

export function timingOf(
  target: Pick<TargetRow, "settleSeconds" | "timeoutSeconds">,
  intervalMs = VERIFY_INTERVAL_MS,
): VerifyTiming {
  return {
    settleMs: target.settleSeconds * 1000,
    timeoutMs: target.timeoutSeconds * 1000,
    intervalMs,
  };
}

export function roundPassed(r: Round): boolean {
  return r.checks.every((c) => c.ok) && r.versionSeen !== false;
}

/** When verify gives up: the wait before the first round, then the timeout. */
export function deadlineOf(startedAt: number, t: VerifyTiming): number {
  return startedAt + t.settleMs + t.timeoutMs;
}

/**
 * What follows a round: done when it passed, failed once the deadline has
 * passed, otherwise another round one interval after this one started. The
 * last round runs at the deadline itself.
 */
export function afterRound(opts: {
  passed: boolean;
  roundStartedAt: number;
  now: number;
  startedAt: number;
  timing: VerifyTiming;
}): Next {
  if (opts.passed) return { kind: "passed" };
  const deadline = deadlineOf(opts.startedAt, opts.timing);
  if (opts.now >= deadline) return { kind: "failed" };
  const next = Math.max(opts.roundStartedAt + opts.timing.intervalMs, opts.now);
  return { kind: "again", at: Math.min(next, deadline) };
}

/** One round: every check and the version URL, all at once. */
export async function verifyRound(
  target: Pick<TargetRow, "checks" | "versionUrl">,
  sha: string,
): Promise<Round> {
  const [checks, version] = await Promise.all([
    runChecks(target.checks),
    target.versionUrl ? probe(target.versionUrl, { readBody: true }) : Promise.resolve(null),
  ]);
  const versionSeen =
    version === null
      ? null
      : version.ok && statusMatches(version.status, null) && showsCommit(version.body, sha);
  return { checks, versionSeen };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the verify step says when it ends. */
export function verifyMessage(detail: VerifyDetail, passed: boolean, sha: string): string {
  const ms =
    Date.parse(detail.finishedAt ?? new Date().toISOString()) - Date.parse(detail.startedAt);
  const secs = Math.max(0, Math.round(ms / 1000));
  const tries = plural(detail.attempts, "attempt", "attempts");
  const short = sha.slice(0, 7);
  if (passed) {
    return detail.versionSeen
      ? `The site passed every check after ${tries} (${secs} s), and the version URL shows ${short}.`
      : `The site passed every check after ${tries} (${secs} s). There's no version URL, so Sling can't tell which version answered.`;
  }
  const parts = detail.checks.filter((c) => !c.ok).map(describeResult);
  if (detail.versionSeen === false) parts.push(`the version URL didn't show ${short}`);
  return `Verification failed after ${tries} over ${secs} s: ${parts.join("; ") || "the checks didn't pass"}.`;
}

/**
 * The verify step, as pg-boss jobs: one job per round, each scheduling the
 * next, so a restart picks up where it stopped.
 */
export class Verifier {
  readonly #ctx: AppContext;
  readonly #targets: DeployService;
  #boss: PgBoss | null = null;

  constructor(ctx: AppContext, targets: DeployService) {
    this.#ctx = ctx;
    this.#targets = targets;
  }

  get #db() {
    return this.#ctx.db;
  }

  async start(boss: PgBoss): Promise<void> {
    this.#boss = boss;
    await boss.createQueue(VERIFY_QUEUE, {
      retryLimit: 5,
      retryDelay: 2,
      expireInSeconds: 120,
      deleteAfterSeconds: 24 * 60 * 60,
    });
    // Rounds are scheduled ahead, so polling, not NOTIFY, keeps them on time.
    // A round against a site that hangs waits out its 10-second timeout, which
    // is common when a site is down, so enough run at once that a few down
    // sites don't hold up another deploy's checks.
    await boss.work<VerifyJob>(
      VERIFY_QUEUE,
      { pollingIntervalSeconds: 1, localConcurrency: 8 },
      async (jobs) => {
        for (const job of jobs) await this.#round(job.data);
      },
    );
  }

  async #schedule(job: VerifyJob, at: number) {
    if (!this.#boss) throw new Error("verify jobs aren't running");
    await this.#boss.send(VERIFY_QUEUE, job, { startAfter: new Date(at) });
  }

  /** Starts verifying a step that was just marked sent. */
  async begin(action: ActionRow, target: TargetRow, _sha: string): Promise<void> {
    const startedAt = Date.now();
    const detail: VerifyDetail = {
      attempts: 0,
      checks: [],
      versionSeen: null,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: null,
    };
    await this.#db.update(schema.actions).set({ detail }).where(eq(schema.actions.id, action.id));
    await this.#schedule(
      { actionId: action.id, attempt: 0 },
      startedAt + timingOf(target).settleMs,
    );
  }

  async #round(job: VerifyJob): Promise<void> {
    const [action] = await this.#db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.id, job.actionId));
    if (action?.kind !== "verify" || action.state !== "sent" || !action.detail) return;
    if (action.detail.attempts !== job.attempt) return;
    const [target] = action.targetId
      ? await this.#db
          .select()
          .from(schema.deployTargets)
          .where(eq(schema.deployTargets.id, action.targetId))
      : [];
    const sha = action.commitSha ?? "";
    if (!target) {
      await this.#finish(action, false, action.detail, "The deploy target was removed.");
      return;
    }
    const timing = timingOf(target);
    const startedAt = Date.parse(action.detail.startedAt);
    const first = startedAt + timing.settleMs;
    if (Date.now() < first - 50) {
      await this.#schedule(job, first);
      return;
    }
    const roundStartedAt = Date.now();
    const round = await verifyRound(target, sha);
    const now = Date.now();
    const next = afterRound({
      passed: roundPassed(round),
      roundStartedAt,
      now,
      startedAt,
      timing,
    });
    const detail: VerifyDetail = {
      ...action.detail,
      attempts: action.detail.attempts + 1,
      checks: round.checks,
      versionSeen: round.versionSeen,
      finishedAt: next.kind === "again" ? null : new Date(now).toISOString(),
    };
    if (next.kind !== "again") {
      const passed = next.kind === "passed";
      await this.#finish(action, passed, detail, verifyMessage(detail, passed, sha));
      return;
    }
    const [saved] = await this.#db
      .update(schema.actions)
      .set({ detail })
      .where(
        and(
          eq(schema.actions.id, action.id),
          eq(schema.actions.state, "sent"),
          sql`(${schema.actions.detail}->>'attempts')::int = ${job.attempt}`,
        ),
      )
      .returning({ id: schema.actions.id });
    if (!saved) return;
    await this.#schedule({ actionId: action.id, attempt: detail.attempts }, next.at);
    await this.#ctx.tasks.publish(action.taskId);
  }

  async #finish(action: ActionRow, passed: boolean, detail: VerifyDetail, message: string) {
    const [done] = await this.#db
      .update(schema.actions)
      .set({
        state: passed ? "succeeded" : "failed",
        message,
        detail: { ...detail, finishedAt: detail.finishedAt ?? new Date().toISOString() },
        finishedAt: new Date(),
      })
      .where(and(eq(schema.actions.id, action.id), eq(schema.actions.state, "sent")))
      .returning();
    if (!done) return;
    await audit(this.#ctx, {
      workspaceId: done.workspaceId,
      actorType: "system",
      verb: `action.verify.${passed ? "succeeded" : "failed"}`,
      subjectType: "action",
      subjectId: done.id,
      details: {
        taskId: done.taskId,
        targetId: done.targetId,
        commitSha: done.commitSha,
        attempts: detail.attempts,
        versionSeen: detail.versionSeen,
        message,
      },
    });
    await this.#targets.publish(done.targetId);
    await this.#ctx.tasks.advance(done.taskId);
  }

  /** Ends a verify whose jobs went missing, with what it last saw. */
  async sweep(): Promise<void> {
    const running = await this.#db
      .select({ action: schema.actions, target: schema.deployTargets })
      .from(schema.actions)
      .leftJoin(schema.deployTargets, eq(schema.deployTargets.id, schema.actions.targetId))
      .where(and(eq(schema.actions.kind, "verify"), eq(schema.actions.state, "sent")));
    const now = Date.now();
    for (const { action, target } of running) {
      if (!action.detail) continue;
      const deadline = target
        ? deadlineOf(Date.parse(action.detail.startedAt), timingOf(target))
        : Date.parse(action.detail.startedAt);
      if (now < deadline + LOST_AFTER_MS) continue;
      const detail = { ...action.detail, finishedAt: new Date(now).toISOString() };
      await this.#finish(
        action,
        false,
        detail,
        `Verification stopped without finishing. ${verifyMessage(detail, false, action.commitSha ?? "")}`,
      );
    }
  }
}
