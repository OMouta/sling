/**
 * Telegram's setup lookup. The token says which bot it is; then you send the
 * bot a private message, and your chat shows up to pick, by default the one.
 * A group is never picked by itself. People who wrote in a group show up as
 * well, since a group answers only the people on the list.
 */
import type { SetupNote, SetupOption, SetupResult } from "@sling/connector-sdk";
import {
  type BotApiFactory,
  chatName,
  type TgChat,
  type TgUpdate,
  type TgUser,
  userName,
} from "./api.ts";
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

function person(user: TgUser): SetupOption {
  return {
    value: String(user.id),
    label: userName(user),
    detail: user.username ? `@${user.username}` : "Person",
  };
}

/** Group and channel IDs are negative; a person's, and their private chat's, aren't. */
const isGroup = (id: string) => id.startsWith("-");

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
    // A private chat's ID is the person's own, so people who wrote in a group
    // are offered only when they have no private chat here.
    const people = new Map<string, TgUser>();
    for (const u of [...(updates.result ?? [])].reverse()) {
      const chat = u.message?.chat;
      const from = u.message?.from;
      if (!chat || !from || from.is_bot) continue;
      if (!seen.has(String(chat.id))) seen.set(String(chat.id), chat);
      if (chat.type !== "private" && !people.has(String(from.id)))
        people.set(String(from.id), from);
    }
    const allowed = config.allowedChatIds ?? [];
    // Chats allowed before aren't always among the waiting updates; ask for their names.
    for (const id of allowed.filter((a) => !seen.has(a)).slice(0, MAX_NAMED)) {
      const chat = await client.call<TgChat>("getChat", { chat_id: id }, signal);
      if (chat.ok && chat.result) seen.set(id, chat.result);
    }
    const chats = [...seen.values()];
    const options = chats.map(option);
    for (const [id, user] of people) {
      if (!seen.has(id)) options.push(person(user));
    }
    const offered = new Set(options.map((o) => o.value));
    for (const id of allowed) {
      if (!offered.has(id)) options.push({ value: id, label: id, detail: "Not found" });
    }
    if (options.length > 0) out.options = { allowedChatIds: options };
    if (allowed.length === 0) {
      const mine = chats.find((c) => c.type === "private");
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
          text: `Send ${handle} a private message in Telegram, and your chat shows up here.`,
          ...(username
            ? { link: { label: `Open ${handle}`, url: `https://t.me/${username}` } }
            : {}),
        });
        out.retryAfterMs = RECHECK_MS;
      }
    } else if (allowed.some(isGroup) && !allowed.some((id) => !isGroup(id))) {
      notes.push({
        field: "allowedChatIds",
        tone: "info",
        text: "In a group, it answers only the people on this list. Add yourself too.",
      });
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
