import { createHash } from "node:crypto";
import { type NodeContext, NodeError, type NodeSpec } from "@sling/connector-sdk";
import { z } from "zod";
import { errorMessage } from "./backoff.ts";
import { BOUNCE_WATCH_MS, checkSend } from "./bounce.ts";
import { smtpTransport } from "./clients.ts";
import { MAX_RESULTS, readMessage, searchMailbox } from "./mailbox.ts";
import {
  CONNECTOR_ID,
  credentialsSchema,
  type Email,
  type EmailConfig,
  type EmailCredentials,
  RECEIVED_EVENT,
} from "./schemas.ts";

export const receivedConfigSchema = z.object({
  installationId: z.string().min(1).describe("Email installation whose mailbox is watched"),
  folder: z
    .string()
    .min(1)
    .default("INBOX")
    .describe("Folder to watch. It has to be one of the folders set on the installation."),
  fromContains: z
    .string()
    .optional()
    .describe(
      "Only fire when the sender's address or name contains this text. Not case-sensitive.",
    ),
  subjectContains: z
    .string()
    .optional()
    .describe("Only fire when the subject contains this text. Not case-sensitive."),
});

export type ReceivedConfig = z.infer<typeof receivedConfigSchema>;

/** IMAP treats INBOX as case-insensitive; every other name is exact. */
function sameFolder(a: string, b: string): boolean {
  return a === b || (a.toUpperCase() === "INBOX" && b.toUpperCase() === "INBOX");
}

function contains(haystack: string, needle: string | undefined): boolean {
  const n = needle?.trim().toLowerCase();
  return !n || haystack.toLowerCase().includes(n);
}

export const emailReceived: NodeSpec<ReceivedConfig> = {
  type: RECEIVED_EVENT,
  version: 1,
  title: "Email received",
  description: "Fires for each new message in a watched IMAP folder.",
  category: "trigger",
  connector: CONNECTOR_ID,
  configSchema: receivedConfigSchema,
  installationFields: ["installationId"],
  inputs: [],
  outputs: [{ name: "email", type: "email", label: "Email" }],
  execInput: false,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  trigger: {
    event: RECEIVED_EVENT,
    match(event, rawConfig) {
      if (event.type !== RECEIVED_EVENT) return null;
      const parsed = receivedConfigSchema.safeParse(rawConfig);
      if (!parsed.success) return null;
      const config = parsed.data;
      if (event.installationId && event.installationId !== config.installationId) return null;
      const email = event.payload as Email;
      if (!email || typeof email.folder !== "string" || !email.from) return null;
      if (!sameFolder(email.folder, config.folder)) return null;
      const sender = `${email.from.name ?? ""} <${email.from.address}>`;
      if (!contains(sender, config.fromContains)) return null;
      if (!contains(email.subject ?? "", config.subjectContains)) return null;
      return { outputs: { email } };
    },
  },
};

export const sendConfigSchema = z.object({
  installationId: z.string().min(1).describe("Email installation to send from"),
  to: z.string().min(1).describe("Recipients, separated by commas"),
  subject: z.string().default("").describe("Subject line"),
  text: z
    .string()
    .default("")
    .meta({ widget: "textarea" })
    .describe("Plain text body. A value on the text input replaces it."),
  inReplyTo: z
    .string()
    .optional()
    .describe(
      "Message-ID of the email this answers, so mail apps thread the reply. For example ={{ trigger.email.messageId }}",
    ),
});

export type SendConfig = z.infer<typeof sendConfigSchema>;

/** The domain part of a From address, for Message-IDs. */
export function domainOf(fromAddress: string): string {
  const matches = [...fromAddress.matchAll(/@([A-Za-z0-9.-]+[A-Za-z0-9])/g)];
  return matches.at(-1)?.[1] ?? "localhost";
}

/** The same node run always gets the same Message-ID, so a repeat send can be spotted. */
export function messageIdFor(idempotencyKey: string, fromAddress: string): string {
  const hash = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
  return `<${hash}.sling@${domainOf(fromAddress)}>`;
}

const RETRYABLE_CODES = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ECONNRESET",
  "ECONNREFUSED",
]);

/** SMTP 4xx replies and connection failures are temporary; 5xx and auth failures aren't. */
export function smtpError(error: unknown): NodeError {
  const e = error as { code?: string; responseCode?: number; response?: string };
  const message = errorMessage(error);
  if (e.code === "EAUTH") {
    return new NodeError(
      `SMTP login failed: ${message}. Check the username, and use an app password if your provider requires one.`,
      { code: "smtp_auth_failed", cause: error },
    );
  }
  const status = typeof e.responseCode === "number" ? e.responseCode : 0;
  const temporary = (status >= 400 && status < 500) || RETRYABLE_CODES.has(e.code ?? "");
  return new NodeError(`Sending failed: ${message}`, {
    code: temporary ? "smtp_unavailable" : "smtp_rejected",
    retryable: temporary,
    cause: error,
  });
}

export const sendEmail: NodeSpec<SendConfig> = {
  type: "email.send",
  version: 1,
  title: "Send email",
  description: "Sends a plain text email over SMTP from the installation's address.",
  category: "action",
  connector: CONNECTOR_ID,
  configSchema: sendConfigSchema,
  expressionFields: ["to", "subject", "text", "inReplyTo"],
  installationFields: ["installationId"],
  inputs: [
    {
      name: "text",
      type: "string",
      label: "Text",
      description: "Body text. Replaces the text setting when connected.",
      required: false,
    },
  ],
  outputs: [
    { name: "messageId", type: "string", label: "Message-ID" },
    { name: "sentAt", type: "string", label: "Sent at (ISO 8601)" },
  ],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: false,
  assistant: { sends: true, summary: "Email {to}: {subject}", ruleFields: ["to"] },
  // A little past the watch, so the last look always lands inside it.
  verifyForSeconds: BOUNCE_WATCH_MS / 1000 + 120,

  async run(ctx, { inputs, config: rawConfig }) {
    const parsed = sendConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new NodeError(`Invalid settings: ${parsed.error.message}`, { code: "invalid_config" });
    }
    const config = parsed.data;
    const credentials = await mailbox(ctx, config.installationId);
    const to = config.to.trim();
    if (!to) throw new NodeError("No recipients", { code: "no_recipient" });
    const text = typeof inputs.text === "string" ? inputs.text : config.text;
    const inReplyTo = config.inReplyTo?.trim() || undefined;
    const messageId = messageIdFor(ctx.idempotencyKey, credentials.fromAddress);

    const transport = smtpTransport(credentials);
    const onAbort = () => transport.close();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await transport.sendMail({
        from: credentials.fromAddress,
        to,
        subject: config.subject,
        text,
        messageId,
        inReplyTo,
        references: inReplyTo,
      });
    } catch (error) {
      throw smtpError(error);
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      transport.close();
    }
    ctx.log.info("Sent email", { messageId });
    return { exec: "next", outputs: { messageId, sentAt: new Date().toISOString() } };
  },

  async verify(ctx, { config: rawConfig, outputs }) {
    const parsed = sendConfigSchema.safeParse(rawConfig);
    const messageId = typeof outputs.messageId === "string" ? outputs.messageId : "";
    const sentAtMs = typeof outputs.sentAt === "string" ? Date.parse(outputs.sentAt) : Number.NaN;
    if (!parsed.success || !messageId || !Number.isFinite(sentAtMs)) {
      return { state: "unchecked", message: "Sent, but there's nothing to watch for a bounce" };
    }
    const credentials = await mailbox(ctx, parsed.data.installationId);
    const recipients = parsed.data.to.split(",").filter((a) => a.trim()).length;
    return checkSend(
      credentials,
      { messageId, sentAtMs, recipients },
      { now: Date.now(), attempt: ctx.attempt, signal: ctx.signal },
    );
  },
};

/** The installation's mail settings, checked to be an email account's. */
async function mailbox(ctx: NodeContext, installationId: string): Promise<EmailCredentials> {
  const installation = await ctx.installation<EmailCredentials, EmailConfig>(installationId);
  if (installation.connectorId !== CONNECTOR_ID) {
    throw new NodeError(`Installation ${installation.name} isn't an email installation`, {
      code: "wrong_installation",
    });
  }
  const credentials = credentialsSchema.safeParse(installation.credentials);
  if (!credentials.success) {
    throw new NodeError(`Installation ${installation.name} is missing its mail server settings`, {
      code: "missing_credentials",
    });
  }
  return credentials.data;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (what: string) =>
  z.string().trim().regex(DAY, "Use a date such as 2026-11-06").optional().describe(what);

export const searchConfigSchema = z.object({
  installationId: z.string().min(1).describe("Email installation whose mailbox is searched"),
  folder: z
    .string()
    .default("INBOX")
    .describe(
      "Folder to search. Sent, Drafts, Archive, Junk, and Trash find those folders by their usual names.",
    ),
  from: z.string().max(200).optional().describe("The sender's address or name contains this"),
  to: z.string().max(200).optional().describe("A recipient's address or name contains this"),
  subject: z.string().max(200).optional().describe("The subject contains this"),
  text: z
    .string()
    .max(200)
    .optional()
    .describe("Words anywhere in the message, its headers and body"),
  since: day("Only messages from this day on, such as 2026-11-01"),
  before: day("Only messages from before this day, such as 2026-11-08"),
  unread: z
    .boolean()
    .optional()
    .describe("True for unread messages only, false for read ones only. Leave it out for both"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS)
    .default(20)
    .describe(`How many messages to return, newest first, up to ${MAX_RESULTS}`),
});

export type SearchConfig = z.infer<typeof searchConfigSchema>;

export const searchEmail: NodeSpec<SearchConfig> = {
  type: "email.search",
  version: 1,
  title: "Search email",
  description:
    "Finds messages in a folder by sender, recipient, subject, words, dates, or whether they're read. Returns each message's ID, sender, recipients, subject, date, and the start of its text, newest first. Pass an ID to email.read for the whole message.",
  category: "action",
  connector: CONNECTOR_ID,
  configSchema: searchConfigSchema,
  expressionFields: ["folder", "from", "to", "subject", "text", "since", "before"],
  installationFields: ["installationId"],
  inputs: [],
  outputs: [
    { name: "messages", type: "list<json>", label: "Messages" },
    { name: "total", type: "number", label: "How many matched" },
  ],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  retry: { maxAttempts: 2, backoffMs: 2_000 },
  assistant: { sends: false, summary: "Search email: {from} {subject} {text}" },

  async run(ctx, { config: raw }) {
    const parsed = searchConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new NodeError(`Invalid settings: ${parsed.error.issues[0]?.message}`, {
        code: "invalid_config",
      });
    }
    const { installationId, ...query } = parsed.data;
    const credentials = await mailbox(ctx, installationId);
    const found = await searchMailbox(credentials, query, ctx.signal);
    return { exec: "next", outputs: { messages: found.messages, total: found.total } };
  },
};

export const readConfigSchema = z.object({
  installationId: z.string().min(1).describe("Email installation the message is in"),
  id: z
    .string()
    .min(5)
    .max(1_000)
    .describe("The message's ID from email.search, such as INBOX:1700000000:42"),
});

export type ReadConfig = z.infer<typeof readConfigSchema>;

export const readEmail: NodeSpec<ReadConfig> = {
  type: "email.read",
  version: 1,
  title: "Read email",
  description:
    "Reads one message found with email.search: its headers, its text up to 20 KB (from the HTML when it has no plain text), and its attachments by name and size.",
  category: "action",
  connector: CONNECTOR_ID,
  configSchema: readConfigSchema,
  expressionFields: ["id"],
  installationFields: ["installationId"],
  inputs: [],
  outputs: [{ name: "message", type: "json", label: "Message" }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  retry: { maxAttempts: 2, backoffMs: 2_000 },
  assistant: { sends: false, summary: "Read email {id}" },

  async run(ctx, { config: raw }) {
    const parsed = readConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new NodeError(`Invalid settings: ${parsed.error.issues[0]?.message}`, {
        code: "invalid_config",
      });
    }
    const credentials = await mailbox(ctx, parsed.data.installationId);
    const message = await readMessage(credentials, parsed.data.id, ctx.signal);
    return { exec: "next", outputs: { message } };
  },
};
