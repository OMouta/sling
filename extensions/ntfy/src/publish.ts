import { defineNode, NodeError } from "@sling/connector-sdk";
import { z } from "zod";
import { authHeaders, baseUrl, errorMessage, errorText } from "./client.ts";
import {
  CONNECTOR_ID,
  configSchema,
  credentialsSchema,
  type NtfyConfig,
  type NtfyCredentials,
  type NtfyWireMessage,
  TOPIC,
} from "./schemas.ts";

export const publishConfigSchema = z.object({
  installationId: z.string().min(1).describe("ntfy installation to publish with"),
  topic: z
    .string()
    .trim()
    .default("")
    .describe("Topic to publish to. Empty uses the installation's default topic"),
  message: z
    .string()
    .default("")
    .meta({ widget: "textarea" })
    .describe("The notification's text. A value on the message input replaces it"),
  title: z.string().default("").describe("Shown above the message"),
  priority: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe("1 (min) to 5 (max). 4 and 5 make a sound and vibrate on phones. 3 is the default"),
  tags: z
    .string()
    .default("")
    .describe(
      "Tags, separated by commas. Emoji short codes show as emoji, for example white_check_mark or warning",
    ),
  click: z.string().trim().default("").describe("A URL to open when the notification is tapped"),
  markdown: z.boolean().default(false).describe("Show the message as Markdown in ntfy's web app"),
});

export type PublishConfig = z.infer<typeof publishConfigSchema>;

/** The JSON body ntfy takes on a POST to the server's root. */
export function publishBody(topic: string, message: string, config: PublishConfig) {
  const tags = config.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    topic,
    message,
    ...(config.title ? { title: config.title } : {}),
    priority: config.priority,
    ...(tags.length ? { tags } : {}),
    ...(config.click ? { click: config.click } : {}),
    ...(config.markdown ? { markdown: true } : {}),
  };
}

function httpError(status: number, detail: string, topic: string): NodeError {
  if (status === 401 || status === 403) {
    return new NodeError(
      `ntfy refused to publish to ${topic} (${detail}). The topic may be reserved: set an access token that can write to it.`,
      { code: "ntfy_forbidden" },
    );
  }
  if (status === 429) {
    return new NodeError(`ntfy is rate limiting this server: ${detail}`, {
      code: "ntfy_rate_limited",
      retryable: true,
    });
  }
  if (status === 413) {
    return new NodeError(`The message is too large for ntfy: ${detail}`, {
      code: "ntfy_too_large",
    });
  }
  return new NodeError(`ntfy answered ${status}: ${detail}`, {
    code: status >= 500 ? "ntfy_unavailable" : "ntfy_rejected",
    retryable: status >= 500,
  });
}

export const publish = defineNode({
  type: "ntfy.publish",
  version: 1,
  title: "Publish to ntfy",
  description: "Sends a push notification to an ntfy topic.",
  category: "action",
  connector: CONNECTOR_ID,
  configSchema: publishConfigSchema,
  expressionFields: ["topic", "message", "title", "priority", "tags", "click"],
  installationFields: ["installationId"],
  inputs: [
    {
      name: "message",
      type: "string",
      label: "Message",
      description: "The notification's text. Replaces the message setting when connected.",
      required: false,
    },
  ],
  outputs: [
    { name: "id", type: "string", label: "Message ID" },
    { name: "topic", type: "string", label: "Topic" },
  ],
  execInput: true,
  execOutputs: [{ name: "next" }],
  // Publishing twice sends two notifications.
  idempotent: false,
  assistant: { sends: true, summary: "Push through ntfy: {message}" },

  async run(ctx, { inputs, config: raw }) {
    const parsed = publishConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new NodeError(`Invalid settings: ${parsed.error.message}`, { code: "invalid_config" });
    }
    const config = parsed.data;
    const installation = await ctx.installation<NtfyCredentials, NtfyConfig>(config.installationId);
    if (installation.connectorId !== CONNECTOR_ID) {
      throw new NodeError(`Installation ${installation.name} isn't an ntfy installation`, {
        code: "wrong_installation",
      });
    }
    const credentials = credentialsSchema.parse(installation.credentials ?? {});
    const settings = configSchema.parse(installation.config ?? {});
    const topic = config.topic || settings.defaultTopic || "";
    if (!topic) {
      throw new NodeError(
        `No topic. Set one on the node, or a default topic on the ${installation.name} installation.`,
        { code: "no_topic" },
      );
    }
    if (!TOPIC.test(topic)) {
      throw new NodeError(`"${topic}" isn't a valid ntfy topic: use letters, digits, - and _`, {
        code: "invalid_topic",
      });
    }
    const message = typeof inputs.message === "string" ? inputs.message : config.message;
    let res: Response;
    try {
      res = await fetch(`${baseUrl(settings)}/`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(credentials) },
        body: JSON.stringify(publishBody(topic, message, config)),
        signal: ctx.signal,
      });
    } catch (error) {
      throw new NodeError(`Couldn't reach ${baseUrl(settings)}: ${errorMessage(error)}`, {
        code: "ntfy_unreachable",
        retryable: true,
        cause: error,
      });
    }
    if (!res.ok) throw httpError(res.status, await errorText(res), topic);
    const sent = (await res.json()) as NtfyWireMessage;
    ctx.log.info("Published to ntfy", { topic, id: sent.id });
    return { exec: "next", outputs: { id: sent.id, topic } };
  },
});
