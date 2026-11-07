/**
 * A local stand-in for the Telegram Bot API, for tests: getMe, getUpdates
 * with long polling and Telegram's offset rules, sendMessage, getChat, and
 * getWebhookInfo. A newer getUpdates ends an older one with 409, as
 * Telegram does.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TgChat, TgUpdate } from "./api.ts";

export interface Sent {
  chat_id: string;
  text: string;
  parse_mode?: string;
}

export interface BotApiStandIn {
  /** Base URL to hand `createBotApi`. */
  url: string;
  token: string;
  sent: Sent[];
  /** getUpdates calls, with their offsets. */
  polls: { offset: number | null }[];
  /** Someone writes to the bot. */
  message(chat: TgChat, text: string): TgUpdate;
  /** Chats the bot may not write to, as Telegram answers for a blocked bot. */
  blocked: Set<string>;
  /** Set to make getUpdates refuse, as it does while a webhook is set. */
  webhook: string;
  close(): Promise<void>;
}

const BOT = { id: 7000000001, is_bot: true, first_name: "Sling", username: "sling_test_bot" };

export async function startBotApi(token = "7000000001:test-token"): Promise<BotApiStandIn> {
  const updates: TgUpdate[] = [];
  const chats = new Map<string, TgChat>();
  let nextUpdate = 100;
  let nextMessage = 1;
  let waiting: { done: (answer: unknown) => void; timer: NodeJS.Timeout } | null = null;
  const wake: (() => void)[] = [];

  const state: Omit<BotApiStandIn, "url" | "close"> = {
    token,
    sent: [],
    polls: [],
    blocked: new Set(),
    webhook: "",
    message(chat, text) {
      chats.set(String(chat.id), chat);
      const update: TgUpdate = {
        update_id: nextUpdate++,
        message: {
          message_id: nextMessage++,
          date: Math.floor(Date.now() / 1000),
          chat,
          from:
            chat.type === "private"
              ? {
                  id: chat.id,
                  is_bot: false,
                  first_name: chat.first_name ?? "Someone",
                  ...(chat.username ? { username: chat.username } : {}),
                }
              : { id: 42, is_bot: false, first_name: "Someone" },
          text,
        },
      };
      updates.push(update);
      for (const w of wake.splice(0)) w();
      return update;
    },
  };

  const server: Server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const params = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const reply = (answer: unknown) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    const fail = (code: number, description: string, extra: Record<string, unknown> = {}) =>
      res
        .writeHead(code, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: false, error_code: code, description, ...extra }));
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
    if (!m || m[1] !== token) return fail(401, "Unauthorized");
    switch (m[2]) {
      case "getMe":
        return reply({ ok: true, result: BOT });
      case "getWebhookInfo":
        return reply({ ok: true, result: { url: state.webhook, pending_update_count: 0 } });
      case "getChat": {
        const chat = chats.get(String(params.chat_id));
        return chat ? reply({ ok: true, result: chat }) : fail(400, "Bad Request: chat not found");
      }
      case "getUpdates": {
        if (state.webhook) {
          return fail(409, "Conflict: can't use getUpdates method while webhook is active");
        }
        const offset = typeof params.offset === "number" ? params.offset : null;
        state.polls.push({ offset });
        // A negative offset keeps that many from the end and forgets the rest.
        if (offset !== null && offset < 0) updates.splice(0, Math.max(0, updates.length + offset));
        else if (offset !== null) {
          while (updates.length > 0 && (updates[0]?.update_id ?? 0) < offset) updates.shift();
        }
        if (waiting) {
          clearTimeout(waiting.timer);
          waiting.done({
            ok: false,
            error_code: 409,
            description: "Conflict: terminated by other getUpdates request",
          });
          waiting = null;
        }
        const limit = typeof params.limit === "number" ? params.limit : 100;
        const ready = () => updates.slice(0, limit);
        const timeout = typeof params.timeout === "number" ? params.timeout : 0;
        if (updates.length > 0 || timeout === 0) return reply({ ok: true, result: ready() });
        const done = (answer: unknown) => {
          if (!res.writableEnded) reply(answer);
        };
        const timer = setTimeout(() => {
          waiting = null;
          done({ ok: true, result: [] });
        }, timeout * 1000);
        waiting = { done, timer };
        wake.push(() => {
          if (waiting?.done !== done) return;
          clearTimeout(timer);
          waiting = null;
          done({ ok: true, result: ready() });
        });
        req.on("close", () => clearTimeout(timer));
        return;
      }
      case "sendMessage": {
        const chatId = String(params.chat_id);
        if (state.blocked.has(chatId)) return fail(403, "Forbidden: bot was blocked by the user");
        const body = String(params.text ?? "");
        // Stands for HTML Telegram can't read, which Sling's own never is.
        if (params.parse_mode === "HTML" && body.includes("UNPARSEABLE")) {
          return fail(400, "Bad Request: can't parse entities: Can't find end tag");
        }
        state.sent.push({
          chat_id: chatId,
          text: body,
          ...(typeof params.parse_mode === "string" ? { parse_mode: params.parse_mode } : {}),
        });
        return reply({
          ok: true,
          result: {
            message_id: nextMessage++,
            date: Math.floor(Date.now() / 1000),
            chat: chats.get(chatId) ?? { id: Number(chatId), type: "private" },
            text: body,
          },
        });
      }
      default:
        return fail(404, "Not Found");
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    ...state,
    get webhook() {
      return state.webhook;
    },
    set webhook(v: string) {
      state.webhook = v;
    },
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((ok) => {
        if (waiting) clearTimeout(waiting.timer);
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
