/**
 * A small Telegram Bot API client. The connector needs a handful of
 * methods, and a plain interface keeps the nodes, the source, and the setup
 * lookup easy to run against a stand-in.
 */

export const BOT_API = "https://api.telegram.org";

/** What every Bot API method answers. */
export interface BotAnswer<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export interface BotApi {
  call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BotAnswer<T>>;
}

export type BotApiFactory = (token: string) => BotApi;

/** Telegram's chat, as much of it as Sling reads. */
export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

/** People sometimes paste the token with the `bot` prefix from the API's URLs. */
export function normalizeToken(token: string): string {
  return token.trim().replace(/^bot(?=\d+:)/i, "");
}

export function createBotApi(
  token: string,
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): BotApi {
  const doFetch = options.fetch ?? fetch;
  const base = `${options.baseUrl ?? BOT_API}/bot${normalizeToken(token)}`;
  return {
    async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const res = await doFetch(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
      const text = await res.text();
      try {
        return JSON.parse(text) as BotAnswer<T>;
      } catch {
        return {
          ok: false,
          error_code: res.status,
          description: text.slice(0, 200) || `HTTP ${res.status}`,
        };
      }
    },
  };
}

/** A chat's name the way Telegram shows it. */
export function chatName(chat: TgChat): string {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  return name || (chat.username ? `@${chat.username}` : String(chat.id));
}

/** A person's name the way Telegram shows it. */
export function userName(user: TgUser | undefined): string {
  if (!user) return "";
  return (
    [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id)
  );
}
