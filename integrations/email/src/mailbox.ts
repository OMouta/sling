/// <reference path="./html-to-text.d.ts" />
/**
 * Searching and reading a mailbox over IMAP, for the assistant and for the
 * checks that watch it. Folders open read-only, so nothing is marked read.
 */
import { NodeError } from "@sling/connector-sdk";
import { htmlToText } from "html-to-text";
import type { ImapFlow, ListResponse, SearchObject } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import { errorMessage } from "./backoff.ts";
import { closeImap, imapClient, imapErrorMessage } from "./clients.ts";
import { capBytes } from "./parse.ts";
import type { EmailAddress, EmailCredentials } from "./schemas.ts";
import { dedupeKey } from "./source.ts";

/** Most messages one search returns. */
export const MAX_RESULTS = 50;
/** Longest snippet, in characters. */
export const SNIPPET_CHARS = 200;
/** Longest body `readMessage` returns, in UTF-8 bytes. */
export const READ_TEXT_LIMIT = 20 * 1024;
/** Bytes of each search hit downloaded for its snippet. */
const SNIPPET_SOURCE_BYTES = 32 * 1024;
/** Bytes of a message downloaded at most to read it. */
const READ_SOURCE_BYTES = 10 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface MailQuery {
  /** INBOX when empty. A special folder's usual name, such as Sent, finds it however the server names it. */
  folder?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** Anywhere in the headers or the body. */
  text?: string;
  /** YYYY-MM-DD, on or after this day. */
  since?: string;
  /** YYYY-MM-DD, before this day. */
  before?: string;
  /** True for unread only, false for read only. */
  unread?: boolean;
  limit?: number;
}

export interface MailSummary {
  /** `folder:uidValidity:uid`, which `readMessage` takes. */
  id: string;
  messageId: string | null;
  /** The Message-ID this one answers, so a reply can be told from other mail. */
  inReplyTo: string | null;
  from: EmailAddress | null;
  to: EmailAddress[];
  subject: string;
  date: string;
  unread: boolean;
  snippet: string;
}

export interface SearchResult {
  folder: string;
  /** Newest first. */
  messages: MailSummary[];
  /** How many matched, which can be more than came back. */
  total: number;
}

export interface Attachment {
  name: string;
  size: number;
  contentType: string;
}

export interface MailMessage {
  id: string;
  messageId: string | null;
  folder: string;
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string;
  date: string;
  inReplyTo: string | null;
  unread: boolean;
  /** The plain text body, or the HTML's text when there's no plain part. */
  text: string;
  /** True when the text was cut to fit. */
  truncated: boolean;
  attachments: Attachment[];
}

/** A message ID from `searchMailbox`, split. Folder names may hold colons, so it's read from the right. */
export function parseMessageRef(id: string): { folder: string; uidValidity: string; uid: number } {
  const m = /^(.+):(\d+):(\d+)$/.exec(id.trim());
  const uid = Number(m?.[3]);
  if (!m?.[1] || !m[2] || !Number.isSafeInteger(uid) || uid < 1) {
    throw new NodeError(`${id} isn't a message ID. Use one that email.search returned.`, {
      code: "invalid_message_id",
    });
  }
  return { folder: m[1], uidValidity: m[2], uid };
}

/** IMAP's special-use flags, by the name people use for the folder. */
const SPECIAL: Record<string, string> = {
  sent: "\\Sent",
  "sent mail": "\\Sent",
  "sent items": "\\Sent",
  "sent messages": "\\Sent",
  drafts: "\\Drafts",
  draft: "\\Drafts",
  trash: "\\Trash",
  bin: "\\Trash",
  "deleted items": "\\Trash",
  junk: "\\Junk",
  spam: "\\Junk",
  archive: "\\Archive",
  "all mail": "\\All",
  all: "\\All",
  flagged: "\\Flagged",
  starred: "\\Flagged",
};

/**
 * The folder's path on the server: INBOX in any case, an exact path, a name
 * that differs only in case, or a special folder by its usual name.
 */
export function resolveFolder(name: string, list: Pick<ListResponse, "path" | "specialUse">[]) {
  const wanted = name.trim() || "INBOX";
  if (wanted.toUpperCase() === "INBOX") return "INBOX";
  const exact = list.find((f) => f.path === wanted);
  if (exact) return exact.path;
  const lower = wanted.toLowerCase();
  const loose = list.find((f) => f.path.toLowerCase() === lower);
  if (loose) return loose.path;
  const flag = SPECIAL[lower];
  const special = flag ? list.find((f) => f.specialUse === flag) : undefined;
  if (special) return special.path;
  const names = list
    .map((f) => f.path)
    .slice(0, 30)
    .join(", ");
  throw new NodeError(`There's no folder called ${wanted}. Folders: ${names || "none"}.`, {
    code: "no_folder",
  });
}

/** Connects, opens the folder read-only, runs `fn`, and logs out. */
export async function withFolder<T>(
  credentials: EmailCredentials,
  folder: string,
  signal: AbortSignal,
  fn: (client: ImapFlow, path: string, uidValidity: string) => Promise<T>,
): Promise<T> {
  const client = imapClient(credentials, {
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    disableAutoIdle: true,
  });
  let lastError: Error | null = null;
  client.on("error", (error: Error) => {
    lastError = error;
  });
  const onAbort = () => client.close();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    try {
      await client.connect();
    } catch (error) {
      throw new NodeError(`Couldn't sign in to the mailbox: ${imapErrorMessage(error)}`, {
        code: "imap_unavailable",
        retryable: true,
        cause: error,
      });
    }
    const wanted = folder.trim() || "INBOX";
    const path =
      wanted.toUpperCase() === "INBOX" ? "INBOX" : resolveFolder(wanted, await client.list());
    const box = await client.mailboxOpen(path, { readOnly: true });
    return await fn(client, path, String(box.uidValidity));
  } catch (error) {
    if (error instanceof NodeError) throw error;
    if (signal.aborted) throw new NodeError("Stopped", { code: "aborted", cause: error });
    throw new NodeError(`The mailbox failed: ${imapErrorMessage(lastError ?? error)}`, {
      code: "imap_failed",
      retryable: true,
      cause: error,
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
    await closeImap(client);
  }
}

function checkDate(value: string | undefined, field: string): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (!DATE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new NodeError(`${field} should be a date such as 2026-11-06.`, { code: "invalid_date" });
  }
  return v;
}

/** The IMAP search for a query. With nothing to narrow it, everything matches. */
export function searchCriteria(q: MailQuery): SearchObject {
  const out: SearchObject = {};
  const text = (v: string | undefined) => v?.trim() || undefined;
  const from = text(q.from);
  const to = text(q.to);
  const subject = text(q.subject);
  const body = text(q.text);
  if (from) out.from = from;
  if (to) out.to = to;
  if (subject) out.subject = subject;
  if (body) out.text = body;
  const since = checkDate(q.since, "since");
  const before = checkDate(q.before, "before");
  if (since) out.since = since;
  if (before) out.before = before;
  if (since && before && before <= since) {
    throw new NodeError("before has to be after since.", { code: "invalid_date" });
  }
  if (q.unread === true) out.seen = false;
  if (q.unread === false) out.seen = true;
  if (Object.keys(out).length === 0) out.all = true;
  return out;
}

function address(a: { name?: string; address?: string } | undefined): EmailAddress | null {
  return a?.address ? { name: a.name || null, address: a.address } : null;
}

function addresses(list: { name?: string; address?: string }[] | undefined): EmailAddress[] {
  return (list ?? []).map(address).filter((a): a is EmailAddress => a !== null);
}

function isoDate(...values: (Date | string | undefined)[]): string {
  for (const v of values) {
    if (!v) continue;
    const d = v instanceof Date ? v : new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(0).toISOString();
}

/** One line of a body, for a list of results. */
export function snippetOf(text: string, chars = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
}

/** Most HTML turned into text. Bigger newsletters keep only what fits. */
const HTML_TO_TEXT_CHARS = 512 * 1024;

/**
 * A message's text. mailparser converts HTML only when it's the whole
 * message, so an HTML body next to an attachment is converted here.
 */
export function textOf(parsed: ParsedMail): string {
  if (parsed.text?.trim()) return parsed.text;
  if (typeof parsed.html !== "string" || !parsed.html) return "";
  try {
    return htmlToText(parsed.html.slice(0, HTML_TO_TEXT_CHARS), {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      ],
    });
  } catch {
    return "";
  }
}

async function parseQuietly(source: Buffer): Promise<ParsedMail | null> {
  try {
    return await simpleParser(source, {
      keepCidLinks: true,
      skipTextToHtml: true,
      skipTextLinks: true,
      skipImageLinks: true,
    });
  } catch {
    return null;
  }
}

/** Messages in one folder that match, newest first, with a snippet of each. */
export async function searchMailbox(
  credentials: EmailCredentials,
  query: MailQuery,
  signal: AbortSignal,
): Promise<SearchResult> {
  const criteria = searchCriteria(query);
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 20)), MAX_RESULTS);
  return withFolder(credentials, query.folder ?? "", signal, async (client, path, validity) => {
    const found = await client.search(criteria, { uid: true });
    const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a);
    const wanted = uids.slice(0, limit);
    if (wanted.length === 0) return { folder: path, messages: [], total: 0 };
    const byUid = new Map<number, MailSummary>();
    for await (const m of client.fetch(
      wanted.join(","),
      {
        uid: true,
        envelope: true,
        internalDate: true,
        flags: true,
        source: { maxLength: SNIPPET_SOURCE_BYTES },
      },
      { uid: true },
    )) {
      const parsed = m.source ? await parseQuietly(m.source) : null;
      const env = m.envelope;
      byUid.set(m.uid, {
        id: dedupeKey(path, validity, m.uid),
        messageId: env?.messageId ?? null,
        inReplyTo: env?.inReplyTo ?? null,
        from: address(env?.from?.[0]),
        to: addresses(env?.to),
        subject: env?.subject ?? "",
        date: isoDate(env?.date, m.internalDate),
        unread: !m.flags?.has("\\Seen"),
        snippet: snippetOf(parsed ? textOf(parsed) : ""),
      });
    }
    // Newest first by UID, which is the order the folder received them in.
    const messages = wanted
      .map((uid) => byUid.get(uid))
      .filter((m): m is MailSummary => m !== undefined);
    return { folder: path, messages, total: uids.length };
  });
}

/** One message, with its text body and what's attached. */
export async function readMessage(
  credentials: EmailCredentials,
  id: string,
  signal: AbortSignal,
): Promise<MailMessage> {
  const ref = parseMessageRef(id);
  return withFolder(credentials, ref.folder, signal, async (client, path, validity) => {
    if (validity !== ref.uidValidity) {
      throw new NodeError(
        `The server renumbered ${path} since that search, so ${id} no longer points at a message. Search again.`,
        { code: "stale_message_id" },
      );
    }
    const m =
      (await client.fetchOne(
        String(ref.uid),
        {
          uid: true,
          envelope: true,
          internalDate: true,
          flags: true,
          source: { maxLength: READ_SOURCE_BYTES },
        },
        { uid: true },
      )) || null;
    if (!m?.source) {
      throw new NodeError(
        `There's no message ${id} in ${path}. It may have been moved or deleted.`,
        {
          code: "no_message",
        },
      );
    }
    const parsed = await parseQuietly(m.source);
    if (!parsed) {
      throw new NodeError(`Message ${id} couldn't be read.`, { code: "unreadable_message" });
    }
    const env = m.envelope;
    const full = textOf(parsed);
    const text = capBytes(full, READ_TEXT_LIMIT);
    const replyTo = parsed.replyTo?.value ?? [];
    return {
      id: dedupeKey(path, validity, m.uid),
      messageId: parsed.messageId ?? env?.messageId ?? null,
      folder: path,
      from: address(env?.from?.[0]),
      to: addresses(env?.to),
      cc: addresses(env?.cc),
      replyTo: addresses(replyTo),
      subject: env?.subject ?? parsed.subject ?? "",
      date: isoDate(env?.date, parsed.date, m.internalDate),
      inReplyTo: parsed.inReplyTo ?? null,
      unread: !m.flags?.has("\\Seen"),
      text,
      truncated: text.length < full.length,
      attachments: parsed.attachments
        .filter((a) => a.filename || a.contentDisposition === "attachment")
        .map((a) => ({
          name: a.filename ?? "(no name)",
          size: a.size,
          contentType: a.contentType,
        })),
    };
  });
}

/** For messages that come back to the person: why a mailbox step failed, in one line. */
export function mailboxError(error: unknown): string {
  return error instanceof NodeError ? error.message : errorMessage(error);
}
