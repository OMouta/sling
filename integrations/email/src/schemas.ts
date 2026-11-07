import { z } from "zod";

const SERVERS = { step: "Mail servers" } as const;

const port = (fallback: number, title: string) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(fallback)
    .meta({ ...SERVERS, title, advanced: true });

const SERVER = { ...SERVERS, advanced: true, lookup: true } as const;

export const credentialsSchema = z.object({
  imapHost: z
    .string()
    .min(1)
    .meta({ ...SERVER, title: "IMAP server", order: 10 }),
  imapPort: port(993, "IMAP port").meta({ order: 11 }),
  imapSecure: z
    .boolean()
    .default(true)
    .meta({
      ...SERVERS,
      title: "IMAP over TLS",
      description: "Off for STARTTLS",
      advanced: true,
      order: 12,
    }),
  smtpHost: z
    .string()
    .min(1)
    .meta({ ...SERVER, title: "SMTP server", order: 13 }),
  smtpPort: port(465, "SMTP port").meta({ order: 14 }),
  smtpSecure: z
    .boolean()
    .default(true)
    .meta({
      ...SERVERS,
      title: "SMTP over TLS",
      description: "Off for STARTTLS",
      advanced: true,
      order: 15,
    }),
  username: z
    .string()
    .min(1)
    .meta({ ...SERVERS, title: "Login", advanced: true, order: 16 }),
  password: z.string().min(1).meta({ step: "Password", title: "Password", order: 1 }),
  fromAddress: z.string().min(3).meta({
    step: "Your email address",
    title: "Email address",
    placeholder: "you@example.com",
    lookup: true,
    order: 0,
  }),
});

export type EmailCredentials = z.infer<typeof credentialsSchema>;

export const configSchema = z.object({
  folders: z
    .array(z.string().min(1))
    .min(1)
    .default(["INBOX"])
    .meta({ ...SERVERS, title: "Folders to watch", advanced: true }),
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
