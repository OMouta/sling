import { createHmac } from "node:crypto";
import type {
  ActionKind,
  CommandApprovalView,
  NotificationAnswerInput,
  NotificationAnswerResult,
  PushPayload,
} from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { deriveKey, safeEqual } from "../crypto.ts";

/** POST /api/approvals/:id/notification-answer, from the service worker, with no session. */
export const NotificationAnswerSchema = z.object({
  token: z.string().min(1).max(2000),
  answer: z.enum(["allow", "deny"]),
}) satisfies z.ZodType<NotificationAnswerInput>;

/**
 * Task steps a notification can answer. Merges and deploys change what's
 * live, so they open Sling, as do commands, setup changes, and rules.
 */
export const ANSWERABLE_STEPS: readonly ActionKind[] = ["push", "open_pr"];

/** True when every step a task's push asks about can be answered from it. */
export function answerableSteps(kinds: readonly ActionKind[]): boolean {
  return kinds.length > 0 && kinds.every((k) => ANSWERABLE_STEPS.includes(k));
}

/** What a token holds besides the approval it was made for. */
export interface AnswerClaims {
  workspaceId: string;
  userId: string;
  /** When the approval expires, in ms. */
  expiresAt: number;
  /** For a send waiting in a chat, the chat. Task approvals have none. */
  conversationId?: string;
}

/** The token's key, derived from the master secret so there's nothing new to store. */
export function answerKey(masterSecret: string): Buffer {
  return deriveKey(masterSecret, "push-answer-v1");
}

function mac(key: Buffer, approvalId: string, claims: string): string {
  return createHmac("sha256", key).update(`${approvalId}\n${claims}`).digest("base64url");
}

/**
 * A token that answers one approval for one person until it expires: the
 * claims in base64url JSON, then an HMAC over the approval's ID and them.
 */
export function answerToken(key: Buffer, approvalId: string, c: AnswerClaims): string {
  const claims = Buffer.from(
    JSON.stringify({
      w: c.workspaceId,
      u: c.userId,
      e: c.expiresAt,
      ...(c.conversationId ? { c: c.conversationId } : {}),
    }),
  ).toString("base64url");
  return `${claims}.${mac(key, approvalId, claims)}`;
}

/** The token's claims when it was made for this approval with this key, else null. Expiry is the caller's. */
export function readAnswerToken(
  key: Buffer,
  approvalId: string,
  token: string,
): AnswerClaims | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const claims = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), mac(key, approvalId, claims))) return null;
  let j: { w?: unknown; u?: unknown; e?: unknown; c?: unknown };
  try {
    j = JSON.parse(Buffer.from(claims, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof j.w !== "string" || typeof j.u !== "string" || typeof j.e !== "number") return null;
  if (j.c !== undefined && typeof j.c !== "string") return null;
  return {
    workspaceId: j.w,
    userId: j.u,
    expiresAt: j.e,
    ...(typeof j.c === "string" ? { conversationId: j.c } : {}),
  };
}

export type AnswerResult = NotificationAnswerResult | { status: 403 | 409; error: string };

const OPENS_SLING = "This one can only be answered in Sling.";

/**
 * Approvals answered from a notification's Allow and Deny. The push carries
 * a token bound to the approval, the person, and its expiry; the answer goes
 * through the same calls the app makes, so the audit and the conversation's
 * mode apply as they do there. Each token works once.
 */
export class NotificationAnswers {
  readonly #ctx: AppContext;
  readonly #key: Buffer;
  /**
   * How chat sends that ended went, so a late answer can say. They live in
   * memory for 5 minutes, so an hour of them is plenty.
   */
  readonly #ended = new Map<string, { state: CommandApprovalView["state"]; at: number }>();

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
    this.#key = answerKey(ctx.config.secretKey);
    ctx.hub.listen((_workspaceId, ev) => {
      if (ev.type !== "agent.tool") return;
      const a = ev.step.approval;
      if (a?.kind === "send" && a.state !== "pending") this.#end(a.id, a.state);
    });
  }

  /** The answer a task's push carries, for its first push or PR step. */
  forTask(a: {
    id: string;
    workspaceId: string;
    ownerId: string;
    expiresAt: Date;
  }): NonNullable<PushPayload["answer"]> {
    return {
      approvalId: a.id,
      token: answerToken(this.#key, a.id, {
        workspaceId: a.workspaceId,
        userId: a.ownerId,
        expiresAt: a.expiresAt.getTime(),
      }),
    };
  }

  /** The answer a chat's push carries, for a send still waiting. Null for anything else. */
  forChat(approvalId: string, userId: string): NonNullable<PushPayload["answer"]> | null {
    const w = this.#ctx.commands.waiting(approvalId);
    if (w?.kind !== "send") return null;
    return {
      approvalId,
      token: answerToken(this.#key, approvalId, {
        workspaceId: w.workspaceId,
        userId,
        expiresAt: w.expiresAt,
        conversationId: w.conversationId,
      }),
    };
  }

  async answer(approvalId: string, input: NotificationAnswerInput): Promise<AnswerResult> {
    const claims = readAnswerToken(this.#key, approvalId, input.token);
    if (!claims) return { status: 403, error: "That answer isn't valid." };
    if (claims.expiresAt <= Date.now()) return { outcome: "expired" };
    const [member] = await this.#ctx.db
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, claims.workspaceId),
          eq(schema.workspaceMembers.userId, claims.userId),
        ),
      );
    if (!member) return { status: 403, error: "That answer isn't valid." };
    return claims.conversationId
      ? this.#chat(approvalId, { ...claims, conversationId: claims.conversationId }, input.answer)
      : this.#task(approvalId, claims, input.answer);
  }

  /** A send waiting in a chat, answered as the chat's own card answers it. */
  async #chat(
    approvalId: string,
    claims: AnswerClaims & { conversationId: string },
    answer: "allow" | "deny",
  ): Promise<AnswerResult> {
    const w = this.#ctx.commands.waiting(approvalId);
    if (!w) return this.#endedOutcome(approvalId);
    if (
      w.kind !== "send" ||
      w.workspaceId !== claims.workspaceId ||
      w.conversationId !== claims.conversationId
    ) {
      return { status: 409, error: OPENS_SLING };
    }
    if (!(await this.#claim(approvalId, claims, answer))) return { outcome: "already_answered" };
    const result = this.#ctx.commands.decide(
      claims.workspaceId,
      claims.conversationId,
      approvalId,
      answer === "allow" ? "approve" : "deny",
    );
    if (result !== "ok") return this.#endedOutcome(approvalId);
    await audit(this.#ctx, {
      workspaceId: claims.workspaceId,
      actorType: "user",
      actorId: claims.userId,
      verb: answer === "allow" ? "approval.approved" : "approval.rejected",
      subjectType: "conversation",
      subjectId: claims.conversationId,
      details: { approvalId, kind: "send", via: "notification" },
    });
    return { outcome: answer === "allow" ? "allowed" : "denied" };
  }

  /**
   * A task's push and PR steps, answered together as the app's task
   * approval answers them: in order, and a denial stops at the first.
   */
  async #task(
    approvalId: string,
    claims: AnswerClaims,
    answer: "allow" | "deny",
  ): Promise<AnswerResult> {
    const a = schema.approvals;
    const [row] = await this.#ctx.db
      .select({
        kind: a.kind,
        state: a.state,
        ownerId: a.ownerId,
        taskId: a.taskId,
        expiresAt: a.expiresAt,
        actionKind: schema.actions.kind,
      })
      .from(a)
      .leftJoin(schema.actions, eq(schema.actions.id, a.actionId))
      .where(and(eq(a.id, approvalId), eq(a.workspaceId, claims.workspaceId)));
    // The task was deleted, and its approvals with it.
    if (!row) return { outcome: "expired" };
    if (
      row.kind !== "task_action" ||
      !row.taskId ||
      !row.actionKind ||
      !ANSWERABLE_STEPS.includes(row.actionKind) ||
      row.ownerId !== claims.userId
    ) {
      return { status: 409, error: OPENS_SLING };
    }
    if (row.state === "expired" || row.expiresAt.getTime() <= Date.now()) {
      return { outcome: "expired" };
    }
    if (row.state !== "pending") return { outcome: "already_answered" };
    if (!(await this.#claim(approvalId, claims, answer))) return { outcome: "already_answered" };
    const steps = await this.#ctx.db
      .select({ id: a.id })
      .from(a)
      .innerJoin(schema.actions, eq(schema.actions.id, a.actionId))
      .where(
        and(
          eq(a.taskId, row.taskId),
          eq(a.workspaceId, claims.workspaceId),
          eq(a.kind, "task_action"),
          eq(a.state, "pending"),
          inArray(schema.actions.kind, [...ANSWERABLE_STEPS]),
        ),
      )
      .orderBy(asc(schema.actions.position));
    let decided = 0;
    try {
      for (const step of steps) {
        const ok = await this.#ctx.tasks.decide(
          claims.workspaceId,
          step.id,
          claims.userId,
          answer === "allow",
          { via: "notification" },
        );
        if (ok) decided++;
        if (answer === "deny") break;
      }
    } catch (err) {
      // Nothing may have changed, so the token can try again.
      if (decided === 0) await this.#release(approvalId);
      throw err;
    }
    if (decided === 0) return { outcome: "already_answered" };
    return { outcome: answer === "allow" ? "allowed" : "denied" };
  }

  /** Marks the token used. False when it already was. */
  async #claim(approvalId: string, claims: AnswerClaims, answer: "allow" | "deny") {
    const rows = await this.#ctx.db
      .insert(schema.notificationAnswers)
      .values({ approvalId, workspaceId: claims.workspaceId, userId: claims.userId, answer })
      .onConflictDoNothing()
      .returning({ approvalId: schema.notificationAnswers.approvalId });
    return rows.length > 0;
  }

  async #release(approvalId: string) {
    await this.#ctx.db
      .delete(schema.notificationAnswers)
      .where(eq(schema.notificationAnswers.approvalId, approvalId));
  }

  /** A chat send that's no longer waiting: answered, or ended with its turn or its time. */
  #endedOutcome(approvalId: string): NotificationAnswerResult {
    const state = this.#ended.get(approvalId)?.state;
    return { outcome: state === "approved" || state === "denied" ? "already_answered" : "expired" };
  }

  #end(id: string, state: CommandApprovalView["state"]) {
    const now = Date.now();
    this.#ended.set(id, { state, at: now });
    if (this.#ended.size > 2000) {
      for (const [k, v] of this.#ended) if (v.at < now - 60 * 60_000) this.#ended.delete(k);
    }
  }
}
