import type {
  ActionKind,
  ClientEvent,
  CommandApprovalView,
  NotificationSettings,
  PushPayload,
  PushSubscriptionView,
  ServerEvent,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import type { SettleReason } from "../tasks/service.ts";
import {
  encryptPayload,
  fromB64u,
  type VapidKeys,
  VapidSigner,
  validSubscriptionKeys,
  vapidKeys,
  vapidSubject,
} from "./crypto.ts";
import {
  chatApprovalPayload,
  type Delivery,
  deliveryOf,
  encodePayload,
  endpointProblem,
  MAX_FAILURES,
  notificationSettings,
  replyPayload,
  sandboxFallbackPayload,
  taskApprovalPayload,
  taskSettledPayload,
  topicFor,
  workflowApprovalPayload,
} from "./payloads.ts";

export interface NotifyOptions {
  /** Which setting gates it. Without one, the push always goes out. */
  category?: keyof NotificationSettings;
  urgency?: "normal" | "high";
  ttlSeconds?: number;
}

/** How long a push service keeps trying a device that's off, by category. */
const TTL_S = { approvals: 24 * 60 * 60, tasks: 60 * 60, replies: 10 * 60 } as const;
/** A chat approval is gone after 5 minutes, so a later delivery would be noise. */
const CHAT_APPROVAL_TTL_S = 5 * 60;
/** Past this, an approval seen for the first time was made before a restart, and was pushed then. */
const FRESH_APPROVAL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Devices one person can have. Each push goes to all of them. */
export const MAX_DEVICES = 20;

export class PushInputError extends Error {}

type SubscriptionRow = typeof schema.pushSubscriptions.$inferSelect;

function toView(row: SubscriptionRow): PushSubscriptionView {
  let service = "";
  try {
    service = new URL(row.endpoint).hostname;
  } catch {
    // Stored endpoints were checked on the way in.
  }
  return {
    id: row.id,
    label: row.label,
    service,
    createdAt: row.createdAt.toISOString(),
    lastDeliveredAt: row.lastDeliveredAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

/** Ids already pushed, so the many events about one approval push once. */
class Seen {
  readonly #at = new Map<string, number>();

  has(id: string) {
    return this.#at.has(id);
  }

  add(id: string) {
    this.#at.set(id, Date.now());
    if (this.#at.size > 5000) {
      // Approvals last a day at most; anything older can't come back.
      const cutoff = Date.now() - 25 * 60 * 60_000;
      for (const [k, t] of this.#at) if (t < cutoff) this.#at.delete(k);
    }
  }
}

interface SocketPresence {
  userId: string;
  conversationId: string | null;
  visible: boolean;
}

/**
 * Web Push to the devices people turned notifications on for. It listens to
 * the hub's events for approvals and replies, and hears about tasks from the
 * task service's settle hook.
 */
export class PushService {
  readonly #ctx: AppContext;
  readonly #keys: VapidKeys;
  readonly #signer: VapidSigner;
  readonly #sockets = new Map<string, SocketPresence>();
  readonly #seen = new Seen();
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
    this.#keys = vapidKeys(ctx.config.secretKey);
    this.#signer = new VapidSigner(this.#keys, vapidSubject(ctx.config.publicUrl));
    ctx.hub.listen((workspaceId, event) => this.#onEvent(workspaceId, event));
  }

  /** The VAPID public key browsers subscribe with, base64url. */
  get publicKey(): string {
    return this.#keys.publicKeyText;
  }

  // ------------------------------------------------------------ devices

  async list(workspaceId: string, userId: string): Promise<PushSubscriptionView[]> {
    const rows = await this.#ctx.db
      .select()
      .from(schema.pushSubscriptions)
      .where(
        and(
          eq(schema.pushSubscriptions.workspaceId, workspaceId),
          eq(schema.pushSubscriptions.userId, userId),
        ),
      )
      .orderBy(asc(schema.pushSubscriptions.createdAt));
    return rows.map(toView);
  }

  /**
   * Saves a browser's subscription, or refreshes it when the endpoint is
   * known. An endpoint belongs to one browser, so it moves to whoever is
   * signed in there now.
   */
  async subscribe(
    workspaceId: string,
    userId: string,
    input: { endpoint: string; keys: { p256dh: string; auth: string }; label: string },
  ): Promise<PushSubscriptionView> {
    const problem = endpointProblem(input.endpoint, this.#ctx.config.testing?.pushOrigins);
    if (problem) throw new PushInputError(problem);
    const p256dh = fromB64u(input.keys.p256dh);
    const auth = fromB64u(input.keys.auth);
    if (!validSubscriptionKeys(p256dh, auth)) {
      throw new PushInputError("The subscription's keys aren't the ones a browser makes.");
    }
    const t = schema.pushSubscriptions;
    const [{ n } = { n: 0 }] = await this.#ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(t)
      .where(
        and(
          eq(t.workspaceId, workspaceId),
          eq(t.userId, userId),
          sql`${t.endpoint} <> ${input.endpoint}`,
        ),
      );
    if (n >= MAX_DEVICES) {
      throw new PushInputError(`You have ${MAX_DEVICES} devices. Remove one first.`);
    }
    const [row] = await this.#ctx.db
      .insert(t)
      .values({
        id: newId("psh"),
        workspaceId,
        userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        label: input.label,
      })
      .onConflictDoUpdate({
        target: t.endpoint,
        set: {
          workspaceId,
          userId,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          label: input.label,
          failures: 0,
          lastError: null,
        },
      })
      .returning();
    if (!row) throw new Error("subscription not saved");
    await audit(this.#ctx, {
      workspaceId,
      actorType: "user",
      actorId: userId,
      verb: "push.subscribed",
      subjectType: "push_subscription",
      subjectId: row.id,
      details: { label: row.label, service: toView(row).service },
    });
    return toView(row);
  }

  /** Removes one of the user's devices. False when there's no such device. */
  async remove(workspaceId: string, userId: string, id: string): Promise<boolean> {
    const t = schema.pushSubscriptions;
    const [row] = await this.#ctx.db
      .delete(t)
      .where(and(eq(t.id, id), eq(t.workspaceId, workspaceId), eq(t.userId, userId)))
      .returning();
    if (!row) return false;
    await audit(this.#ctx, {
      workspaceId,
      actorType: "user",
      actorId: userId,
      verb: "push.removed",
      subjectType: "push_subscription",
      subjectId: row.id,
      details: { label: row.label, reason: "removed" },
    });
    return true;
  }

  /** Sends a test push to one device. Null when there's no such device. */
  async test(
    workspaceId: string,
    userId: string,
    id: string,
  ): Promise<{ ok: boolean; error: string | null } | null> {
    const t = schema.pushSubscriptions;
    const [row] = await this.#ctx.db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.workspaceId, workspaceId), eq(t.userId, userId)));
    if (!row) return null;
    const json = encodePayload({
      title: "Notifications work",
      body: `Sling can reach ${row.label}.`,
      url: "/settings#notifications",
      tag: `test:${row.id}`,
    });
    const r = await this.#deliver(row, json, {
      urgency: "normal",
      ttlSeconds: 60,
      tag: `test:${row.id}`,
    });
    return { ok: r.delivery === "delivered", error: r.error };
  }

  // ------------------------------------------------------------ sending

  /** Pushes to every device of one user. Resolves to how many devices took it. */
  async notify(
    workspaceId: string,
    userId: string,
    payload: PushPayload,
    opts: NotifyOptions = {},
  ): Promise<number> {
    const m = schema.workspaceMembers;
    const s = schema.pushSubscriptions;
    // One round trip: the member's settings and their devices.
    const rows = await this.#ctx.db
      .select({ notifications: m.notifications, sub: s })
      .from(m)
      .leftJoin(s, and(eq(s.workspaceId, m.workspaceId), eq(s.userId, m.userId)))
      .where(and(eq(m.workspaceId, workspaceId), eq(m.userId, userId)));
    const first = rows[0];
    if (!first) return 0;
    if (opts.category && !notificationSettings(first.notifications)[opts.category]) return 0;
    const subs = rows.flatMap((r) => (r.sub ? [r.sub] : []));
    if (subs.length === 0) return 0;
    const json = encodePayload(payload);
    const results = await Promise.all(
      subs.map((sub) =>
        this.#deliver(sub, json, {
          urgency: opts.urgency ?? "normal",
          ttlSeconds: opts.ttlSeconds ?? 60 * 60,
          tag: payload.tag,
        }),
      ),
    );
    return results.filter((r) => r.delivery === "delivered").length;
  }

  /** Encrypts and sends one push, then records what the push service said. */
  async #deliver(
    sub: SubscriptionRow,
    json: Buffer,
    opts: { urgency: "normal" | "high"; ttlSeconds: number; tag: string },
  ): Promise<{ delivery: Delivery; error: string | null }> {
    let delivery: Delivery;
    let error: string | null = null;
    let status: number | null = null;
    try {
      const body = encryptPayload(json, fromB64u(sub.p256dh), fromB64u(sub.auth));
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          TTL: String(Math.max(0, Math.round(opts.ttlSeconds))),
          Urgency: opts.urgency,
          Topic: topicFor(opts.tag),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          Authorization: this.#signer.authorization(new URL(sub.endpoint).origin),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      delivery = deliveryOf(res.status);
      const text = await res.text().catch(() => "");
      if (delivery !== "delivered") {
        error = `The push service answered ${res.status}${text ? `: ${text.trim().slice(0, 200)}` : "."}`;
      }
    } catch (err) {
      delivery = "failed";
      error =
        err instanceof Error && err.name === "TimeoutError"
          ? "The push service didn't answer in time."
          : `Couldn't reach the push service: ${err instanceof Error ? err.message : String(err)}`;
    }
    const t = schema.pushSubscriptions;
    try {
      if (delivery === "delivered") {
        await this.#ctx.db
          .update(t)
          .set({ lastDeliveredAt: new Date(), failures: 0, lastError: null })
          .where(eq(t.id, sub.id));
      } else if (delivery === "gone" || sub.failures + 1 >= MAX_FAILURES) {
        const [row] = await this.#ctx.db.delete(t).where(eq(t.id, sub.id)).returning({ id: t.id });
        if (row) {
          await audit(this.#ctx, {
            workspaceId: sub.workspaceId,
            actorType: "system",
            verb: "push.removed",
            subjectType: "push_subscription",
            subjectId: sub.id,
            details: {
              label: sub.label,
              reason: delivery === "gone" ? "gone" : "failures",
              status,
            },
          });
        }
      } else {
        await this.#ctx.db
          .update(t)
          .set({ failures: sql`${t.failures} + 1`, lastError: error })
          .where(eq(t.id, sub.id));
      }
    } catch (err) {
      this.#ctx.log.error({ err, subscriptionId: sub.id }, "couldn't record a push delivery");
    }
    return { delivery, error };
  }

  // ------------------------------------------------------------ presence

  /** What a browser socket says it shows. */
  presence(socketId: string, userId: string, event: ClientEvent): void {
    if (event.type !== "presence") return;
    this.#sockets.set(socketId, {
      userId,
      conversationId: event.conversationId,
      visible: event.visible,
    });
  }

  socketClosed(socketId: string): void {
    this.#sockets.delete(socketId);
  }

  /** True when a visible window of this user shows the conversation. */
  showing(userId: string, conversationId: string): boolean {
    for (const s of this.#sockets.values()) {
      if (s.visible && s.userId === userId && s.conversationId === conversationId) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ what notifies

  /** A task reached a settle point. Approvals arrive through the hub instead. */
  taskSettled(taskId: string, reason: SettleReason): void {
    if (reason === "approval_needed") return;
    this.#track(this.#taskSettled(taskId, reason));
  }

  /** Resolves once the pushes started so far have been sent. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  #track(work: Promise<unknown>) {
    const p = work.catch((err) => this.#ctx.log.error({ err }, "push notification failed"));
    this.#inflight.add(p);
    void p.finally(() => this.#inflight.delete(p));
  }

  /** Every hub event passes here, token deltas included, so anything else returns at once. */
  #onEvent(workspaceId: string, ev: ServerEvent) {
    switch (ev.type) {
      case "task.updated": {
        const ids: string[] = [];
        for (const a of ev.task.actions) {
          if (a.state !== "awaiting_approval" || !a.approvalId || this.#seen.has(a.approvalId)) {
            continue;
          }
          this.#seen.add(a.approvalId);
          ids.push(a.approvalId);
        }
        if (ids.length > 0) this.#track(this.#approvals(workspaceId, ids));
        return;
      }
      case "approval.updated":
        if (ev.approval.state !== "pending" || this.#seen.has(ev.approval.id)) return;
        this.#seen.add(ev.approval.id);
        this.#track(this.#approvals(workspaceId, [ev.approval.id]));
        return;
      case "agent.tool": {
        const a = ev.step.approval;
        if (a?.state !== "pending" || this.#seen.has(a.id)) return;
        this.#seen.add(a.id);
        this.#track(this.#chatApproval(workspaceId, ev.conversationId, a));
        return;
      }
      case "message.created":
        if (ev.message.role === "assistant") {
          this.#track(this.#reply(workspaceId, ev.message.conversationId));
        }
        return;
      default:
        return;
    }
  }

  /**
   * Pending approvals, pushed once per task: a task's steps that wait on the
   * same answer, such as merge and deploy, make one notification.
   */
  async #approvals(workspaceId: string, ids: string[]) {
    const a = schema.approvals;
    const taskIds = this.#ctx.db.select({ id: a.taskId }).from(a).where(inArray(a.id, ids));
    const rows = await this.#ctx.db
      .select({
        id: a.id,
        kind: a.kind,
        title: a.title,
        ownerId: a.ownerId,
        createdAt: a.createdAt,
        taskId: a.taskId,
        payload: a.payload,
        actionKind: schema.actions.kind,
        targetName: schema.deployTargets.name,
        taskTitle: schema.tasks.title,
        repoName: schema.tasks.repoName,
      })
      .from(a)
      .leftJoin(schema.actions, eq(schema.actions.id, a.actionId))
      .leftJoin(schema.deployTargets, eq(schema.deployTargets.id, schema.actions.targetId))
      .leftJoin(schema.tasks, eq(schema.tasks.id, a.taskId))
      .where(
        and(
          eq(a.workspaceId, workspaceId),
          eq(a.state, "pending"),
          or(inArray(a.id, ids), and(eq(a.kind, "task_action"), inArray(a.taskId, taskIds))),
        ),
      );
    const fresh = Date.now() - FRESH_APPROVAL_MS;
    const byTask = new Map<string, typeof rows>();
    const sends: Promise<number>[] = [];
    const opts = { category: "approvals", urgency: "high", ttlSeconds: TTL_S.approvals } as const;
    for (const row of rows) {
      this.#seen.add(row.id);
      if (row.createdAt.getTime() < fresh) continue;
      if (row.kind === "task_action" && row.taskId) {
        const list = byTask.get(row.taskId) ?? [];
        list.push(row);
        byTask.set(row.taskId, list);
      } else if (row.kind === "sandbox_fallback" && row.taskId) {
        const p = sandboxFallbackPayload({ taskId: row.taskId, taskTitle: row.taskTitle ?? "" });
        sends.push(this.notify(workspaceId, row.ownerId, p, opts));
      } else if (row.kind === "workflow") {
        const workflowId = row.payload?.workflowId;
        let workflowName: string | null = null;
        if (typeof workflowId === "string") {
          const [wf] = await this.#ctx.db
            .select({ name: schema.workflows.name })
            .from(schema.workflows)
            .where(eq(schema.workflows.id, workflowId));
          workflowName = wf?.name ?? null;
        }
        const p = workflowApprovalPayload({
          approvalId: row.id,
          title: row.title ?? "Approve?",
          workflowName,
        });
        sends.push(this.notify(workspaceId, row.ownerId, p, opts));
      }
    }
    for (const [taskId, list] of byTask) {
      const first = list[0];
      if (!first) continue;
      const p = taskApprovalPayload({
        taskId,
        taskTitle: first.taskTitle ?? "",
        kinds: list.flatMap((r) => (r.actionKind ? [r.actionKind as ActionKind] : [])),
        targetName: list.find((r) => r.targetName)?.targetName ?? null,
        repoName: first.repoName ?? "",
      });
      sends.push(this.notify(workspaceId, first.ownerId, p, opts));
    }
    await Promise.all(sends);
  }

  async #chatApproval(workspaceId: string, conversationId: string, a: CommandApprovalView) {
    const c = schema.conversations;
    const [conv] = await this.#ctx.db
      .select({ ownerId: c.ownerId, title: c.title })
      .from(c)
      .where(and(eq(c.id, conversationId), eq(c.workspaceId, workspaceId)));
    if (!conv) return;
    await this.notify(
      workspaceId,
      conv.ownerId,
      chatApprovalPayload({
        conversationId,
        conversationTitle: conv.title,
        kind: a.kind,
        machine: a.machine,
        summary: a.summary,
      }),
      { category: "approvals", urgency: "high", ttlSeconds: CHAT_APPROVAL_TTL_S },
    );
  }

  async #reply(workspaceId: string, conversationId: string) {
    const c = schema.conversations;
    const [conv] = await this.#ctx.db
      .select({
        ownerId: c.ownerId,
        title: c.title,
        externalKey: c.externalKey,
        personality: schema.personalities.name,
      })
      .from(c)
      .leftJoin(schema.personalities, eq(schema.personalities.id, c.personalityId))
      .where(and(eq(c.id, conversationId), eq(c.workspaceId, workspaceId)));
    // A chat from a channel such as Discord gets its replies there.
    if (!conv || conv.externalKey) return;
    if (this.showing(conv.ownerId, conversationId)) return;
    await this.notify(
      workspaceId,
      conv.ownerId,
      replyPayload({
        conversationId,
        conversationTitle: conv.title,
        personalityName: conv.personality,
      }),
      { category: "replies", urgency: "normal", ttlSeconds: TTL_S.replies },
    );
  }

  async #taskSettled(taskId: string, reason: "finished" | "delivered") {
    const [task] = await this.#ctx.db
      .select({
        workspaceId: schema.tasks.workspaceId,
        ownerId: schema.tasks.ownerId,
        title: schema.tasks.title,
        repoName: schema.tasks.repoName,
        state: schema.tasks.state,
        diffStats: schema.tasks.diffStats,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    if (!task) return;
    const actions =
      reason === "delivered"
        ? await this.#ctx.db
            .select({ kind: schema.actions.kind, state: schema.actions.state })
            .from(schema.actions)
            .where(eq(schema.actions.taskId, taskId))
            .orderBy(asc(schema.actions.position))
        : [];
    const payload = taskSettledPayload({
      id: taskId,
      title: task.title,
      repoName: task.repoName,
      state: task.state,
      filesChanged: task.diffStats?.filesChanged ?? null,
      actions,
      reason,
    });
    if (!payload) return;
    await this.notify(task.workspaceId, task.ownerId, payload, {
      category: "tasks",
      urgency: "normal",
      ttlSeconds: TTL_S.tasks,
    });
  }
}
