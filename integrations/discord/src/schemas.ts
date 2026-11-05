import { z } from "zod";

/** Discord IDs (snowflakes) are 64-bit integers written as decimal strings. */
export const SNOWFLAKE = /^\d{15,22}$/;

const snowflake = z.string().regex(SNOWFLAKE, "Discord IDs are 15 to 22 digits");

export const credentialsSchema = z.object({
  botToken: z
    .string()
    .min(1)
    .describe("Bot token from the Bot page of your application in the Discord developer portal"),
});

export type DiscordCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z.object({
  allowedUserIds: z
    .array(snowflake)
    .default([])
    .describe(
      "Discord user IDs whose messages reach your workflows. Messages from anyone else are dropped before any trigger sees them.",
    ),
  approverUserIds: z
    .array(snowflake)
    .default([])
    .describe(
      "Discord user IDs that may press Approve or Reject on approval messages. Clicks from anyone else are refused and logged.",
    ),
  defaultChannelId: z
    .string()
    .regex(/^(\d{15,22})?$/, "Discord IDs are 15 to 22 digits")
    .optional()
    .describe("Channel ID that Send message posts to when the node names no channel or user"),
});

export type DiscordConfig = z.infer<typeof configSchema>;

/** The `discord.message` named type. */
export interface DiscordMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  isDM: boolean;
  author: { id: string; username: string };
  content: string;
  mentionsBot: boolean;
  createdAt: string;
}

/** The `approval` named type, as it arrives on a data input. */
export interface ApprovalInput {
  id: string;
  kind: string;
  title: string;
  summary?: string;
  expiresAt?: string;
  url: string;
}

export const MESSAGE_EVENT = "discord.message_received";
