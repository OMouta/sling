/**
 * How an allow rule's pinned values match a call's arguments, and how a
 * card's Always allow turns one call into a rule. Pure, so matching costs
 * microseconds and is easy to test.
 *
 * A pinned value is a comma-separated list of alternatives. Each one matches
 * exactly, or as a suffix when it starts with one `*`, such as `*@acme.com`.
 * A call's value matches when every comma-separated part of it matches one
 * alternative, so an email to two people goes through only when both are
 * covered. An empty pinned value matches only an empty or missing argument.
 * Case doesn't matter, and `Name <a@b.c>` counts as `a@b.c`.
 */

/** Mail providers where `*@domain` would cover strangers, so a rule pins the address instead. */
const PUBLIC_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "tuta.io",
  "web.de",
  "sapo.pt",
  "qq.com",
  "163.com",
]);
/** Providers with a domain per country, such as yahoo.co.uk. */
const PUBLIC_MAIL_PREFIXES = ["yahoo.", "hotmail.", "outlook.", "live.", "gmx."];

/** Most alternatives one pinned value may list. */
const MAX_ALTERNATIVES = 50;

/** An argument as text, for matching. */
export function argText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(argText).filter(Boolean).join(", ");
  return JSON.stringify(v);
}

/** One part, trimmed, and the address out of `Name <address>`. */
function clean(part: string): string {
  const t = part.trim();
  const angled = /<([^<>]+)>\s*$/.exec(t);
  return (angled?.[1] ?? t).trim();
}

/** The parts as written, each once, whatever their case. */
function cleanParts(text: string): string[] {
  const seen = new Map<string, string>();
  for (const p of text.split(",").map(clean)) {
    if (p && !seen.has(p.toLowerCase())) seen.set(p.toLowerCase(), p);
  }
  return [...seen.values()];
}

/** The parts as they're compared: in lower case. */
function parts(text: string): string[] {
  return cleanParts(text).map((p) => p.toLowerCase());
}

function alternativeMatches(alt: string, part: string): boolean {
  if (alt.startsWith("*")) {
    const suffix = alt.slice(1);
    return part.length > suffix.length && part.endsWith(suffix);
  }
  return alt === part;
}

/** Whether a call's argument matches one pinned value. */
export function valueMatches(pattern: string, value: unknown): boolean {
  const alternatives = parts(pattern);
  const got = parts(argText(value));
  if (alternatives.length === 0) return got.length === 0;
  if (got.length === 0) return false;
  return got.every((p) => alternatives.some((a) => alternativeMatches(a, p)));
}

/** Whether every pinned value matches. Arguments a rule doesn't pin are free. */
export function matchesAll(match: Record<string, string>, args: Record<string, unknown>): boolean {
  for (const [field, pattern] of Object.entries(match)) {
    if (!valueMatches(pattern, args[field])) return false;
  }
  return true;
}

/** Why a pinned value can't be used, or null when it can. */
export function patternError(pattern: string): string | null {
  const alternatives = parts(pattern);
  if (alternatives.length > MAX_ALTERNATIVES) {
    return `A pinned value lists at most ${MAX_ALTERNATIVES} alternatives.`;
  }
  for (const a of alternatives) {
    if (a.slice(1).includes("*")) {
      return `"${a}" can only have a * at the start, such as *@acme.com.`;
    }
    if (a === "*") return `"*" alone would match anything. Leave the field out instead.`;
  }
  return null;
}

/** A pinned value as stored: its alternatives, normalized, in a stable order. */
export function normalizePattern(pattern: string): string {
  return cleanParts(pattern).join(", ");
}

/** The domain of an email address, or null when it isn't one. */
function emailDomain(part: string): string | null {
  const m = /^[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/.exec(part);
  return m?.[1] ?? null;
}

function publicMail(domain: string): boolean {
  return PUBLIC_MAIL.has(domain) || PUBLIC_MAIL_PREFIXES.some((p) => domain.startsWith(p));
}

/**
 * What Always allow pins for one argument of this call. An email address at
 * a company domain widens to everyone there; anything else stays exact.
 */
export function offeredPattern(value: unknown): string {
  const out = cleanParts(argText(value)).map((p) => {
    const domain = emailDomain(p.toLowerCase());
    return domain && !publicMail(domain) ? `*@${domain}` : p;
  });
  return cleanParts(out.join(",")).join(", ");
}

/** A pinned value as words: "anyone at acme.com", "jo@silva.pt", or "anything ending in .pt". */
export function describePattern(pattern: string): string {
  const alternatives = cleanParts(pattern);
  const words = alternatives.map((a) => {
    if (!a.startsWith("*")) return a;
    const suffix = a.slice(1);
    return suffix.startsWith("@") ? `anyone at ${suffix.slice(1)}` : `anything ending in ${suffix}`;
  });
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}
