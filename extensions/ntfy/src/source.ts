/**
 * The ntfy event source: one WebSocket subscription to every watched topic,
 * `wss://<server>/<topic1>,<topic2>/ws`. It reconnects with backoff, asks for
 * what it missed with `since`, and treats a connection with no keepalive for
 * two minutes as dead.
 */
import type { EventSource, EventSourceFactory, SourceContext } from "@sling/connector-sdk";
import { describeSubscription, subscribeUrl } from "./client.ts";
import {
  MESSAGE_EVENT,
  type NtfyConfig,
  type NtfyCredentials,
  type NtfyWireMessage,
  toMessage,
} from "./schemas.ts";

type Ctx = SourceContext<NtfyCredentials, NtfyConfig>;

/** The part of the WebSocket API the source uses. */
export interface SocketLike {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string; wasClean?: boolean }) => void,
  ): void;
  close(code?: number, reason?: string): void;
}

export interface Backoff {
  initialMs: number;
  maxMs: number;
}

export interface NtfySourceOptions {
  /** Opens a socket. Defaults to the global WebSocket, which Sling routes through its network rules. */
  connect?: (url: string) => SocketLike;
  backoff?: Backoff;
  /** ntfy sends a keepalive every 45 seconds. Silence for this long means the connection is dead. */
  silenceMs?: number;
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 2_000, maxMs: 2 * 60_000 };
export const DEFAULT_SILENCE_MS = 120_000;
/** State key holding the time of the newest message handed on, in Unix seconds. */
export const SINCE_KEY = "since";

/** Exponential delay for the nth failure in a row, with ±20% jitter. */
export function backoffDelay(failures: number, backoff: Backoff): number {
  const base = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function isWireMessage(value: unknown): value is NtfyWireMessage {
  const m = value as Partial<NtfyWireMessage> | null;
  return (
    !!m &&
    m.event === "message" &&
    typeof m.id === "string" &&
    typeof m.topic === "string" &&
    typeof m.time === "number"
  );
}

export function createNtfySource(
  options: NtfySourceOptions = {},
): EventSourceFactory<NtfyCredentials, NtfyConfig> {
  return {
    async start(ctx): Promise<EventSource> {
      const topics = [...new Set(ctx.config.topics ?? [])];
      if (topics.length === 0) {
        ctx.setStatus(
          "connected",
          "Not watching any topics. Add topics to start workflows from messages.",
        );
        return { stop: async () => {} };
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([ctx.signal, controller.signal]);
      const loop = watch(ctx, topics, options, signal);
      return {
        async stop() {
          controller.abort();
          await loop;
        },
      };
    },
  };
}

/** Keeps the subscription open until the signal aborts. */
async function watch(ctx: Ctx, topics: string[], options: NtfySourceOptions, signal: AbortSignal) {
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const where = describeSubscription(ctx.config, topics);
  let failures = 0;
  while (!signal.aborted) {
    ctx.setStatus("connecting");
    try {
      const since = await ctx.state.get(SINCE_KEY);
      const url = subscribeUrl(ctx.config, ctx.credentials, topics, since);
      await subscribe(ctx, url, where, options, signal, () => {
        failures = 0;
        ctx.setStatus("connected", `Watching ${topics.join(", ")}`);
      });
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log.warn("ntfy subscription failed", { where, error: message });
        ctx.setStatus("error", message);
      }
    }
    if (signal.aborted) break;
    failures += 1;
    await sleep(backoffDelay(failures, backoff), signal);
  }
}

/** One connection. Resolves when it closes cleanly, rejects with the reason otherwise. */
function subscribe(
  ctx: Ctx,
  url: string,
  where: string,
  options: NtfySourceOptions,
  signal: AbortSignal,
  onOpen: () => void,
): Promise<void> {
  const silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
  const connect = options.connect ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
  return new Promise((resolve, reject) => {
    const socket = connect(url);
    let opened = false;
    let failure: string | null = null;
    let settled = false;
    // Messages are handed on one at a time, so they reach workflows in order.
    let queue: Promise<void> = Promise.resolve();
    let silence: ReturnType<typeof setTimeout> | undefined;

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(silence);
      signal.removeEventListener("abort", onAbort);
      void queue.then(() => (error ? reject(error) : resolve()));
    };
    const watchdog = () => {
      clearTimeout(silence);
      silence = setTimeout(() => {
        failure = `No message or keepalive from ${where} for ${Math.round(silenceMs / 1000)} seconds`;
        socket.close(4000, "silent");
        finish(new Error(failure));
      }, silenceMs);
    };
    const onAbort = () => {
      socket.close(1000, "stopping");
      finish(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    socket.addEventListener("open", () => {
      opened = true;
      watchdog();
      onOpen();
    });
    socket.addEventListener("message", ({ data }) => {
      watchdog();
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!isWireMessage(parsed)) return; // open, keepalive, poll_request
      const wire = parsed;
      queue = queue
        .then(() => handOn(ctx, wire))
        .catch((error: unknown) => {
          ctx.log.error("Couldn't hand an ntfy message to workflows", {
            id: wire.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
    socket.addEventListener("error", (event) => {
      failure = event.message || failure;
    });
    socket.addEventListener("close", ({ code, reason }) => {
      if (signal.aborted) return finish(null);
      if (!opened) {
        return finish(
          new Error(
            `Couldn't subscribe to ${where}${failure ? `: ${failure}` : ""}. Check the server URL, the topics, and the access token.`,
          ),
        );
      }
      if (code === 1000) return finish(null);
      finish(
        new Error(
          `The connection to ${where} closed (${code}${reason ? ` ${reason}` : ""}${failure ? `, ${failure}` : ""})`,
        ),
      );
    });
  });
}

async function handOn(ctx: Ctx, wire: NtfyWireMessage): Promise<void> {
  await ctx.emit({ type: MESSAGE_EVENT, payload: toMessage(wire), dedupeKey: wire.id });
  const since = Number(await ctx.state.get(SINCE_KEY));
  if (!(since >= wire.time)) await ctx.state.set(SINCE_KEY, String(wire.time));
}
