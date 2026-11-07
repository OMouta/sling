import { type NodeContext, NodeError, type NodeSpec } from "@sling/connector-sdk";
import { z } from "zod";
import type { BotAnswer, BotApiFactory, TgMessage } from "./api.ts";
import { errorMessage, sleep } from "./backoff.ts";
import { telegramMessages } from "./markdown.ts";
import {
  CHAT_ID,
  CONNECTOR_ID,
  configSchema,
  credentialsSchema,
  MESSAGE_EVENT,
  type TelegramConfig,
  type TelegramCredentials,
  type TelegramMessage,
} from "./schemas.ts";

export const messageReceivedConfigSchema = z.object({
  installationId: z
    .string()
    .min(1)
    .describe("Telegram installation whose bot receives the messages"),
});

export type MessageReceivedConfig = z.infer<typeof messageReceivedConfigSchema>;

export const messageReceived: NodeSpec<MessageReceivedConfig> = {
  type: MESSAGE_EVENT,
  version: 1,
  title: "Telegram message received",
  description: "Fires when someone in one of the installation's allowed chats messages the bot.",
  category: "trigger",
  connector: CONNECTOR_ID,
  configSchema: messageReceivedConfigSchema,
  installationFields: ["installationId"],
  inputs: [],
  outputs: [{ name: "message", type: "telegram.message", label: "Message" }],
  execInput: false,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  trigger: {
    event: MESSAGE_EVENT,
    match(event, rawConfig) {
      if (event.type !== MESSAGE_EVENT) return null;
      const parsed = messageReceivedConfigSchema.safeParse(rawConfig);
      if (!parsed.success) return null;
      if (event.installationId && event.installationId !== parsed.data.installationId) return null;
      const message = event.payload as TelegramMessage;
      if (!message || typeof message.chatId !== "string") return null;
      return {
        outputs: { message },
        concurrencyKey: `telegram:${parsed.data.installationId}:${message.chatId}`,
      };
    },
  },
};

export const sendMessageConfigSchema = z.object({
  installationId: z.string().min(1).describe("Telegram installation whose bot sends the message"),
  chatId: z
    .string()
    .optional()
    .describe("Chat to send to, one the installation answers. Empty sends to its first chat"),
  text: z
    .string()
    .default("")
    .meta({ widget: "textarea" })
    .describe(
      "The message, in Markdown. A long one goes as several messages. A value on the text input replaces it.",
    ),
});

export type SendMessageConfig = z.infer<typeof sendMessageConfigSchema>;

/** A refused send, worded so the person knows what to change. */
export function sendError(res: BotAnswer, chatId: string): NodeError {
  const description = res.description ?? `error ${res.error_code ?? "unknown"}`;
  if (res.error_code === 401 || res.error_code === 404) {
    return new NodeError(
      "Telegram doesn't accept the bot token. Update it on the Connectors page.",
      { code: "telegram_unauthorized" },
    );
  }
  if (res.error_code === 403) {
    return new NodeError(`The bot can't message chat ${chatId}: ${description}`, {
      code: "telegram_forbidden",
    });
  }
  if (res.error_code === 400 && /chat not found/i.test(description)) {
    return new NodeError(
      `Telegram doesn't know chat ${chatId}. Message the bot from that chat first.`,
      { code: "telegram_no_chat" },
    );
  }
  if (res.error_code === 429 || (res.error_code ?? 0) >= 500) {
    return new NodeError(`Telegram is busy: ${description}`, {
      code: "telegram_unavailable",
      retryable: true,
    });
  }
  return new NodeError(`Telegram refused the message: ${description}`, { code: "telegram_error" });
}

async function installationOf(ctx: NodeContext, id: string) {
  const installation = await ctx.installation<TelegramCredentials, TelegramConfig>(id);
  if (installation.connectorId !== CONNECTOR_ID) {
    throw new NodeError(`Installation ${installation.name} isn't a Telegram bot`, {
      code: "wrong_installation",
    });
  }
  const credentials = credentialsSchema.safeParse(installation.credentials);
  if (!credentials.success) {
    throw new NodeError(`Installation ${installation.name} has no bot token`, {
      code: "missing_credentials",
    });
  }
  const config = configSchema.safeParse(installation.config);
  return {
    name: installation.name,
    token: credentials.data.botToken,
    allowed: config.success ? config.data.allowedChatIds : [],
  };
}

export function createSendMessage(api: BotApiFactory): NodeSpec<SendMessageConfig> {
  return {
    type: "telegram.send_message",
    version: 1,
    title: "Send Telegram message",
    description:
      "Sends a message to one of the bot's allowed chats. Markdown becomes Telegram's formatting, and a reply over 4,096 characters goes as several messages.",
    category: "action",
    connector: CONNECTOR_ID,
    configSchema: sendMessageConfigSchema,
    expressionFields: ["chatId", "text"],
    installationFields: ["installationId"],
    inputs: [
      {
        name: "text",
        type: "string",
        label: "Text",
        description: "The message. Replaces the text setting when connected.",
        required: false,
      },
    ],
    outputs: [
      { name: "messageId", type: "string", label: "Message ID (the last one, when it was split)" },
      { name: "messageIds", type: "list<string>", label: "Message IDs" },
      { name: "chatId", type: "string", label: "Chat ID" },
    ],
    execInput: true,
    execOutputs: [{ name: "next" }],
    idempotent: false,
    assistant: { sends: true, summary: "Telegram message: {text}", ruleFields: ["chatId"] },
    // Telegram has no way to read a message back, so its answer is the check.
    verifyForSeconds: 60,

    async run(ctx, { inputs, config: raw }) {
      const parsed = sendMessageConfigSchema.safeParse(raw);
      if (!parsed.success) {
        throw new NodeError(`Invalid settings: ${parsed.error.issues[0]?.message}`, {
          code: "invalid_config",
        });
      }
      const config = parsed.data;
      const bot = await installationOf(ctx, config.installationId);
      const chatId = config.chatId?.trim() || bot.allowed[0] || "";
      if (!chatId) {
        throw new NodeError(`${bot.name} has no chats yet. Add one on the Connectors page.`, {
          code: "no_target",
        });
      }
      if (!CHAT_ID.test(chatId)) {
        throw new NodeError(`"${chatId}" isn't a Telegram chat ID`, { code: "invalid_target" });
      }
      // Only the chats the person allowed, so a message can't go anywhere else.
      if (!bot.allowed.includes(chatId)) {
        throw new NodeError(
          `${bot.name} doesn't answer chat ${chatId}. Add it to the bot's chats on the Connectors page.`,
          { code: "chat_not_allowed" },
        );
      }
      const text = typeof inputs.text === "string" ? inputs.text : config.text;
      const messages = telegramMessages(text);
      if (messages.length === 0)
        throw new NodeError("The message is empty", { code: "empty_message" });

      const client = api(bot.token);
      const send = async (params: Record<string, unknown>) => {
        let res: BotAnswer<TgMessage>;
        try {
          res = await client.call<TgMessage>("sendMessage", params, ctx.signal);
        } catch (error) {
          throw new NodeError(`Couldn't reach Telegram: ${errorMessage(error)}`, {
            code: "telegram_unreachable",
            retryable: true,
            cause: error,
          });
        }
        // Too many at once: Telegram says how long to wait, and nothing was sent.
        const wait = res.parameters?.retry_after ?? 0;
        if (!res.ok && res.error_code === 429 && wait <= 10) {
          await sleep(wait * 1000, ctx.signal);
          res = await client.call<TgMessage>("sendMessage", params, ctx.signal);
        }
        return res;
      };
      const ids: string[] = [];
      for (const [i, m] of messages.entries()) {
        let res = await send({ chat_id: chatId, text: m.html, parse_mode: "HTML" });
        if (
          !res.ok &&
          res.error_code === 400 &&
          /can't parse entities/i.test(res.description ?? "")
        ) {
          res = await send({ chat_id: chatId, text: m.text });
        }
        if (!res.ok) {
          const error = sendError(res, chatId);
          if (i === 0) throw error;
          throw new NodeError(`Sent ${i} of ${messages.length} parts, then: ${error.message}`, {
            code: error.code,
          });
        }
        ids.push(String(res.result?.message_id ?? ""));
      }
      ctx.log.info("Sent Telegram message", { chatId, parts: ids.length });
      return { exec: "next", outputs: { messageId: ids.at(-1), messageIds: ids, chatId } };
    },

    async verify(_ctx, { outputs }) {
      const ids = Array.isArray(outputs.messageIds) ? outputs.messageIds : [];
      if (ids.length === 0) return { state: "unchecked", message: "" };
      return {
        state: "passed",
        message: ids.length > 1 ? `Telegram took all ${ids.length} parts` : "Telegram took it",
      };
    },
  };
}
