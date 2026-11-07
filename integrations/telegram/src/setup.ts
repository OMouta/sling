/**
 * Telegram's setup lookup. The token says which bot it is; then you send the
 * bot a message, and your chat shows up to pick, by default the one.
 */
import type { SetupNote, SetupOption, SetupResult } from "@sling/connector-sdk";
import { type BotApiFactory, chatName, type TgChat, type TgUpdate } from "./api.ts";
import { errorMessage } from "./backoff.ts";
import type { TelegramConfig, TelegramCredentials } from "./schemas.ts";

export const BOTFATHER_URL = "https://t.me/BotFather";

/** How soon to look again while waiting for the message that finds your chat. */
const RECHECK_MS = 3_000;
/** Most allowed chats named one by one. */
const MAX_NAMED = 20;

const tokenHelp: SetupNote = {
  field: "botToken",
  tone: "info",
  text: "Make a bot with @BotFather and paste the token it gives you.",
  link: { label: "Open @BotFather", url: BOTFATHER_URL },
};

function option(chat: TgChat): SetupOption {
  const detail =
    chat.type === "private"
      ? chat.username
        ? `@${chat.username}`
        : "Private chat"
      : chat.type === "channel"
        ? "Channel"
        : "Group";
  return { value: String(chat.id), label: chatName(chat), detail };
}

export async function telegramSetup(
  api: BotApiFactory,
  credentials: Partial<TelegramCredentials>,
  config: Partial<TelegramConfig>,
  signal: AbortSignal,
): Promise<SetupResult<TelegramCredentials, TelegramConfig>> {
  const token = (credentials.botToken ?? "").trim();
  if (!token) return { notes: [tokenHelp] };
  const client = api(token);
  try {
    const me = await client.call<{ username?: string; first_name?: string }>("getMe", {}, signal);
    if (!me.ok) {
      const text =
        me.error_code === 401 || me.error_code === 404
          ? "Telegram doesn't accept this token."
          : `Telegram said: ${me.description ?? "no"}`;
      return { notes: [{ ...tokenHelp, tone: "error", text }] };
    }
    const username = me.result?.username ?? "";
    const handle = username ? `@${username}` : (me.result?.first_name ?? "the bot");
    const notes: SetupNote[] = [{ field: "botToken", tone: "ok", text: `Connected as ${handle}` }];
    const out: SetupResult<TelegramCredentials, TelegramConfig> = { name: handle, notes };

    // Waiting updates name the chats that messaged the bot, newest last. Reading them
    // without an offset leaves them for the bot's own polling.
    const updates = await client.call<TgUpdate[]>(
      "getUpdates",
      { limit: 100, timeout: 0, allowed_updates: ["message"] },
      signal,
    );
    if (!updates.ok && /webhook/i.test(updates.description ?? "")) {
      notes.push({
        field: "botToken",
        tone: "error",
        text: "This bot sends its messages to a webhook, so Sling can't read them. Remove the webhook, or make a new bot for Sling.",
      });
      return out;
    }
    const seen = new Map<string, TgChat>();
    for (const u of [...(updates.result ?? [])].reverse()) {
      const chat = u.message?.chat;
      if (chat && !seen.has(String(chat.id)) && !u.message?.from?.is_bot)
        seen.set(String(chat.id), chat);
    }
    const allowed = config.allowedChatIds ?? [];
    // Chats allowed before aren't always among the waiting updates; ask for their names.
    for (const id of allowed.filter((a) => !seen.has(a)).slice(0, MAX_NAMED)) {
      const chat = await client.call<TgChat>("getChat", { chat_id: id }, signal);
      if (chat.ok && chat.result) seen.set(id, chat.result);
    }
    const chats = [...seen.values()];
    const options = chats.map(option);
    for (const id of allowed) {
      if (!seen.has(id)) options.push({ value: id, label: id, detail: "Not found" });
    }
    if (options.length > 0) out.options = { allowedChatIds: options };
    if (allowed.length === 0) {
      const mine = chats.find((c) => c.type === "private") ?? chats[0];
      if (mine) {
        out.config = { allowedChatIds: [String(mine.id)] };
        notes.push({
          field: "botToken",
          tone: "ok",
          text: `Found your chat with ${chatName(mine)}`,
        });
      } else {
        notes.push({
          field: "allowedChatIds",
          tone: "info",
          text: `Send ${handle} a message in Telegram, and your chat shows up here.`,
          ...(username
            ? { link: { label: `Open ${handle}`, url: `https://t.me/${username}` } }
            : {}),
        });
        out.retryAfterMs = RECHECK_MS;
      }
    }
    return out;
  } catch (error) {
    return {
      notes: [
        {
          field: "botToken",
          tone: "error",
          text: `Couldn't reach Telegram: ${errorMessage(error)}`,
        },
      ],
    };
  }
}
