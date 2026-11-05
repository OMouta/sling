import { type AddressObject, type EmailAddress as ParsedAddress, simpleParser } from "mailparser";
import type { Email, EmailAddress } from "./schemas.ts";

/** Longest text or HTML body kept, in UTF-8 bytes. Workflow runs store their inputs. */
export const BODY_LIMIT = 200 * 1024;

/** HTML longer than this isn't converted to text; converting huge newsletters is slow. */
const HTML_TO_TEXT_LIMIT = 2 * 1024 * 1024;

/** Cuts a string to at most `limit` UTF-8 bytes without splitting a character. */
export function capBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  return Buffer.from(text, "utf8").subarray(0, limit).toString("utf8").replace(/�+$/, "");
}

function flatten(entries: ParsedAddress[]): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const entry of entries) {
    if (entry.group) out.push(...flatten(entry.group));
    else if (entry.address) out.push({ name: entry.name || null, address: entry.address });
  }
  return out;
}

function addresses(header: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!header) return [];
  const list = Array.isArray(header) ? header : [header];
  return list.flatMap((h) => flatten(h.value));
}

function validDate(value: Date | string | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parses a raw RFC 822 message into the `email` type. */
export async function parseEmail(
  source: Buffer | string,
  meta: { id: string; folder: string; internalDate?: Date | string },
): Promise<Email> {
  const parsed = await simpleParser(source, {
    // Leaving cid: links alone keeps inline images out of the HTML as data URLs.
    keepCidLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    maxHtmlLengthToParse: HTML_TO_TEXT_LIMIT,
  });
  const date = validDate(parsed.date) ?? validDate(meta.internalDate) ?? new Date();
  return {
    id: meta.id,
    messageId: parsed.messageId ?? null,
    folder: meta.folder,
    from: addresses(parsed.from)[0] ?? { name: null, address: "" },
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: parsed.subject ?? "",
    date: date.toISOString(),
    // mailparser fills `text` from the HTML when there's no plain text part.
    text: capBytes(parsed.text ?? "", BODY_LIMIT),
    html: typeof parsed.html === "string" ? capBytes(parsed.html, BODY_LIMIT) : null,
    inReplyTo: parsed.inReplyTo ?? null,
  };
}
