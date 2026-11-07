import { createHash } from "node:crypto";
import { type NodeContext, NodeError, type NodeSpec } from "@sling/connector-sdk";
import { z } from "zod";
import {
  approvalButtons,
  approvalText,
  isValidApprovalId,
  MESSAGE_LIMIT,
  truncate,
} from "./approval.ts";
import { errorMessage } from "./backoff.ts";
import { describeError, field, isOk, type RestFactory, type RestResponse } from "./rest.ts";
import {
  type ApprovalInput,
  configSchema,
  credentialsSchema,
  type DiscordConfig,
  type DiscordCredentials,
  type DiscordMessage,
  MESSAGE_EVENT,
  SNOWFLAKE,
} from "./schemas.ts";

export const CONNECTOR_ID = "discord";

export const messageReceivedConfigSchema = z.object({
  installationId: z
    .string()
    .min(1)
    .describe("Discord installation whose bot receives the messages"),
  scope: z
    .enum(["dm", "channels", "any"])
    .default("dm")
    .describe(
      "Where to listen: dm for direct messages to the bot, channels for server channels, any for both",
    ),
  channelIds: z
    .array(z.string())
    .default([])
    .describe(
      "Server channel IDs to listen in. Leave empty for every channel the bot can read. Doesn't affect direct messages.",
    ),
  requireMention: z
    .boolean()
    .default(false)
    .describe(
      "Only fire for channel messages that mention the bot. Direct messages always count as addressed to it.",
    ),
});

export type MessageReceivedConfig = z.infer<typeof messageReceivedConfigSchema>;

export const messageReceived: NodeSpec<MessageReceivedConfig> = {
  type: MESSAGE_EVENT,
  version: 1,
  title: "Discord message received",
  description:
    "Fires when someone on the installation's allowed list messages the bot, in a DM or a channel it can read.",
  category: "trigger",
  connector: CONNECTOR_ID,
  configSchema: messageReceivedConfigSchema,
  installationFields: ["installationId"],
  inputs: [],
  outputs: [{ name: "message", type: "discord.message", label: "Message" }],
  execInput: false,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  trigger: {
    event: MESSAGE_EVENT,
    match(event, rawConfig) {
      if (event.type !== MESSAGE_EVENT) return null;
      const parsed = messageReceivedConfigSchema.safeParse(rawConfig);
      if (!parsed.success) return null;
      const config = parsed.data;
      if (event.installationId && event.installationId !== config.installationId) return null;
      const message = event.payload as DiscordMessage;
      if (!message || typeof message.channelId !== "string") return null;
      if (message.isDM) {
        if (config.scope === "channels") return null;
      } else {
        if (config.scope === "dm") return null;
        if (config.channelIds.length > 0 && !config.channelIds.includes(message.channelId)) {
          return null;
        }
        if (config.requireMention && !message.mentionsBot) return null;
      }
      return {
        outputs: { message },
        concurrencyKey: `discord:${config.installationId}:${message.channelId}`,
      };
    },
  },
};

export const sendMessageConfigSchema = z.object({
  installationId: z.string().min(1).describe("Discord installation whose bot sends the message"),
  channelId: z
    .string()
    .optional()
    .describe(
      "Channel ID to post in. Leave empty to DM the user below, or to post in the installation's default channel.",
    ),
  userId: z
    .string()
    .optional()
    .describe("Discord user ID to send a direct message to, when no channel is set"),
  content: z
    .string()
    .default("")
    .meta({ widget: "textarea" })
    .describe(
      "Message text, up to 2,000 characters. A value on the content input replaces it. With approval buttons on, it's shown above the approval.",
    ),
  approvalButtons: z
    .boolean()
    .default(false)
    .describe(
      "Show the approval from the approval input with Approve and Reject buttons. Only users on the installation's approver list can use them.",
    ),
});

export type SendMessageConfig = z.infer<typeof sendMessageConfigSchema>;

/** Discord's nonce is at most 25 characters, so the idempotency key is hashed down to fit. */
export function nonceFor(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 25);
}

export interface MessageBody {
  content: string;
  nonce: string;
  enforce_nonce: true;
  allowed_mentions: { parse: string[] };
  components?: ReturnType<typeof approvalButtons>;
}

export function buildMessageBody(args: {
  content: string;
  approval: ApprovalInput | null;
  idempotencyKey: string;
}): MessageBody {
  const content = args.approval
    ? approvalText(args.approval, args.content)
    : truncate(args.content, MESSAGE_LIMIT);
  const body: MessageBody = {
    content,
    // With enforce_nonce, Discord returns the earlier message instead of posting a repeat.
    nonce: nonceFor(args.idempotencyKey),
    enforce_nonce: true,
    // Content often carries text from emails or other people; never let it ping @everyone or roles.
    allowed_mentions: { parse: ["users"] },
  };
  if (args.approval) body.components = approvalButtons(args.approval.id);
  return body;
}

function parseApproval(value: unknown): ApprovalInput | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  if (typeof a.id !== "string" || typeof a.url !== "string") return null;
  return {
    id: a.id,
    kind: typeof a.kind === "string" ? a.kind : "",
    title: typeof a.title === "string" ? a.title : "",
    summary: typeof a.summary === "string" ? a.summary : undefined,
    expiresAt: typeof a.expiresAt === "string" ? a.expiresAt : undefined,
    url: a.url,
  };
}

/** Turns a failed Discord response into a NodeError. 429 and 5xx are retryable. */
export function responseError(res: RestResponse, action: string): NodeError {
  const detail = describeError(res);
  if (res.status === 429) {
    const wait = res.retryAfterMs ? ` Try again in ${Math.ceil(res.retryAfterMs / 1000)}s.` : "";
    return new NodeError(`Discord rate limited ${action}.${wait}`, {
      code: "discord_rate_limited",
      retryable: true,
    });
  }
  if (res.status >= 500) {
    return new NodeError(`Discord failed while ${action}: ${detail}`, {
      code: "discord_unavailable",
      retryable: true,
    });
  }
  if (res.status === 401) {
    return new NodeError("Discord rejected the bot token. Update it on the Connectors page.", {
      code: "discord_unauthorized",
    });
  }
  if (res.status === 403) {
    return new NodeError(`The bot isn't allowed to do this while ${action}: ${detail}`, {
      code: "discord_forbidden",
    });
  }
  if (res.status === 404) {
    return new NodeError(`Discord couldn't find the channel or user while ${action}: ${detail}`, {
      code: "discord_not_found",
    });
  }
  return new NodeError(`Discord refused ${action}: ${detail}`, { code: "discord_error" });
}

export function createSendMessage(rest: RestFactory): NodeSpec<SendMessageConfig> {
  async function call(
    ctx: NodeContext,
    token: string,
    method: "POST",
    path: string,
    body: unknown,
    action: string,
  ): Promise<RestResponse> {
    let res: RestResponse;
    try {
      res = await rest(token).request(method, path, body, ctx.signal);
    } catch (error) {
      throw new NodeError(`Couldn't reach Discord while ${action}: ${errorMessage(error)}`, {
        code: "discord_unreachable",
        retryable: true,
        cause: error,
      });
    }
    if (!isOk(res)) throw responseError(res, action);
    return res;
  }

  return {
    type: "discord.send_message",
    version: 1,
    title: "Send Discord message",
    description:
      "Posts a message in a channel or a direct message, optionally with Approve and Reject buttons for an approval.",
    category: "action",
    connector: CONNECTOR_ID,
    configSchema: sendMessageConfigSchema,
    expressionFields: ["channelId", "userId", "content"],
    installationFields: ["installationId"],
    inputs: [
      {
        name: "content",
        type: "string",
        label: "Content",
        description: "Message text. Replaces the content setting when connected.",
        required: false,
      },
      {
        name: "approval",
        type: "approval",
        label: "Approval",
        description: "The approval to show buttons for. Required when approval buttons are on.",
        required: false,
      },
    ],
    outputs: [
      { name: "messageId", type: "string", label: "Message ID" },
      { name: "channelId", type: "string", label: "Channel ID" },
    ],
    execInput: true,
    execOutputs: [{ name: "next" }],
    idempotent: false,
    assistant: {
      sends: true,
      summary: "Discord message: {content}",
      ruleFields: ["channelId", "userId"],
    },

    async run(ctx, { inputs, config: rawConfig }) {
      const parsedConfig = sendMessageConfigSchema.safeParse(rawConfig);
      if (!parsedConfig.success) {
        throw new NodeError(`Invalid settings: ${parsedConfig.error.message}`, {
          code: "invalid_config",
        });
      }
      const config = parsedConfig.data;
      const installation = await ctx.installation<DiscordCredentials, DiscordConfig>(
        config.installationId,
      );
      if (installation.connectorId !== CONNECTOR_ID) {
        throw new NodeError(`Installation ${installation.name} isn't a Discord installation`, {
          code: "wrong_installation",
        });
      }
      const credentials = credentialsSchema.safeParse(installation.credentials);
      if (!credentials.success) {
        throw new NodeError(`Installation ${installation.name} has no bot token`, {
          code: "missing_credentials",
        });
      }
      const token = credentials.data.botToken;
      const installationConfig = configSchema.safeParse(installation.config);

      let approval: ApprovalInput | null = null;
      if (config.approvalButtons) {
        approval = parseApproval(inputs.approval);
        if (!approval) {
          throw new NodeError(
            "Approval buttons are on, but no approval came in on the approval input",
            { code: "missing_approval" },
          );
        }
        if (!isValidApprovalId(approval.id)) {
          throw new NodeError(`Approval ID ${approval.id} can't be used in a button`, {
            code: "invalid_approval",
          });
        }
      }
      const content = typeof inputs.content === "string" ? inputs.content : config.content;
      const body = buildMessageBody({ content, approval, idempotencyKey: ctx.idempotencyKey });
      if (!body.content.trim()) {
        throw new NodeError("The message is empty", { code: "empty_message" });
      }

      const channelSetting = config.channelId?.trim() ?? "";
      const userSetting = config.userId?.trim() ?? "";
      const fallback = installationConfig.success
        ? (installationConfig.data.defaultChannelId ?? "")
        : "";
      let channelId = channelSetting || (userSetting ? "" : fallback);
      if (!channelId && !userSetting) {
        throw new NodeError(
          "No channel or user to send to. Set one on the node, or a default channel on the installation.",
          { code: "no_target" },
        );
      }
      if (channelId && !SNOWFLAKE.test(channelId)) {
        throw new NodeError(`"${channelId}" isn't a Discord channel ID`, {
          code: "invalid_target",
        });
      }
      if (!channelId) {
        if (!SNOWFLAKE.test(userSetting)) {
          throw new NodeError(`"${userSetting}" isn't a Discord user ID`, {
            code: "invalid_target",
          });
        }
        const dm = await call(
          ctx,
          token,
          "POST",
          "/users/@me/channels",
          { recipient_id: userSetting },
          "opening a direct message",
        );
        channelId = String(field(dm.body, "id") ?? "");
        if (!channelId) {
          throw new NodeError("Discord didn't return a DM channel", { code: "discord_error" });
        }
      }

      const sent = await call(
        ctx,
        token,
        "POST",
        `/channels/${channelId}/messages`,
        body,
        "sending the message",
      );
      const messageId = String(field(sent.body, "id") ?? "");
      const sentChannel = String(field(sent.body, "channel_id") ?? channelId);
      ctx.log.info("Sent Discord message", { channelId: sentChannel, messageId });
      return { exec: "next", outputs: { messageId, channelId: sentChannel } };
    },

    verifyForSeconds: 60,
    /** Fetches the sent message back by its ID. */
    async verify(ctx, { config: rawConfig, outputs }) {
      const messageId = typeof outputs.messageId === "string" ? outputs.messageId : "";
      const channelId = typeof outputs.channelId === "string" ? outputs.channelId : "";
      if (!SNOWFLAKE.test(messageId) || !SNOWFLAKE.test(channelId)) {
        return { state: "unchecked", message: "Discord didn't say which message it posted" };
      }
      const installation = await ctx.installation<DiscordCredentials, DiscordConfig>(
        String((rawConfig as { installationId?: unknown }).installationId ?? ""),
      );
      const credentials = credentialsSchema.safeParse(installation.credentials);
      if (installation.connectorId !== CONNECTOR_ID || !credentials.success) {
        return { state: "unchecked", message: "The bot's token isn't there to look with" };
      }
      const res = await rest(credentials.data.botToken).request(
        "GET",
        `/channels/${channelId}/messages/${messageId}`,
        undefined,
        ctx.signal,
      );
      if (isOk(res) && field(res.body, "id") === messageId) {
        return { state: "passed", message: "Discord has the message" };
      }
      if (res.status === 404) {
        return { state: "failed", message: "Discord doesn't have the message: it was removed" };
      }
      if (res.status === 429 || res.status >= 500) {
        return {
          state: "waiting",
          message: `Discord answered ${res.status}`,
          retryAfterSeconds: Math.max(5, Math.ceil((res.retryAfterMs ?? 10_000) / 1000)),
        };
      }
      // The bot can post but not read the channel's history, so it can't tell.
      return {
        state: "unchecked",
        message: `Discord won't let the bot read it back: ${describeError(res)}`,
      };
    },
  };
}
