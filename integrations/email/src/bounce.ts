/**
 * Whether a sent email came back. Bounces land in the sender's inbox, and
 * every kind seen in practice quotes the original's Message-ID: a delivery
 * status report (RFC 3464) attaches its headers, and the older free-form
 * notices from mail servers quote the message. So the check reads what in
 * the inbox names that ID, and the reports and notices that came since.
 */
import type { VerifyResult } from "@sling/connector-sdk";
import type { ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import { mailboxError, withFolder } from "./mailbox.ts";
import type { EmailCredentials } from "./schemas.ts";

/** How long a send is watched for a bounce. */
export const BOUNCE_WATCH_MS = 10 * 60_000;
/** Search hits read at most per check, newest first. */
const MAX_CANDIDATES = 20;
/** Bytes of a candidate downloaded at most. Reports are small; the original may be attached whole. */
const CANDIDATE_BYTES = 2 * 1024 * 1024;

export interface DeliveryStatus {
  recipient: string | null;
  action: string;
  status: string | null;
  diagnostic: string | null;
}

export interface Bounce {
  kind: "failed" | "delayed";
  recipient: string | null;
  reason: string;
}

/** A Message-ID without its angle brackets, the way it's searched for. */
export function bareId(messageId: string): string {
  return messageId.trim().replace(/^<|>$/g, "");
}

/**
 * The per-recipient blocks of a `message/delivery-status` part. Fields can
 * be folded over several lines, and blocks are separated by blank lines.
 */
export function parseDeliveryStatus(text: string): DeliveryStatus[] {
  const blocks = text
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]+/g, " ")
    .split(/\n\s*\n/);
  const out: DeliveryStatus[] = [];
  for (const block of blocks) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (m?.[1]) fields.set(m[1].toLowerCase(), (m[2] ?? "").trim());
    }
    const action = fields.get("action")?.toLowerCase();
    if (!action) continue;
    const recipient = fields.get("final-recipient") ?? fields.get("original-recipient") ?? null;
    out.push({
      recipient: recipient ? recipient.replace(/^[^;]*;\s*/, "") : null,
      action,
      status: fields.get("status") ?? null,
      diagnostic: fields.get("diagnostic-code") ?? null,
    });
  }
  return out;
}

/** What the commonest status codes mean, in a few words. */
const STATUS_REASON: [RegExp, string][] = [
  [/^5\.1\.1$/, "mailbox not found"],
  [/^5\.1\.10$/, "the address doesn't take mail"],
  [/^5\.1\.[23]$/, "bad address"],
  [/^5\.2\.1$/, "mailbox disabled"],
  [/^[45]\.2\.2$/, "mailbox full"],
  [/^5\.4\.[14]$/, "the address's domain wasn't found"],
  [/^5\.3\.4$/, "message too big"],
  [/^5\.7\.\d+$/, "refused by the recipient's mail server"],
];

/** A diagnostic as a person reads it: no `smtp;` prefix, one line, not too long. */
function cleanDiagnostic(text: string): string {
  const line = text
    .replace(/^\s*[\w-]+\s*;\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function reasonOf(status: string | null, diagnostic: string | null): string {
  const code = status?.match(/\d\.\d{1,3}\.\d{1,3}/)?.[0] ?? null;
  const known = code ? STATUS_REASON.find(([re]) => re.test(code))?.[1] : undefined;
  if (known) return known;
  if (diagnostic?.trim()) return cleanDiagnostic(diagnostic);
  return code ? `status ${code}` : "the recipient's mail server refused it";
}

const NOTICE_SENDER = /mailer-daemon|postmaster|mail delivery (sub)?system/i;
const NOTICE_SUBJECT =
  /undeliver|delivery (status )?notification|failure notice|returned mail|delivery fail|could not be delivered|not delivered|mail delivery failed/i;
/** A line in a free-form notice that says why: an SMTP reply or a status code. */
const NOTICE_REASON = /\b[45]\d\d[ -][45]?\.?\d?\.?\d?\b.*|\b[45]\.\d{1,3}\.\d{1,3}\b.*/;

/**
 * What a message says about a send, when it's a bounce: a delivery status
 * report with a failed or delayed recipient, or a mail server's free-form
 * notice. Null for anything else, a delivered report included.
 */
export function bounceIn(parsed: ParsedMail): Bounce | null {
  const report = deliveryStatusText(parsed);
  if (report !== null) {
    const statuses = parseDeliveryStatus(report);
    const failed = statuses.find((s) => s.action === "failed");
    if (failed) {
      return {
        kind: "failed",
        recipient: failed.recipient,
        reason: reasonOf(failed.status, failed.diagnostic),
      };
    }
    const delayed = statuses.find((s) => s.action === "delayed");
    if (delayed) {
      return {
        kind: "delayed",
        recipient: delayed.recipient,
        reason: reasonOf(delayed.status, delayed.diagnostic),
      };
    }
    // Delivered, relayed, or expanded: the report says it arrived.
    return null;
  }
  const from = `${parsed.from?.text ?? ""}`;
  if (!NOTICE_SENDER.test(from) && !NOTICE_SUBJECT.test(parsed.subject ?? "")) return null;
  const line = (parsed.text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => NOTICE_REASON.test(l));
  const status = line?.match(/\b[45]\.\d{1,3}\.\d{1,3}\b/)?.[0] ?? null;
  return { kind: "failed", recipient: null, reason: reasonOf(status, line ?? null) };
}

/**
 * The delivery status fields of a report. mailparser reads the
 * `message/delivery-status` part into the text, so a report is known by its
 * top-level type, and its fields are read from there.
 */
function deliveryStatusText(parsed: ParsedMail): string | null {
  const part = parsed.attachments.find((a) =>
    /^message\/(global-)?delivery-status$/i.test(a.contentType),
  );
  if (part) return part.content.toString("utf8");
  const type = parsed.headers.get("content-type") as
    | { value?: string; params?: Record<string, string> }
    | undefined;
  const isReport =
    type?.value?.toLowerCase() === "multipart/report" &&
    /delivery-status/i.test(type.params?.["report-type"] ?? "");
  return isReport ? (parsed.text ?? "") : null;
}

function dayBefore(ms: number): string {
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

/** The newest bounce in the inbox that names the message, failed ones first. */
export async function findBounce(
  credentials: EmailCredentials,
  messageId: string,
  sentAtMs: number,
  signal: AbortSignal,
): Promise<Bounce | null> {
  const id = bareId(messageId);
  return withFolder(credentials, "INBOX", signal, async (client: ImapFlow) => {
    // SINCE is by day, in the server's zone, so start a day early.
    const since = dayBefore(sentAtMs);
    // Not every server searches the headers a report attaches, so reports and
    // notices since the send are read too.
    const [named, notices] = await Promise.all([
      client.search({ text: id, since }, { uid: true }),
      client.search(
        {
          since,
          or: [
            { from: "mailer-daemon" },
            { from: "postmaster" },
            { header: { "content-type": "report" } },
          ],
        },
        { uid: true },
      ),
    ]);
    const all = [
      ...(Array.isArray(named) ? named : []),
      ...(Array.isArray(notices) ? notices : []),
    ];
    const uids = [...new Set(all)].sort((a, b) => b - a);
    let delayed: Bounce | null = null;
    for (const uid of uids.slice(0, MAX_CANDIDATES)) {
      const m =
        (await client.fetchOne(
          String(uid),
          { uid: true, source: { maxLength: CANDIDATE_BYTES } },
          { uid: true },
        )) || null;
      // Some servers match words loosely; only a message that holds the whole ID counts.
      if (!m?.source?.includes(id)) continue;
      let parsed: ParsedMail;
      try {
        parsed = await simpleParser(m.source, { skipTextToHtml: true, skipTextLinks: true });
      } catch {
        continue;
      }
      // The message itself, when it was sent to this mailbox.
      if (parsed.messageId && bareId(parsed.messageId) === id) continue;
      const bounce = bounceIn(parsed);
      if (bounce?.kind === "failed") return bounce;
      if (bounce) delayed ??= bounce;
    }
    return delayed;
  });
}

export interface SentEmail {
  messageId: string;
  /** When it went out, epoch milliseconds. */
  sentAtMs: number;
  /** How many addresses it went to, so a bounce says which one when there were several. */
  recipients: number;
}

/**
 * The check after a send: failed when a bounce names it, waiting while the
 * watch lasts, and passed once it's over with none.
 */
export async function checkSend(
  credentials: EmailCredentials,
  sent: SentEmail,
  opts: {
    now: number;
    attempt: number;
    signal: AbortSignal;
    find?: typeof findBounce;
  },
): Promise<VerifyResult> {
  const elapsed = opts.now - sent.sentAtMs;
  const over = elapsed >= BOUNCE_WATCH_MS;
  // Bounces mostly come back within a minute; look often at first, then less.
  const retryAfterSeconds = Math.max(
    5,
    Math.min(30 * opts.attempt, 120, Math.ceil((BOUNCE_WATCH_MS - elapsed) / 1000)),
  );
  let bounce: Bounce | null;
  try {
    bounce = await (opts.find ?? findBounce)(
      credentials,
      sent.messageId,
      sent.sentAtMs,
      opts.signal,
    );
  } catch (error) {
    if (over) {
      return {
        state: "unchecked",
        message: `Couldn't look for a bounce: ${mailboxError(error)}`,
      };
    }
    return { state: "waiting", message: "Watching for a bounce", retryAfterSeconds };
  }
  if (bounce?.kind === "failed") {
    const who = sent.recipients > 1 && bounce.recipient ? ` for ${bounce.recipient}` : "";
    return { state: "failed", message: `Bounced${who}: ${bounce.reason}` };
  }
  const minutes = Math.round(BOUNCE_WATCH_MS / 60_000);
  if (over) {
    return {
      state: "passed",
      message: bounce
        ? `Delayed by the recipient's server, but no bounce after ${minutes} minutes`
        : `No bounce after ${minutes} minutes`,
    };
  }
  return {
    state: "waiting",
    message: bounce ? `Delayed: ${bounce.reason}` : "Watching for a bounce",
    retryAfterSeconds,
  };
}
