/**
 * The Telegram event source: long polling on getUpdates, so no public
 * address is needed. The offset of the next update is stored after each one
 * is handed to workflows, so a restart neither repeats nor loses one. On its
 * first start it begins after whatever is already waiting.
 */
import type { EventSource, EventSourceFactory, SourceContext } from "@sling/connector-sdk";
import { type BotAnswer, type BotApiFactory, chatName, type TgUpdate, userName } from "./api.ts";
import { type Backoff, backoffDelay, DEFAULT_BACKOFF, errorMessage, sleep } from "./backoff.ts";
import {
  MESSAGE_EVENT,
  type TelegramConfig,
  type TelegramCredentials,
  type TelegramMessage,
} from "./schemas.ts";

type Ctx = SourceContext<TelegramCredentials, TelegramConfig>;

export interface TelegramSourceOptions {
  api: BotApiFactory;
  backoff?: Backoff;
  /** How long one getUpdates waits for news, in seconds. */
  pollSeconds?: number;
}

export const OFFSET_KEY = "offset";

export const BAD_TOKEN =
  "Telegram doesn't accept the bot token. Get a new one from @BotFather and paste it on the Connectors page.";

/**
 * The trigger payload for an update, or null when it isn't a text message
 * from an allowed chat and an allowed person. A private chat's ID is the
 * person's own, so the list holds both. In a group, only the people on the
 * list are answered, so a group with none of them answers nobody.
 */
export function toTelegramMessage(
  update: TgUpdate,
  allowedChatIds: ReadonlySet<string>,
): TelegramMessage | null {
  const m = update.message;
  if (!m?.from || m.from.is_bot) return null;
  const text = m.text ?? m.caption ?? "";
  if (!text.trim()) return null;
  const chatId = String(m.chat.id);
  if (!allowedChatIds.has(chatId) || !allowedChatIds.has(String(m.from.id))) return null;
  return {
    id: String(m.message_id),
    chatId,
    chatType: m.chat.type,
    chatName: chatName(m.chat),
    from: {
      id: String(m.from.id),
      username: m.from.username ?? null,
      name: userName(m.from) || chatName(m.chat),
    },
    text,
    date: new Date(m.date * 1000).toISOString(),
  };
}

export function createTelegramSource(
  options: TelegramSourceOptions,
): EventSourceFactory<TelegramCredentials, TelegramConfig> {
  return {
    async start(ctx): Promise<EventSource> {
      const controller = new AbortController();
      const signal = AbortSignal.any([ctx.signal, controller.signal]);
      const running = poll(ctx, options, signal).catch((error: unknown) => {
        ctx.log.error("Telegram source stopped unexpectedly", { error: errorMessage(error) });
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

/** Why a getUpdates failed, and how long to wait before the next one. */
function failure(res: {
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}) {
  const description = res.description ?? `error ${res.error_code ?? "unknown"}`;
  if (res.error_code === 401 || res.error_code === 404)
    return { detail: BAD_TOKEN, transient: false };
  if (res.error_code === 409 && /webhook/i.test(description)) {
    return {
      detail:
        "This bot sends its messages to a webhook, so Sling can't read them. Remove the webhook, or make a new bot for Sling.",
      transient: false,
    };
  }
  // Another getUpdates took over, such as the setup form looking for a chat. Telegram ends the older one.
  if (res.error_code === 409) return { detail: description, transient: true, waitMs: 1_000 };
  if (res.error_code === 429) {
    return {
      detail: description,
      transient: true,
      waitMs: (res.parameters?.retry_after ?? 5) * 1000,
    };
  }
  return { detail: `Telegram said: ${description}`, transient: false };
}

async function poll(ctx: Ctx, options: TelegramSourceOptions, signal: AbortSignal) {
  const api = options.api(ctx.credentials.botToken);
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const pollSeconds = options.pollSeconds ?? 50;
  const allowed = new Set(ctx.config.allowedChatIds ?? []);
  let failures = 0;
  let offset: number | null = null;
  let connected = false;
  const fail = async (detail: string) => {
    connected = false;
    failures += 1;
    ctx.setStatus("error", detail);
    await sleep(backoffDelay(failures, backoff), signal);
  };

  while (!signal.aborted) {
    ctx.setStatus("connecting");
    try {
      const me = await api.call<{ username?: string }>("getMe", {}, signal);
      if (!me.ok) {
        await fail(failure(me).detail);
        continue;
      }
      const name = me.result?.username ? `@${me.result.username}` : "the bot";
      if (offset === null) {
        const stored = Number(await ctx.state.get(OFFSET_KEY));
        if (Number.isSafeInteger(stored) && stored > 0) {
          offset = stored;
        } else {
          // First start: what's already waiting was sent before Sling listened, such as
          // the message that found the chat during setup.
          const latest = await api.call<TgUpdate[]>(
            "getUpdates",
            { offset: -1, timeout: 0 },
            signal,
          );
          if (!latest.ok) {
            await fail(failure(latest).detail);
            continue;
          }
          const last = latest.result?.at(-1);
          offset = last ? last.update_id + 1 : 0;
          await ctx.state.set(OFFSET_KEY, String(offset));
        }
      }
      while (!signal.aborted) {
        const res: BotAnswer<TgUpdate[]> = await api.call<TgUpdate[]>(
          "getUpdates",
          { offset, timeout: pollSeconds, allowed_updates: ["message"] },
          AbortSignal.any([signal, AbortSignal.timeout((pollSeconds + 15) * 1000)]),
        );
        if (!res.ok) {
          const why = failure(res);
          if (why.transient) {
            await sleep(why.waitMs ?? 1_000, signal);
            continue;
          }
          await fail(why.detail);
          break;
        }
        if (!connected) {
          connected = true;
          failures = 0;
          ctx.setStatus("connected", `Listening as ${name}`);
        }
        for (const update of res.result ?? ([] as TgUpdate[])) {
          const payload = toTelegramMessage(update, allowed);
          if (payload) {
            // A failed emit throws, which waits and asks again from the same offset.
            await ctx.emit({ type: MESSAGE_EVENT, payload, dedupeKey: String(update.update_id) });
          }
          offset = update.update_id + 1;
          await ctx.state.set(OFFSET_KEY, String(offset));
        }
      }
    } catch (error) {
      if (signal.aborted) break;
      ctx.log.warn("Telegram polling failed", { error: errorMessage(error) });
      await fail(`Couldn't reach Telegram: ${errorMessage(error)}`);
    }
  }
}
