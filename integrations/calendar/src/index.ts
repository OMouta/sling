import { type ConnectorDefinition, defineConnector, type TestResult } from "@sling/connector-sdk";
import { discover } from "./caldav.ts";
import { accountOf, parseInstallation } from "./calendar.ts";
import { FeedCache, type FeedCacheOptions } from "./feeds.ts";
import { errorMessage } from "./http.ts";
import { createEvent, createListEvents } from "./nodes.ts";
import {
  type CalendarConfig,
  type CalendarCredentials,
  CONNECTOR_ID,
  configSchema,
  credentialsSchema,
} from "./schemas.ts";

export type { CalendarEvent } from "./format.ts";
export type { CalendarConfig, CalendarCredentials } from "./schemas.ts";

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

async function testInstallation(
  credentials: CalendarCredentials,
  config: CalendarConfig,
  feeds: FeedCache,
  signal: AbortSignal,
): Promise<TestResult> {
  const p = parseInstallation({ name: "This installation", credentials, config });
  if (p.config.kind === "caldav") {
    const calendars = await discover(accountOf(p), signal);
    if (calendars.length === 0) {
      return { ok: false, error: "The login worked, but the account has no calendars for events." };
    }
    const names = calendars.map((c) => c.name);
    const has = (n: string) => names.some((x) => x.toLowerCase() === n.trim().toLowerCase());
    const missing = p.config.calendars.filter((n) => !has(n));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `No calendar called ${missing.join(", ")}. Found ${names.join(", ")}.`,
      };
    }
    if (p.config.defaultCalendar.trim() && !has(p.config.defaultCalendar)) {
      return {
        ok: false,
        error: `The default calendar ${p.config.defaultCalendar} isn't there. Found ${names.join(", ")}.`,
      };
    }
    return {
      ok: true,
      detail: `Found ${plural(calendars.length, "calendar")}: ${names.join(", ")}.`,
    };
  }
  const urls = p.credentials.feedUrls ?? [];
  if (urls.length === 0) return { ok: false, error: "Add at least one iCal link." };
  const counts = await Promise.all(
    urls.map(async (url, i) => ({
      name: p.config.feedNames[i]?.trim() || `Calendar ${i + 1}`,
      events: (await feeds.get(url, signal, { fresh: true })).events,
    })),
  );
  if (counts.length === 1)
    return { ok: true, detail: `${plural(counts[0]?.events ?? 0, "event")}.` };
  const total = counts.reduce((n, c) => n + c.events, 0);
  return {
    ok: true,
    detail: `${plural(total, "event")} in ${counts.length} links: ${counts.map((c) => `${c.name} ${c.events}`).join(", ")}.`,
  };
}

export interface CalendarConnectorOptions {
  /** iCal feed caching. Tests shorten it. */
  feeds?: FeedCacheOptions;
}

export function createCalendarConnector(
  options: CalendarConnectorOptions = {},
): ConnectorDefinition<CalendarCredentials, CalendarConfig> {
  const feeds = new FeedCache(options.feeds);
  return defineConnector<CalendarCredentials, CalendarConfig>({
    id: CONNECTOR_ID,
    name: "Calendar",
    description:
      "Your calendar over CalDAV (iCloud, Fastmail, Nextcloud, and others), or read-only from iCal links such as Google's or Outlook's private address. Workflows and the assistant read events and add new ones.",
    setupHelp: [
      "**CalDAV** (reads and adds events): set Kind to caldav, the server URL, your username, and an app password.",
      "- iCloud: https://caldav.icloud.com, your Apple ID, and an app-specific password from account.apple.com.",
      "- Fastmail: https://caldav.fastmail.com, your email, and an app password with CalDAV access.",
      "- Nextcloud: https://<your server>/remote.php/dav, and an app password from Security settings.",
      "",
      "**iCal links** (read-only): set Kind to ics and paste up to five private addresses. Google Calendar: Settings → your calendar → Integrate calendar → Secret address in iCal format. Outlook: Settings → Calendar → Shared calendars → Publish a calendar → ICS. Anyone with the link can read the calendar, so Sling stores it like a password.",
    ].join("\n"),
    credentialsSchema,
    secretFields: ["password", "feedUrls"],
    configSchema,

    async test({ credentials, config, signal }): Promise<TestResult> {
      try {
        return await testInstallation(credentials, config, feeds, signal);
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },

    nodes: [createListEvents(feeds), createEvent],
  });
}

export const connector = createCalendarConnector();
