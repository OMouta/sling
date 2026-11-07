import { CHANNEL_KINDS, type ChannelKind, newId } from "@sling/core";
import { schema } from "@sling/db";
import {
  type ChannelMessage,
  type ChannelSendResult,
  create,
  EnvelopeSchema,
} from "@sling/runner-protocol";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import type { RunnerSession } from "../runners/gateway.ts";

/** How long a send waits for its machine to come online before it fails. */
export const CHANNEL_SEND_WAIT_MS = 5 * 60_000;
/** How long a machine has to answer a send it was given. */
const SEND_ANSWER_MS = 45_000;
/** Longest message text taken from a machine, or sent to one. */
export const MAX_CHANNEL_TEXT = 20_000;

export interface ChannelSendAnswer {
  ok: boolean;
  /** Why it failed, naming the machine when it was offline. Empty when it worked. */
  message: string;
  /** The machine's name, when it's known. */
  machine?: string;
}

export interface ChannelService {
  /**
   * A message a machine forwarded from one of its channels. Answers with
   * ChannelMessageAck once it's stored, and not before, so the machine sends
   * it again after a reconnect if the server never got it.
   */
  message(session: RunnerSession, message: ChannelMessage): Promise<void>;
  /** A machine's answer to a ChannelSend. */
  sendResult(session: RunnerSession, result: ChannelSendResult): void;
  /** A machine connected, so sends waiting for it can go. */
  runnerConnected(session: RunnerSession): void;
  /** Sends on a machine's channel, waiting up to CHANNEL_SEND_WAIT_MS for it to come online. */
  send(
    workspaceId: string,
    opts: {
      runnerId: string;
      channel: string;
      conversation: string;
      text: string;
      signal?: AbortSignal;
    },
  ): Promise<ChannelSendAnswer>;
}

/** What a `*.message_received` trigger hands to the workflow: the `channel.message` type. */
export interface ChannelMessageView {
  id: string;
  /** Where a reply goes: the sender for a one-to-one chat, or the group's ID. */
  conversation: string;
  sender: string;
  text: string;
  isGroup: boolean;
  sentAt: string;
}

/** What an installation of a channel connector names: one machine's channel. */
export interface ChannelInstallationConfig {
  runnerId: string;
  channel: string;
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/**
 * Messaging channels that run on the user's machines, such as iMessage and
 * Signal. A message a machine forwards starts the workflows listening on
 * installations that name that machine and channel. A send goes to the
 * machine, waiting for it to come online.
 */
export class Channels implements ChannelService {
  readonly #ctx: AppContext;
  /** Sends handed to a machine, waiting for its ChannelSendResult. */
  readonly #answers = new Map<
    string,
    { runnerId: string; resolve: (a: { ok: boolean; message: string }) => void }
  >();
  /** Sends waiting for a machine to connect, by runner ID. */
  readonly #waiting = new Map<string, Set<() => void>>();
  /** How long a send waits for an offline machine. Tests shorten it. */
  sendWaitMs = CHANNEL_SEND_WAIT_MS;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async message(session: RunnerSession, m: ChannelMessage): Promise<void> {
    const ctx = this.#ctx;
    if (m.channel && m.messageId) {
      const installs = await ctx.db
        .select({
          id: schema.connectorInstallations.id,
          kind: schema.connectorInstallations.connectorId,
        })
        .from(schema.connectorInstallations)
        .where(
          and(
            eq(schema.connectorInstallations.workspaceId, session.workspaceId),
            inArray(schema.connectorInstallations.connectorId, [...CHANNEL_KINDS]),
            eq(schema.connectorInstallations.enabled, true),
            sql`${schema.connectorInstallations.config}->>'runnerId' = ${session.runnerId}`,
            sql`${schema.connectorInstallations.config}->>'channel' = ${m.channel}`,
          ),
        );
      const sender = cut(m.sender, 320);
      const conversation = cut(m.conversation, 320);
      const at = Number(m.atMs);
      const payload: ChannelMessageView = {
        id: cut(m.messageId, 200),
        conversation,
        sender,
        text: cut(m.text, MAX_CHANNEL_TEXT),
        isGroup: conversation !== sender,
        sentAt: new Date(Number.isFinite(at) && at > 0 ? at : Date.now()).toISOString(),
      };
      for (const inst of installs) {
        await ctx.events.emit({
          type: `${inst.kind as ChannelKind}.message_received`,
          workspaceId: session.workspaceId,
          installationId: inst.id,
          payload,
          // The machine sends again whatever it isn't sure arrived.
          dedupeKey: `${inst.id}:${payload.id}`,
        });
      }
    }
    // Only now: the runs are stored, so the machine's place can move on.
    session.send(
      create(EnvelopeSchema, {
        body: {
          case: "channelMessageAck",
          value: { channel: m.channel, messageId: m.messageId },
        },
      }),
    );
  }

  sendResult(session: RunnerSession, result: ChannelSendResult): void {
    const pending = this.#answers.get(result.requestId);
    if (pending?.runnerId !== session.runnerId) return;
    pending.resolve({ ok: result.ok, message: cut(result.message, 500) });
  }

  runnerConnected(session: RunnerSession): void {
    const wake = this.#waiting.get(session.runnerId);
    if (!wake) return;
    this.#waiting.delete(session.runnerId);
    for (const w of wake) w();
  }

  async send(
    workspaceId: string,
    opts: {
      runnerId: string;
      channel: string;
      conversation: string;
      text: string;
      signal?: AbortSignal;
    },
  ): Promise<ChannelSendAnswer> {
    const ctx = this.#ctx;
    const [runner] = await ctx.db
      .select({ name: schema.runners.name })
      .from(schema.runners)
      .where(
        and(
          eq(schema.runners.id, opts.runnerId),
          eq(schema.runners.workspaceId, workspaceId),
          isNull(schema.runners.revokedAt),
        ),
      );
    if (!runner) {
      return {
        ok: false,
        message: "The machine this account uses isn't paired with Sling any more.",
      };
    }
    const machine = runner.name;
    const deadline = Date.now() + this.sendWaitMs;
    for (;;) {
      if (opts.signal?.aborted) {
        return {
          ok: false,
          message: `${machine} is offline, so the message wasn't sent.`,
          machine,
        };
      }
      if (ctx.runners.isOnline(opts.runnerId)) {
        const sent = await this.#handOver(opts, machine);
        if (sent) return { ...sent, machine };
      }
      const left = deadline - Date.now();
      if (left <= 0 || !(await this.#online(opts.runnerId, left, opts.signal))) {
        const waited = Math.round(this.sendWaitMs / 60_000);
        return {
          ok: false,
          message:
            opts.signal?.aborted || waited < 1
              ? `${machine} is offline, so the message wasn't sent.`
              : `${machine} is offline, so the message wasn't sent. Sling waited ${waited} minutes for it.`,
          machine,
        };
      }
    }
  }

  /**
   * Gives the send to the machine and waits for its answer. Null when it
   * went offline before it could be handed over, so the caller waits again.
   */
  #handOver(
    opts: {
      runnerId: string;
      channel: string;
      conversation: string;
      text: string;
      signal?: AbortSignal;
    },
    machine: string,
  ): Promise<{ ok: boolean; message: string } | null> {
    const requestId = newId("rqs");
    return new Promise((resolve) => {
      const done = (a: { ok: boolean; message: string } | null) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.#answers.delete(requestId);
        resolve(a);
      };
      const timer = setTimeout(
        () =>
          done({
            ok: false,
            message: `${machine} didn't answer, so the message may not have gone.`,
          }),
        SEND_ANSWER_MS,
      );
      const onAbort = () =>
        done({ ok: false, message: `Stopped before ${machine} said whether it sent the message.` });
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.#answers.set(requestId, { runnerId: opts.runnerId, resolve: done });
      const sent = this.#ctx.runners.send(
        opts.runnerId,
        create(EnvelopeSchema, {
          body: {
            case: "channelSend",
            value: {
              requestId,
              channel: opts.channel,
              conversation: opts.conversation,
              text: cut(opts.text, MAX_CHANNEL_TEXT),
            },
          },
        }),
      );
      if (!sent) done(null);
    });
  }

  /** Resolves true when the machine connects within `ms`, false otherwise. */
  #online(runnerId: string, ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const set = this.#waiting.get(runnerId) ?? new Set<() => void>();
      this.#waiting.set(runnerId, set);
      const finish = (online: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        set.delete(wake);
        if (set.size === 0 && this.#waiting.get(runnerId) === set) this.#waiting.delete(runnerId);
        resolve(online);
      };
      const wake = () => finish(true);
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), ms);
      signal?.addEventListener("abort", onAbort, { once: true });
      set.add(wake);
      // It may have connected between the check and now.
      if (this.#ctx.runners.isOnline(runnerId)) finish(true);
    });
  }
}
