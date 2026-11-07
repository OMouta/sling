import { type ConnectorDefinition, defineConnector, type TestResult } from "@sling/connector-sdk";
import { discover } from "./caldav.ts";
import { accountOf, googleTokenOf, parseInstallation } from "./calendar.ts";
import { FeedCache, type FeedCacheOptions } from "./feeds.ts";
import { GOOGLE_API, GOOGLE_SCOPES, googleCalendars } from "./google.ts";
import { errorMessage } from "./http.ts";
import { createEvent, createListEvents } from "./nodes.ts";
import {
  type CalendarConfig,
  type CalendarCredentials,
  CONNECTOR_ID,
  configSchema,
  credentialsSchema,
} from "./schemas.ts";
import { calendarSetup, type SetupDeps } from "./setup.ts";

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
  if (p.config.kind === "caldav" || p.config.kind === "google") {
    const calendars =
      p.config.kind === "google"
        ? await googleCalendars(googleTokenOf(p), signal)
        : await discover(accountOf(p), signal);
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
  /** How the setup lookup reaches DNS and the server. Tests replace it. */
  setup?: SetupDeps;
  /** Google Calendar's API. Tests point it at a stand-in. */
  googleApiUrl?: string;
}

/**
 * How a Google calendar signs in, read by Sling's server: OAuth with the
 * person's own client, for installations of kind `google`.
 */
export const GOOGLE_SIGN_IN = {
  provider: "google",
  scopes: GOOGLE_SCOPES,
  when: { kind: "google" },
} as const;

export function createCalendarConnector(
  options: CalendarConnectorOptions = {},
): ConnectorDefinition<CalendarCredentials, CalendarConfig> & { oauth: typeof GOOGLE_SIGN_IN } {
  const feeds = new FeedCache(options.feeds);
  if (options.googleApiUrl) GOOGLE_API.url = options.googleApiUrl;
  const definition = defineConnector<CalendarCredentials, CalendarConfig>({
    id: CONNECTOR_ID,
    name: "Calendar",
    description: "Read and add events in your calendar.",
    credentialsSchema,
    secretFields: ["password", "feedUrls", "clientSecret", "accessToken"],
    configSchema,

    async test({ credentials, config, signal }): Promise<TestResult> {
      try {
        return await testInstallation(credentials, config, feeds, signal);
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },

    setup: ({ credentials, config, signal }) =>
      calendarSetup(credentials, config, feeds, signal, options.setup),

    nodes: [createListEvents(feeds), createEvent],
  });
  return Object.assign(definition, { oauth: GOOGLE_SIGN_IN });
}

export const connector = createCalendarConnector();
