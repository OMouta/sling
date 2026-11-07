import { type ConnectorDefinition, defineConnector, type TestResult } from "@sling/connector-sdk";
import { type BotApiFactory, createBotApi } from "./api.ts";
import { type Backoff, errorMessage } from "./backoff.ts";
import { createSendMessage, messageReceived } from "./nodes.ts";
import {
  CONNECTOR_ID,
  configSchema,
  credentialsSchema,
  type TelegramConfig,
  type TelegramCredentials,
} from "./schemas.ts";
import { telegramSetup } from "./setup.ts";
import { BAD_TOKEN, createTelegramSource } from "./source.ts";

export type { BotAnswer, BotApi, BotApiFactory, TgUpdate } from "./api.ts";
export { createBotApi } from "./api.ts";
export { MESSAGE_LIMIT, telegramMessages } from "./markdown.ts";
export type { TelegramConfig, TelegramCredentials, TelegramMessage } from "./schemas.ts";

export interface TelegramConnectorOptions {
  /** How the connector reaches the Bot API. Tests point it at a stand-in. */
  api?: BotApiFactory;
  backoff?: Backoff;
  /** Seconds each getUpdates waits for news. Tests shorten it. */
  pollSeconds?: number;
}

export function createTelegramConnector(
  options: TelegramConnectorOptions = {},
): ConnectorDefinition<TelegramCredentials, TelegramConfig> {
  const api = options.api ?? ((token: string) => createBotApi(token));
  return defineConnector<TelegramCredentials, TelegramConfig>({
    id: CONNECTOR_ID,
    name: "Telegram",
    description: "Message your bot, and hear back there.",
    credentialsSchema,
    secretFields: ["botToken"],
    configSchema,

    async test({ credentials, config, signal }): Promise<TestResult> {
      const client = api(credentials.botToken);
      try {
        const me = await client.call<{ username?: string }>("getMe", {}, signal);
        if (me.error_code === 401 || me.error_code === 404) return { ok: false, error: BAD_TOKEN };
        if (!me.ok) return { ok: false, error: `Telegram said: ${me.description ?? "no"}` };
        const hook = await client.call<{ url?: string }>("getWebhookInfo", {}, signal);
        if (hook.ok && hook.result?.url) {
          return {
            ok: false,
            error:
              "This bot sends its messages to a webhook, so Sling can't read them. Remove the webhook, or make a new bot for Sling.",
          };
        }
        const name = me.result?.username ? `@${me.result.username}` : "the bot";
        const chats = (config.allowedChatIds ?? []).length;
        return {
          ok: true,
          detail:
            chats === 0
              ? `Connected as ${name}. No chats allowed yet, so it answers no one.`
              : `Connected as ${name}. It answers ${chats === 1 ? "1 chat" : `${chats} chats`}.`,
        };
      } catch (error) {
        return { ok: false, error: `Couldn't reach Telegram: ${errorMessage(error)}` };
      }
    },

    setup: ({ credentials, config, signal }) => telegramSetup(api, credentials, config, signal),

    nodes: [messageReceived, createSendMessage(api)],
    source: createTelegramSource({
      api,
      ...(options.backoff ? { backoff: options.backoff } : {}),
      ...(options.pollSeconds ? { pollSeconds: options.pollSeconds } : {}),
    }),
  });
}

export const connector = createTelegramConnector();
