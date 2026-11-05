/**
 * The Discord event source: keeps a gateway connection open, turns messages
 * from allowed users into trigger events, and handles approval button clicks.
 */
import type {
  ApprovalDecision,
  EventSource,
  EventSourceFactory,
  SourceContext,
} from "@sling/connector-sdk";
import { approvalButtons, decidedText, parseApprovalCustomId } from "./approval.ts";
import { type Backoff, backoffDelay, DEFAULT_BACKOFF, errorMessage, sleep } from "./backoff.ts";
import type { ButtonClick, GatewayFactory, GatewayMessage } from "./gateway.ts";
import {
  type DiscordConfig,
  type DiscordCredentials,
  type DiscordMessage,
  MESSAGE_EVENT,
} from "./schemas.ts";

type Ctx = SourceContext<DiscordCredentials, DiscordConfig>;

export interface DiscordSourceOptions {
  gateway: GatewayFactory;
  backoff?: Backoff;
}

export const REFUSED_REPLY = "You can't approve this.";

export function createDiscordSource(
  options: DiscordSourceOptions,
): EventSourceFactory<DiscordCredentials, DiscordConfig> {
  return {
    async start(ctx): Promise<EventSource> {
      const controller = new AbortController();
      const signal = AbortSignal.any([ctx.signal, controller.signal]);
      const running = supervise(ctx, options, signal).catch((error: unknown) => {
        ctx.log.error("Discord source stopped unexpectedly", { error: errorMessage(error) });
        ctx.setStatus("error", errorMessage(error));
      });
      return {
        async stop() {
          controller.abort();
          await running;
        },
      };
    },
  };
}

/** Connects, waits until the connection is lost for good, then reconnects with backoff. */
async function supervise(ctx: Ctx, options: DiscordSourceOptions, signal: AbortSignal) {
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  let failures = 0;
  while (!signal.aborted) {
    ctx.setStatus("connecting");
    const session = new Session(ctx);
    let markClosed: (reason: string) => void = () => {};
    const closed = new Promise<string>((resolve) => {
      markClosed = resolve;
    });
    const gateway = options.gateway({
      message: (m) => session.onMessage(m),
      button: (click) => void session.onButton(click),
      status: (state) => {
        if (state === "connected") ctx.setStatus("connected");
        else ctx.setStatus("connecting", "Reconnecting to Discord");
      },
      closed: (reason) => markClosed(reason),
      error: (error) => ctx.log.warn("Discord gateway error", { error: error.message }),
    });

    try {
      const me = await gateway.login(ctx.credentials.botToken, signal);
      session.setBot(me.botUserId);
      failures = 0;
      ctx.setStatus("connected", `Logged in as ${me.username}`);
      let onAbort = () => {};
      const aborted = new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        if (signal.aborted) onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const reason = await Promise.race([closed, aborted]);
      signal.removeEventListener("abort", onAbort);
      if (reason !== null) {
        ctx.log.warn("Discord connection lost", { reason });
        ctx.setStatus("error", reason);
      }
    } catch (error) {
      if (!signal.aborted) {
        ctx.log.warn("Discord login failed", { error: errorMessage(error) });
        ctx.setStatus("error", errorMessage(error));
      }
    }

    session.close();
    await gateway.destroy().catch((error: unknown) => {
      ctx.log.warn("Closing the Discord client failed", { error: errorMessage(error) });
    });
    if (signal.aborted) break;
    failures += 1;
    await sleep(backoffDelay(failures, backoff), signal);
  }
}

/** One gateway connection's worth of state. */
class Session {
  private readonly ctx: Ctx;
  private readonly allowed: Set<string>;
  private readonly approvers: Set<string>;
  private botUserId: string | null = null;
  private closed = false;
  private markReady: () => void = () => {};
  private readonly ready: Promise<void>;
  /** Emits run one at a time, so workflows see messages in the order Discord sent them. */
  private queue: Promise<void>;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    this.allowed = new Set(ctx.config.allowedUserIds ?? []);
    this.approvers = new Set(ctx.config.approverUserIds ?? []);
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
    // Messages can arrive a moment before login resolves; hold them until the bot's ID is known.
    this.queue = this.ready;
  }

  setBot(botUserId: string) {
    this.botUserId = botUserId;
    this.markReady();
  }

  close() {
    this.closed = true;
    this.markReady();
  }

  onMessage(message: GatewayMessage) {
    this.queue = this.queue.then(() => this.handleMessage(message));
  }

  private async handleMessage(message: GatewayMessage) {
    if (this.closed || this.botUserId === null) return;
    const payload = toDiscordMessage(message, this.botUserId, this.allowed);
    if (!payload) return;
    try {
      await this.ctx.emit({ type: MESSAGE_EVENT, payload, dedupeKey: message.id });
    } catch (error) {
      this.ctx.log.error("Handing a Discord message to workflows failed", {
        messageId: message.id,
        error: errorMessage(error),
      });
    }
  }

  async onButton(click: ButtonClick) {
    const parsed = parseApprovalCustomId(click.customId);
    if (!parsed) return;
    const decision: ApprovalDecision = {
      approvalId: parsed.approvalId,
      approve: parsed.approve,
      actor: { via: "discord", externalUserId: click.user.id },
    };
    const log = this.ctx.log;
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        log.warn(`Discord approval click: ${what} failed`, {
          approvalId: decision.approvalId,
          error: errorMessage(error),
        });
      }
    };

    if (!this.approvers.has(click.user.id)) {
      // Reply first: Discord only waits 3 seconds for an answer to a click.
      await attempt("replying", () => click.replyEphemeral(REFUSED_REPLY));
      await attempt("reporting the refused click", () =>
        this.ctx.approvals.reportRefused({
          ...decision,
          reason: "Discord user is not on this installation's approver list",
        }),
      );
      return;
    }

    await attempt("acknowledging", () => click.acknowledge());
    let result: { ok: boolean; message: string };
    try {
      result = await this.ctx.approvals.decide(decision);
    } catch (error) {
      log.error("Deciding an approval from Discord failed", {
        approvalId: decision.approvalId,
        error: errorMessage(error),
      });
      await attempt("replying", () =>
        click.replyEphemeral("Sling couldn't record that. Try again, or decide in the web app."),
      );
      return;
    }
    if (!result.ok) {
      await attempt("replying", () =>
        click.replyEphemeral(result.message || "This approval can't be decided any more."),
      );
      return;
    }
    await attempt("updating the message", () =>
      click.editMessage({
        content: decidedText(click.message.content, parsed.approve, click.user.id),
        components: approvalButtons(parsed.approvalId, { disabled: true }),
      }),
    );
  }
}

/** The trigger payload for a message, or null when the message should be dropped. */
export function toDiscordMessage(
  message: GatewayMessage,
  botUserId: string,
  allowedUserIds: ReadonlySet<string>,
): DiscordMessage | null {
  if (message.author.bot || message.system || message.author.id === botUserId) return null;
  if (!allowedUserIds.has(message.author.id)) return null;
  const mentionsBot =
    message.mentionedUserIds.includes(botUserId) ||
    (message.botRoleId !== null && message.mentionedRoleIds.includes(message.botRoleId));
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    isDM: message.guildId === null,
    author: { id: message.author.id, username: message.author.username },
    content: message.content,
    mentionsBot,
    createdAt: message.createdAt.toISOString(),
  };
}
