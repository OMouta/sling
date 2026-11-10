import { ImapFlow, type ImapFlowOptions } from "imapflow";
import nodemailer from "nodemailer";
import type { EmailCredentials } from "./schemas.ts";

/** Hosts on this machine, where a cleartext login never crosses a network. */
export function isLoopback(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h);
}

/** Without direct TLS, the login must wait for STARTTLS unless the server is on this machine. */
function mustUpgrade(secure: boolean, host: string): boolean {
  return !secure && !isLoopback(host);
}

export function imapClient(
  credentials: EmailCredentials,
  extra: Partial<ImapFlowOptions> = {},
): ImapFlow {
  return new ImapFlow({
    host: credentials.imapHost,
    port: credentials.imapPort,
    secure: credentials.imapSecure,
    ...(mustUpgrade(credentials.imapSecure, credentials.imapHost) ? { doSTARTTLS: true } : {}),
    auth: { user: credentials.username, pass: credentials.password },
    logger: false,
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    ...extra,
  });
}

export function smtpTransport(credentials: EmailCredentials) {
  return nodemailer.createTransport({
    host: credentials.smtpHost,
    port: credentials.smtpPort,
    secure: credentials.smtpSecure,
    requireTLS: mustUpgrade(credentials.smtpSecure, credentials.smtpHost),
    auth: { user: credentials.username, pass: credentials.password },
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

/** Logs out politely, but never waits more than `ms` for the server. */
export async function closeImap(client: ImapFlow, ms = 2_000): Promise<void> {
  if (client.usable) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      client.logout().catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    clearTimeout(timer);
  }
  client.close();
}

/** IMAP login failures carry the server's reason on the error. */
export function imapErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const e = error as Error & { authenticationFailed?: boolean; responseText?: string };
  if (e.authenticationFailed) {
    const reason = e.responseText ? ` (${e.responseText})` : "";
    return `IMAP login failed${reason}. Check the username, and use an app password if your provider requires one.`;
  }
  return e.responseText ? `${e.message}: ${e.responseText}` : e.message;
}
