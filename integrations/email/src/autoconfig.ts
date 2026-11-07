/**
 * Finds a mailbox's IMAP and SMTP servers from its address, the way mail apps
 * do: a table of the big providers, then Thunderbird's provider database for
 * the domain, then the same database for whoever runs the domain's mail (its
 * MX records), which covers Google Workspace and Microsoft 365 domains.
 */
import { resolveMx } from "node:dns/promises";
import { XMLParser } from "fast-xml-parser";

export interface Server {
  host: string;
  port: number;
  /** TLS from the start. False means STARTTLS. */
  secure: boolean;
}

export interface MailServers {
  /** Who runs it, when known, such as Gmail. */
  provider: string | null;
  imap: Server;
  smtp: Server;
  /** The login: the whole address, or only the part before the @. */
  login: "address" | "local";
  /** Where to make an app password, for providers that need one. */
  appPassword?: { label: string; url: string };
  /** Why the connector can't log in here, for providers that refuse passwords. */
  unsupported?: string;
}

const tls = (host: string, port: number): Server => ({ host, port, secure: true });
const starttls = (host: string, port: number): Server => ({ host, port, secure: false });

const GMAIL: MailServers = {
  provider: "Gmail",
  imap: tls("imap.gmail.com", 993),
  smtp: tls("smtp.gmail.com", 465),
  login: "address",
  appPassword: {
    label: "Gmail needs an app password.",
    url: "https://myaccount.google.com/apppasswords",
  },
};
const MICROSOFT =
  "Microsoft no longer accepts passwords over IMAP and SMTP, so this mailbox can't be added.";
const OUTLOOK: MailServers = {
  provider: "Outlook",
  imap: tls("outlook.office365.com", 993),
  smtp: starttls("smtp-mail.outlook.com", 587),
  login: "address",
  unsupported: MICROSOFT,
};
const MICROSOFT_365: MailServers = {
  provider: "Microsoft 365",
  imap: tls("outlook.office365.com", 993),
  smtp: starttls("smtp.office365.com", 587),
  login: "address",
  unsupported: MICROSOFT,
};
const ICLOUD: MailServers = {
  provider: "iCloud Mail",
  imap: tls("imap.mail.me.com", 993),
  smtp: starttls("smtp.mail.me.com", 587),
  login: "address",
  appPassword: {
    label: "iCloud needs an app-specific password.",
    url: "https://account.apple.com/account/manage",
  },
};
const FASTMAIL: MailServers = {
  provider: "Fastmail",
  imap: tls("imap.fastmail.com", 993),
  smtp: tls("smtp.fastmail.com", 465),
  login: "address",
  appPassword: {
    label: "Fastmail needs an app password.",
    url: "https://app.fastmail.com/settings/security/apps",
  },
};
const YAHOO: MailServers = {
  provider: "Yahoo Mail",
  imap: tls("imap.mail.yahoo.com", 993),
  smtp: tls("smtp.mail.yahoo.com", 465),
  login: "address",
  appPassword: {
    label: "Yahoo needs an app password.",
    url: "https://login.yahoo.com/account/security",
  },
};

/** The domains people type most, so they never wait on a lookup. */
export const KNOWN: Record<string, MailServers> = {
  "gmail.com": GMAIL,
  "googlemail.com": GMAIL,
  "outlook.com": OUTLOOK,
  "hotmail.com": OUTLOOK,
  "live.com": OUTLOOK,
  "msn.com": OUTLOOK,
  "icloud.com": ICLOUD,
  "me.com": ICLOUD,
  "mac.com": ICLOUD,
  "fastmail.com": FASTMAIL,
  "fastmail.fm": FASTMAIL,
  "yahoo.com": YAHOO,
  "ymail.com": YAHOO,
};

/** Who runs a domain's mail, by the registrable part of its MX host. */
const BY_MX: Record<string, MailServers> = {
  "google.com": { ...GMAIL, provider: "Google Workspace" },
  "googlemail.com": { ...GMAIL, provider: "Google Workspace" },
  "outlook.com": MICROSOFT_365,
  "messagingengine.com": FASTMAIL,
  "icloud.com": ICLOUD,
};

export const ISPDB_URL = "https://autoconfig.thunderbird.net/v1.1/";
const LOOKUP_TIMEOUT_MS = 4_000;
const CACHE_MS = 60 * 60_000;
const MISS_CACHE_MS = 5 * 60_000;

export interface AutoconfigDeps {
  fetch: typeof fetch;
  resolveMx: (domain: string) => Promise<{ exchange: string; priority: number }[]>;
}

const defaults: AutoconfigDeps = { fetch: (...a) => fetch(...a), resolveMx };

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });

function list<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

type XmlServer = {
  "@type"?: string;
  hostname?: string;
  port?: number | string;
  socketType?: string;
  username?: string;
};

function serverFrom(all: XmlServer[], type: string): (Server & { username?: string }) | null {
  // Prefer TLS, then STARTTLS; never plain text.
  const ranked = all
    .filter((s) => s["@type"] === type && s.hostname && s.port)
    .filter((s) => s.socketType === "SSL" || s.socketType === "STARTTLS")
    .sort((a, b) => (a.socketType === "SSL" ? 0 : 1) - (b.socketType === "SSL" ? 0 : 1));
  const s = ranked[0];
  if (!s?.hostname) return null;
  return {
    host: String(s.hostname),
    port: Number(s.port),
    secure: s.socketType === "SSL",
    ...(s.username ? { username: String(s.username) } : {}),
  };
}

/** Reads a Thunderbird autoconfig document. Null when it has no usable IMAP and SMTP servers. */
export function parseAutoconfig(xml: string): MailServers | null {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  const provider = (doc as { clientConfig?: { emailProvider?: Record<string, unknown> } })
    .clientConfig?.emailProvider;
  if (!provider) return null;
  const imap = serverFrom(list(provider.incomingServer as XmlServer | XmlServer[]), "imap");
  const smtp = serverFrom(list(provider.outgoingServer as XmlServer | XmlServer[]), "smtp");
  if (!imap || !smtp) return null;
  const name = provider.displayShortName ?? provider.displayName;
  return {
    provider: typeof name === "string" ? name : null,
    imap: { host: imap.host, port: imap.port, secure: imap.secure },
    smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure },
    login: imap.username === "%EMAILLOCALPART%" ? "local" : "address",
  };
}

async function ispdb(
  domain: string,
  deps: AutoconfigDeps,
  signal: AbortSignal,
): Promise<MailServers | null> {
  try {
    const res = await deps.fetch(`${ISPDB_URL}${encodeURIComponent(domain)}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]),
      redirect: "error",
    });
    if (!res.ok) return null;
    return parseAutoconfig(await res.text());
  } catch {
    return null;
  }
}

/** "aspmx.l.google.com" → "google.com". Two labels is enough for the hosts that matter here. */
function baseDomain(host: string): string {
  return host.replace(/\.$/, "").split(".").slice(-2).join(".").toLowerCase();
}

async function viaMx(
  domain: string,
  deps: AutoconfigDeps,
  signal: AbortSignal,
): Promise<MailServers | null> {
  let records: { exchange: string; priority: number }[];
  try {
    records = await Promise.race([
      deps.resolveMx(domain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), LOOKUP_TIMEOUT_MS),
      ),
    ]);
  } catch {
    return null;
  }
  const first = [...records].sort((a, b) => a.priority - b.priority)[0];
  if (!first?.exchange) return null;
  const base = baseDomain(first.exchange);
  const known = BY_MX[base];
  if (known) return known;
  return base === domain ? null : ispdb(base, deps, signal);
}

const cache = new Map<string, { at: number; value: MailServers | null }>();

/** The domain of an address such as `you@example.com` or `You <you@example.com>`. */
export function addressOf(value: unknown): { address: string; domain: string } | null {
  if (typeof value !== "string") return null;
  const inner = /<([^>]+)>/.exec(value)?.[1] ?? value;
  const m = /^\s*([^@\s<>]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\s*$/i.exec(inner);
  if (!m?.[1] || !m[2]) return null;
  return { address: `${m[1]}@${m[2]}`, domain: m[2].toLowerCase() };
}

export async function findServers(
  domain: string,
  signal: AbortSignal,
  deps: AutoconfigDeps = defaults,
): Promise<MailServers | null> {
  const known = KNOWN[domain];
  if (known) return known;
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < (hit.value ? CACHE_MS : MISS_CACHE_MS)) return hit.value;
  const value = (await ispdb(domain, deps, signal)) ?? (await viaMx(domain, deps, signal));
  if (!signal.aborted) cache.set(domain, { at: Date.now(), value });
  return value;
}

/** Forgets every lookup. For tests. */
export function clearAutoconfigCache(): void {
  cache.clear();
}
