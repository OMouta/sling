import type { ChannelMessage, ChannelSendResult } from "@sling/runner-protocol";
import type { AppContext } from "../context.ts";
import type { RunnerSession } from "../runners/gateway.ts";

/** How long a send waits for its machine to come online before it fails. */
export const CHANNEL_SEND_WAIT_MS = 5 * 60_000;

export interface ChannelSendAnswer {
  ok: boolean;
  /** Why it failed, naming the machine when it was offline. Empty when it worked. */
  message: string;
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

/**
 * Messaging channels that run on the user's machines, such as iMessage and
 * Signal. Until it's built nothing is received, nothing is acknowledged, and
 * every send fails.
 */
export class Channels implements ChannelService {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async message(): Promise<void> {}

  sendResult(): void {}

  runnerConnected(): void {}

  async send(): Promise<ChannelSendAnswer> {
    void this.#ctx;
    return { ok: false, message: "Channels on your machines aren't available on this server yet." };
  }
}
