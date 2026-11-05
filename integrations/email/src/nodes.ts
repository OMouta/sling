import { createHash } from "node:crypto";
import { NodeError, type NodeSpec } from "@sling/workflow";
import { z } from "zod";
import { errorMessage } from "./backoff.ts";
import { smtpTransport } from "./clients.ts";
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
  outputs: [{ name: "messageId", type: "string", label: "Message-ID" }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: false,

  async run(ctx, { inputs, config: rawConfig }) {
    const parsed = sendConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new NodeError(`Invalid settings: ${parsed.error.message}`, { code: "invalid_config" });
    }
    const config = parsed.data;
    const installation = await ctx.installation<EmailCredentials, EmailConfig>(
      config.installationId,
    );
    if (installation.connectorId !== CONNECTOR_ID) {
      throw new NodeError(`Installation ${installation.name} isn't an email installation`, {
        code: "wrong_installation",
      });
    }
    const credentials = credentialsSchema.safeParse(installation.credentials);
    if (!credentials.success) {
      throw new NodeError(`Installation ${installation.name} is missing SMTP settings`, {
        code: "missing_credentials",
      });
    }
    const to = config.to.trim();
    if (!to) throw new NodeError("No recipients", { code: "no_recipient" });
    const text = typeof inputs.text === "string" ? inputs.text : config.text;
    const inReplyTo = config.inReplyTo?.trim() || undefined;
    const messageId = messageIdFor(ctx.idempotencyKey, credentials.data.fromAddress);

    const transport = smtpTransport(credentials.data);
    const onAbort = () => transport.close();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await transport.sendMail({
        from: credentials.data.fromAddress,
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
    return { exec: "next", outputs: { messageId } };
  },
};
