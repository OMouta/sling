import { z } from "zod";

export const CONNECTOR_ID = "telegram";
export const MESSAGE_EVENT = "telegram.message_received";

/** Telegram chat IDs are integers, negative for groups and channels. */
export const CHAT_ID = /^-?\d{1,20}$/;

export const credentialsSchema = z.object({
  botToken: z.string().min(1).meta({ step: "Bot token", title: "Bot token", lookup: true }),
});

export type TelegramCredentials = z.infer<typeof credentialsSchema>;

/**
 * Who the bot answers: private chats, which carry the person's own ID, and
 * groups. In a group it answers only the people on the list.
 */
export const configSchema = z.object({
  allowedChatIds: z
    .array(z.string().regex(CHAT_ID, "A Telegram chat ID is a number"))
    .default([])
    .meta({
      step: "Who it answers",
      title: "Chats and people it answers",
      picker: true,
      allowOther: true,
      placeholder: "Add a chat ID",
    }),
});

export type TelegramConfig = z.infer<typeof configSchema>;

/** The `telegram.message` named type. */
export interface TelegramMessage {
  id: string;
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  /** The person's name for a private chat, or the group's title. */
  chatName: string;
  from: { id: string; username: string | null; name: string };
  text: string;
  /** ISO 8601. */
  date: string;
}
