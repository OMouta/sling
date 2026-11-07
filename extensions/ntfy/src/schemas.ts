import { z } from "zod";

export const CONNECTOR_ID = "ntfy";
/** The event the source emits for each message on a watched topic. */
export const MESSAGE_EVENT = "ntfy.message";
export const DEFAULT_SERVER = "https://ntfy.sh";

/** ntfy's own rule for topic names. */
export const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
const TOPIC_HELP = "Topics are 1 to 64 letters, digits, - and _";

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

const MORE = { advanced: true } as const;

export const credentialsSchema = z.object({
  accessToken: z
    .string()
    .trim()
    .optional()
    .meta({
      ...MORE,
      title: "Access token",
      description: "For reserved topics or your own server",
    }),
});

export type NtfyCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z.object({
  defaultTopic: z
    .string()
    .trim()
    .regex(/^([-_A-Za-z0-9]{1,64})?$/, TOPIC_HELP)
    .optional()
    .meta({ title: "Topic", lookup: true, order: 0 }),
  server: z
    .string()
    .trim()
    .default(DEFAULT_SERVER)
    .refine(isHttpUrl, "Use the server's https:// URL, for example https://ntfy.sh")
    .meta({ ...MORE, title: "Server", lookup: true }),
  topics: z
    .array(z.string().trim().regex(TOPIC, TOPIC_HELP))
    .max(20)
    .default([])
    .meta({
      ...MORE,
      title: "Topics that start workflows",
      description: "Anyone who knows a topic's name can post to it",
    }),
});

export type NtfyConfig = z.infer<typeof configSchema>;

/** A message as ntfy sends it to subscribers. */
export interface NtfyWireMessage {
  id: string;
  /** Unix seconds. */
  time: number;
  event: string;
  topic: string;
  message?: string;
  title?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  attachment?: { name: string; url: string; type?: string; size?: number };
}

/** What the trigger outputs as `message`. */
export interface NtfyMessage {
  id: string;
  /** ISO time the server received it. */
  time: string;
  topic: string;
  title: string;
  message: string;
  /** 1 (min) to 5 (max). */
  priority: number;
  tags: string[];
  click: string | null;
  attachment: { name: string; url: string } | null;
}

export function toMessage(m: NtfyWireMessage): NtfyMessage {
  return {
    id: m.id,
    time: new Date(m.time * 1000).toISOString(),
    topic: m.topic,
    title: m.title ?? "",
    message: m.message ?? "",
    priority: m.priority ?? 3,
    tags: m.tags ?? [],
    click: m.click ?? null,
    attachment: m.attachment ? { name: m.attachment.name, url: m.attachment.url } : null,
  };
}
