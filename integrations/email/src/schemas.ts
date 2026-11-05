import { z } from "zod";

const port = (fallback: number, help: string) =>
  z.coerce.number().int().min(1).max(65535).default(fallback).describe(help);

export const credentialsSchema = z.object({
  imapHost: z
    .string()
    .min(1)
    .describe("IMAP server for reading mail, for example imap.gmail.com or imap.fastmail.com"),
  imapPort: port(993, "IMAP port. 993 is IMAP over TLS"),
  imapSecure: z
    .boolean()
    .default(true)
    .describe("Use TLS from the start. Turn off only for port 143, which upgrades with STARTTLS"),
  smtpHost: z
    .string()
    .min(1)
    .describe("SMTP server for sending mail, for example smtp.gmail.com or smtp.fastmail.com"),
  smtpPort: port(465, "SMTP port. 465 is SMTP over TLS"),
  smtpSecure: z
    .boolean()
    .default(true)
    .describe("Use TLS from the start. Turn off only for port 587, which upgrades with STARTTLS"),
  username: z.string().min(1).describe("Login for both servers, usually your full email address"),
  password: z
    .string()
    .min(1)
    .describe("An app password for this mailbox. Gmail and Fastmail don't accept your normal one"),
  fromAddress: z
    .string()
    .min(3)
    .describe("Address mail is sent from, like you@example.com or Sling <you@example.com>"),
});

export type EmailCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z.object({
  folders: z
    .array(z.string().min(1))
    .min(1)
    .default(["INBOX"])
    .describe(
      "IMAP folders to watch for new mail. An Email received trigger fires only for one of these.",
    ),
});

export type EmailConfig = z.infer<typeof configSchema>;

export interface EmailAddress {
  name: string | null;
  address: string;
}

/** The `email` named type. */
export interface Email {
  id: string;
  messageId: string | null;
  folder: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  date: string;
  text: string;
  html: string | null;
  inReplyTo: string | null;
}

export const RECEIVED_EVENT = "email.received";
export const CONNECTOR_ID = "email";
