import { defineNode } from "@sling/connector-sdk";
import { z } from "zod";
import { CONNECTOR_ID, MESSAGE_EVENT, type NtfyMessage } from "./schemas.ts";

export const receivedConfigSchema = z.object({
  installationId: z.string().min(1).describe("ntfy installation whose topics are watched"),
  topics: z
    .array(z.string().trim())
    .default([])
    .describe(
      "Only fire for these topics. Empty means every topic the installation watches. Each one must also be in the installation's topics",
    ),
  contains: z
    .string()
    .default("")
    .describe("Only fire when the title or message contains this text. Not case-sensitive"),
});

export type ReceivedConfig = z.infer<typeof receivedConfigSchema>;

function isMessage(value: unknown): value is NtfyMessage {
  const m = value as Partial<NtfyMessage> | null;
  return (
    !!m && typeof m.id === "string" && typeof m.topic === "string" && typeof m.message === "string"
  );
}

export const messageReceived = defineNode({
  type: "ntfy.message_received",
  version: 1,
  title: "ntfy message received",
  description: "Fires for each message published to a topic the installation watches.",
  category: "trigger",
  connector: CONNECTOR_ID,
  configSchema: receivedConfigSchema,
  installationFields: ["installationId"],
  inputs: [],
  outputs: [
    {
      name: "message",
      type: "json",
      label: "Message",
      description:
        "The whole message: id, time, topic, title, message, priority, tags, click, and attachment.",
    },
    { name: "text", type: "string", label: "Text", description: "The message's text." },
    { name: "title", type: "string", label: "Title", description: "Empty when it has none." },
    { name: "topic", type: "string", label: "Topic" },
  ],
  execInput: false,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  trigger: {
    event: MESSAGE_EVENT,
    match(event, raw) {
      if (event.type !== MESSAGE_EVENT) return null;
      const parsed = receivedConfigSchema.safeParse(raw);
      if (!parsed.success) return null;
      const config = parsed.data;
      if (event.installationId && event.installationId !== config.installationId) return null;
      const m = event.payload;
      if (!isMessage(m)) return null;
      const topics = config.topics.filter(Boolean);
      if (topics.length > 0 && !topics.includes(m.topic)) return null;
      const needle = config.contains.trim().toLowerCase();
      if (needle && !`${m.title}\n${m.message}`.toLowerCase().includes(needle)) return null;
      return {
        outputs: { message: m, text: m.message, title: m.title, topic: m.topic },
        // Messages on one topic run one at a time, in the order they arrived.
        concurrencyKey: `ntfy:${config.installationId}:${m.topic}`,
      };
    },
  },
});
