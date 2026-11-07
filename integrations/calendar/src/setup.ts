/**
 * The calendar's setup lookup: the CalDAV server from the address, the
 * account's calendars once the password is in, and a name for each iCal link
 * from the calendar it serves.
 */
import { resolveSrv, resolveTxt } from "node:dns/promises";
import type { SetupNote, SetupResult } from "@sling/connector-sdk";
import { discover } from "./caldav.ts";
import type { FeedCache } from "./feeds.ts";
import { errorMessage } from "./http.ts";
import type { CalendarConfig, CalendarCredentials } from "./schemas.ts";

interface Provider {
  name: string;
  /** The CalDAV server. Missing for providers that only publish iCal links. */
  serverUrl?: string;
  appPassword?: { text: string; url: string };
  /** Said instead, for providers without CalDAV. */
  icalOnly?: { text: string; url: string };
}

const ICLOUD: Provider = {
  name: "iCloud",
  serverUrl: "https://caldav.icloud.com",
  appPassword: {
    text: "iCloud needs an app-specific password.",
    url: "https://account.apple.com/account/manage",
  },
};
const FASTMAIL: Provider = {
  name: "Fastmail",
  serverUrl: "https://caldav.fastmail.com",
  appPassword: {
    text: "Fastmail needs an app password with calendar access.",
    url: "https://app.fastmail.com/settings/security/apps",
  },
};
const GOOGLE: Provider = {
  name: "Google Calendar",
  icalOnly: {
    text: "Google Calendar works through its secret iCal link. Pick iCal link above.",
    url: "https://calendar.google.com/calendar/r/settings",
  },
};
const OUTLOOK: Provider = {
  name: "Outlook",
  icalOnly: {
    text: "Outlook works through a published iCal link. Pick iCal link above.",
    url: "https://outlook.live.com/calendar/0/options/calendar/SharedCalendars",
  },
};
const YAHOO: Provider = {
  name: "Yahoo",
  serverUrl: "https://caldav.calendar.yahoo.com",
  appPassword: {
    text: "Yahoo needs an app password.",
    url: "https://login.yahoo.com/account/security",
  },
};

export const PROVIDERS: Record<string, Provider> = {
  "icloud.com": ICLOUD,
  "me.com": ICLOUD,
  "mac.com": ICLOUD,
  "fastmail.com": FASTMAIL,
  "fastmail.fm": FASTMAIL,
  "gmail.com": GOOGLE,
  "googlemail.com": GOOGLE,
  "outlook.com": OUTLOOK,
  "hotmail.com": OUTLOOK,
  "live.com": OUTLOOK,
  "yahoo.com": YAHOO,
};

const LOOKUP_TIMEOUT_MS = 3_000;

export interface SetupDeps {
  resolveSrv: (name: string) => Promise<{ name: string; port: number; priority: number }[]>;
  resolveTxt: (name: string) => Promise<string[][]>;
  discover: typeof discover;
}

const defaults: SetupDeps = { resolveSrv, resolveTxt, discover };

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), LOOKUP_TIMEOUT_MS),
    ),
  ]);
}

/** A domain's CalDAV server from its DNS, the way calendar apps find one. */
async function fromDns(domain: string, deps: SetupDeps): Promise<string | null> {
  try {
    const records = await withTimeout(deps.resolveSrv(`_caldavs._tcp.${domain}`));
    const best = [...records].sort((a, b) => a.priority - b.priority)[0];
    if (!best?.name || best.name === ".") return null;
    let path = "";
    try {
      const txt = (await withTimeout(deps.resolveTxt(`_caldavs._tcp.${domain}`))).flat().join("");
      path = /path=(\S+)/.exec(txt)?.[1] ?? "";
    } catch {
      // No path: the server answers at its root or its well-known address.
    }
    const port = best.port === 443 ? "" : `:${best.port}`;
    return `https://${best.name.replace(/\.$/, "")}${port}${path.startsWith("/") ? path : ""}`;
  } catch {
    return null;
  }
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** The calendar's own name in a feed, such as "Work". */
function feedName(calendars: { getFirstPropertyValue(name: string): unknown }[]): string | null {
  for (const c of calendars) {
    const v = c.getFirstPropertyValue("x-wr-calname");
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export async function calendarSetup(
  credentials: Partial<CalendarCredentials>,
  config: Partial<CalendarConfig>,
  feeds: FeedCache,
  signal: AbortSignal,
  deps: SetupDeps = defaults,
): Promise<SetupResult<CalendarCredentials, CalendarConfig>> {
  if ((config.kind ?? "caldav") === "ics") {
    const urls = (credentials.feedUrls ?? []).filter((u) => u.trim());
    if (urls.length === 0) return {};
    const read = await Promise.all(
      urls.map(async (url) => {
        try {
          return { name: feedName((await feeds.get(url, signal)).calendars), error: null };
        } catch (err) {
          return { name: null, error: errorMessage(err) };
        }
      }),
    );
    const old = config.feedNames ?? [];
    const feedNames = read.map((r, i) => r.name ?? old[i] ?? "");
    const notes: SetupNote[] = read.flatMap((r) =>
      r.error ? [{ field: "feedUrls", tone: "error" as const, text: r.error }] : [],
    );
    const named = feedNames.filter(Boolean);
    return {
      config: { feedNames },
      name: named.length === 1 ? (named[0] as string) : "Calendar",
      ...(notes.length > 0
        ? { notes }
        : named.length > 0
          ? { notes: [{ field: "feedUrls", tone: "ok", text: named.join(", ") }] }
          : {}),
    };
  }

  const username = (config.username ?? "").trim();
  if (!username) return {};
  const domain = /@([^@\s]+\.[a-z]{2,})$/i.exec(username)?.[1]?.toLowerCase() ?? null;
  const provider = domain ? PROVIDERS[domain] : undefined;
  if (provider?.icalOnly) {
    return {
      notes: [
        {
          field: "username",
          tone: "warn",
          text: provider.icalOnly.text,
          link: { label: "Find it", url: provider.icalOnly.url },
        },
      ],
    };
  }

  const out: SetupResult<CalendarCredentials, CalendarConfig> = {
    name: provider ? `${provider.name} calendar` : username,
    notes: [],
  };
  const notes = out.notes as SetupNote[];
  let serverUrl = (config.serverUrl ?? "").trim();
  if (!serverUrl) {
    const found = provider?.serverUrl ?? (domain ? await fromDns(domain, deps) : null);
    if (!found) {
      out.reveal = ["serverUrl"];
      notes.push({
        field: "username",
        tone: "warn",
        text: domain
          ? `Couldn't find the calendar server for ${domain}. Fill it in below.`
          : "Fill in the calendar server below.",
      });
      return out;
    }
    serverUrl = found;
    out.config = { serverUrl };
  }
  if (provider) notes.push({ field: "username", tone: "ok", text: provider.name });
  if (provider?.appPassword) {
    notes.push({
      field: "password",
      tone: "info",
      text: provider.appPassword.text,
      link: { label: "Make one", url: provider.appPassword.url },
    });
  }

  const password = credentials.password ?? "";
  if (!password) return out;
  try {
    const calendars = await deps.discover({ serverUrl, username, password }, signal);
    if (calendars.length === 0) {
      notes.push({
        field: "password",
        tone: "warn",
        text: "Signed in, but there are no calendars.",
      });
      return out;
    }
    const options = calendars.map((c) => ({ value: c.name, label: c.name }));
    out.options = { calendars: options, defaultCalendar: options };
    if (!config.defaultCalendar) {
      out.config = { ...out.config, defaultCalendar: calendars[0]?.name ?? "" };
    }
    // The picker showing up says it worked; a provider's name is enough above it.
    if (!provider) {
      notes.push({
        field: "password",
        tone: "ok",
        text: `Signed in. ${plural(calendars.length, "calendar")}.`,
      });
    }
  } catch (err) {
    // A login that fails says so here, before Add would.
    notes.push({ field: "password", tone: "error", text: errorMessage(err) });
  }
  return out;
}
