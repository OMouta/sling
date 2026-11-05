import { type ConnectorDefinition, defineConnector, type TestResult } from "@sling/connector-sdk";
import type { Backoff } from "./backoff.ts";
import { errorMessage } from "./backoff.ts";
import { createDiscordJsGateway, type GatewayFactory } from "./gateway.ts";
import { CONNECTOR_ID, createSendMessage, messageReceived } from "./nodes.ts";
import { createRest, describeError, field, isOk, type RestFactory } from "./rest.ts";
import {
  configSchema,
  credentialsSchema,
  type DiscordConfig,
  type DiscordCredentials,
} from "./schemas.ts";
import { createDiscordSource } from "./source.ts";

export type { ButtonClick, DiscordGateway, GatewayHandlers, GatewayMessage } from "./gateway.ts";
export type { DiscordRest, RestResponse } from "./rest.ts";
export type { DiscordConfig, DiscordCredentials, DiscordMessage } from "./schemas.ts";

/** Application flags that mean the Message Content intent is on. */
export const GATEWAY_MESSAGE_CONTENT = 1 << 19;
export const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 18;

export const MESSAGE_CONTENT_OFF =
  "The Message Content intent is off, so the bot can't read messages. In the Discord developer portal, open your application, go to Bot, turn on Message Content Intent under Privileged Gateway Intents, and save.";

export const BAD_TOKEN =
  "Discord rejected the bot token. Reset it on the Bot page of your application in the Discord developer portal and paste the new one.";

export interface DiscordConnectorOptions {
  rest?: RestFactory;
  gateway?: GatewayFactory;
  backoff?: Backoff;
}

export function createDiscordConnector(
  options: DiscordConnectorOptions = {},
): ConnectorDefinition<DiscordCredentials, DiscordConfig> {
  const rest = options.rest ?? ((token: string) => createRest(token));
  return defineConnector<DiscordCredentials, DiscordConfig>({
    id: CONNECTOR_ID,
    name: "Discord",
    description:
      "A Discord bot you create. Workflows can react to messages sent to it and send messages, including approvals with buttons.",
    setupHelp:
      "Create an application in the Discord developer portal, add a bot, turn on the Message Content intent, and copy the bot token. Invite the bot with the bot scope. Allowed users and approvers are Discord user IDs: turn on Developer Mode in Discord, then right-click a user and choose Copy User ID.",
    credentialsSchema,
    secretFields: ["botToken"],
    configSchema,

    async test({ credentials, config, signal }): Promise<TestResult> {
      const client = rest(credentials.botToken);
      try {
        const me = await client.request("GET", "/users/@me", undefined, signal);
        if (me.status === 401) return { ok: false, error: BAD_TOKEN };
        if (!isOk(me)) {
          return { ok: false, error: `Discord didn't accept the token: ${describeError(me)}` };
        }
        const app = await client.request("GET", "/applications/@me", undefined, signal);
        if (!isOk(app)) {
          return {
            ok: false,
            error: `Couldn't read the application settings: ${describeError(app)}`,
          };
        }
        const flags = Number(field(app.body, "flags") ?? 0);
        if ((flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) === 0) {
          return { ok: false, error: MESSAGE_CONTENT_OFF };
        }
        const name = String(field(me.body, "username") ?? "the bot");
        const notes = [`Connected as ${name}.`];
        if ((config.allowedUserIds ?? []).length === 0) {
          notes.push("No allowed users yet, so no messages will reach workflows.");
        }
        return { ok: true, detail: notes.join(" ") };
      } catch (error) {
        return { ok: false, error: `Couldn't reach Discord: ${errorMessage(error)}` };
      }
    },

    nodes: [messageReceived, createSendMessage(rest)],
    source: createDiscordSource({
      gateway: options.gateway ?? createDiscordJsGateway,
      backoff: options.backoff,
    }),
  });
}

export const connector = createDiscordConnector();
