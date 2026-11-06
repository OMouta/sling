import type { ClientEvent, NotificationSettings, PushPayload } from "@sling/core";
import type { AppContext } from "../context.ts";

export interface NotifyOptions {
  /** Which setting gates it. Without one, the push always goes out. */
  category?: keyof NotificationSettings;
  urgency?: "normal" | "high";
  ttlSeconds?: number;
}

/** Web Push to the devices people turned notifications on for. */
export class PushService {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  /** Pushes to every device of one user. Resolves to how many devices took it. */
  async notify(
    _workspaceId: string,
    _userId: string,
    _payload: PushPayload,
    _opts: NotifyOptions = {},
  ): Promise<number> {
    void this.#ctx;
    return 0;
  }

  /** What a browser socket says it shows. */
  presence(_socketId: string, _userId: string, _event: ClientEvent): void {}

  socketClosed(_socketId: string): void {}
}
