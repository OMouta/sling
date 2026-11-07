/**
 * Reading and adding events for one installation, whichever kind it is.
 */
import { createHash } from "node:crypto";
import { NodeError } from "@sling/connector-sdk";
import ICAL from "ical.js";
import {
  type CalDavAccount,
  calendarsOf,
  calendarTag,
  type DavCalendar,
  eventData,
  forgetCalendars,
  putEvent,
} from "./caldav.ts";
import type { FeedCache } from "./feeds.ts";
import { agendaText, type CalendarEvent, toEvent } from "./format.ts";
import {
  findCalendar,
  type GoogleCalendar,
  getGoogleEvent,
  googleCalendars,
  googleEventId,
  googleEvents,
  insertGoogleEvent,
  occurrenceOf,
} from "./google.ts";
import { collectOccurrences, type Occurrence, parseCalendars, sortOccurrences } from "./ical.ts";
import {
  type CalendarConfig,
  type CalendarCredentials,
  configSchema,
  credentialsSchema,
} from "./schemas.ts";
import { addDays, dateOf, isoIn, startOfDate, wallToInstant } from "./zone.ts";

/** Most events one read returns. */
export const MAX_EVENTS = 2_000;

export interface CalendarInstallation {
  name: string;
  credentials: unknown;
  config: unknown;
}

export interface Parsed {
  name: string;
  credentials: CalendarCredentials;
  config: CalendarConfig;
}

export function parseInstallation(inst: CalendarInstallation): Parsed {
  const config = configSchema.safeParse(inst.config ?? {});
  if (!config.success) {
    const issue = config.error.issues[0];
    throw new NodeError(
      `${inst.name} isn't set up right: ${issue?.message ?? "invalid settings"}.`,
      {
        code: "invalid_installation",
      },
    );
  }
  const credentials = credentialsSchema.safeParse(inst.credentials ?? {});
  if (!credentials.success) {
    throw new NodeError(`${inst.name} has invalid credentials.`, { code: "missing_credentials" });
  }
  return { name: inst.name, config: config.data, credentials: credentials.data };
}

export function accountOf(p: Parsed): CalDavAccount {
  const password = p.credentials.password ?? "";
  if (!password) {
    throw new NodeError(
      `${p.name} has no CalDAV password. Add an app password on the Connectors page.`,
      {
        code: "missing_credentials",
      },
    );
  }
  return { serverUrl: p.config.serverUrl.trim(), username: p.config.username.trim(), password };
}

/** The live Google access token Sling's server handed over, or why there isn't one. */
export function googleTokenOf(p: Parsed): string {
  const token = p.credentials.accessToken ?? "";
  if (token) return token;
  const problem = p.credentials.signIn?.problem;
  throw new NodeError(
    problem ?? `${p.name} isn't connected to Google yet. Connect it on the Connectors page.`,
    { code: "not_connected" },
  );
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function pick<T extends { name: string }>(all: T[], names: string[], what: string): T[] {
  if (names.length === 0) return all;
  return names.map((n) => {
    const hit = all.find((c) => sameName(c.name, n));
    if (!hit) {
      throw new NodeError(
        `No calendar called ${n} in ${what}. Calendars: ${all.map((c) => c.name).join(", ") || "none"}.`,
        { code: "no_calendar" },
      );
    }
    return hit;
  });
}

/**
 * The account's calendars the installation includes, narrowed to `names`
 * when given. A name that isn't there finds the calendars again once, since
 * the list is reused for a few minutes and one may have been added since.
 */
async function includedCalendars(
  p: Parsed,
  account: CalDavAccount,
  names: string[],
  signal: AbortSignal,
): Promise<DavCalendar[]> {
  const choose = (all: DavCalendar[]) => pick(pick(all, p.config.calendars, p.name), names, p.name);
  try {
    return choose(await calendarsOf(account, signal));
  } catch (err) {
    if (!(err instanceof NodeError) || err.code !== "no_calendar") throw err;
    forgetCalendars(account);
    return choose(await calendarsOf(account, signal));
  }
}

type Component = ReturnType<typeof parseCalendars>[number];

interface Fetched {
  tag: string;
  calendars: Component[];
}

/** Parsed events per calendar and window, kept while the calendar's tag stays the same. */
const fetched = new Map<string, Fetched>();
const MAX_FETCHED = 64;

/**
 * A calendar's events with an instance in the window. A repeat read asks only
 * for the calendar's tag, and reuses what it parsed last time if nothing
 * changed. The tag is read before the events, so a change made in between
 * is seen on the next read.
 */
async function calendarEvents(
  account: CalDavAccount,
  calendar: DavCalendar,
  win: { start: number; end: number },
  signal: AbortSignal,
): Promise<Component[]> {
  const key = `${account.username}\n${calendar.url}\n${win.start}\n${win.end}`;
  const tag = await calendarTag(account, calendar, signal);
  const hit = fetched.get(key);
  if (tag && hit?.tag === tag) {
    // Most recently used goes last, so the oldest is the first to go.
    fetched.delete(key);
    fetched.set(key, hit);
    return hit.calendars;
  }
  const calendars: Component[] = [];
  for (const resource of await eventData(account, calendar, win, signal)) {
    try {
      calendars.push(...parseCalendars(resource));
    } catch {
      // One unreadable event shouldn't hide the rest of the calendar.
    }
  }
  if (tag) {
    fetched.delete(key);
    if (fetched.size >= MAX_FETCHED) {
      const oldest = fetched.keys().next().value;
      if (oldest !== undefined) fetched.delete(oldest);
    }
    fetched.set(key, { tag, calendars });
  }
  return calendars;
}

export interface ReadQuery {
  /** YYYY-MM-DD, the first day, in `timeZone`. */
  from: string;
  days: number;
  timeZone: string;
  /** Only these calendars, by name. Empty reads all the installation includes. */
  calendars: string[];
  signal: AbortSignal;
  feeds: FeedCache;
}

export interface ReadResult {
  events: CalendarEvent[];
  agenda: string;
  truncated: boolean;
}

/** The events in the days asked for, sorted, with an agenda for a prompt. */
export async function readEvents(inst: CalendarInstallation, q: ReadQuery): Promise<ReadResult> {
  const p = parseInstallation(inst);
  const win = {
    start: startOfDate(q.from, q.timeZone),
    end: startOfDate(addDays(q.from, q.days), q.timeZone),
    timeZone: q.timeZone,
  };
  const found: Occurrence[] = [];

  if (p.config.kind === "google") {
    const token = googleTokenOf(p);
    const all = await googleCalendars(token, q.signal);
    const calendars = pick(pick(all, p.config.calendars, p.name), q.calendars, p.name);
    const lists = await Promise.all(
      calendars.map((c) => googleEvents(token, c, win, MAX_EVENTS + 1, q.signal)),
    );
    for (const list of lists) found.push(...list);
  } else if (p.config.kind === "caldav") {
    const account = accountOf(p);
    const calendars = await includedCalendars(p, account, q.calendars, q.signal);
    const answers = await Promise.all(
      calendars.map(async (c) => ({ c, data: await calendarEvents(account, c, win, q.signal) })),
    );
    for (const { c, data } of answers) {
      for (const vcal of data) collectOccurrences(vcal, win, c.name, found);
    }
  } else {
    const urls = p.credentials.feedUrls ?? [];
    if (urls.length === 0) {
      throw new NodeError(`${p.name} has no iCal links. Add one on the Connectors page.`, {
        code: "missing_credentials",
      });
    }
    const feeds = urls.map((url, i) => ({
      url,
      name: p.config.feedNames[i]?.trim() || `Calendar ${i + 1}`,
    }));
    const chosen = pick(feeds, q.calendars, p.name);
    const loaded = await Promise.all(
      chosen.map(async (f) => ({ f, feed: await q.feeds.get(f.url, q.signal) })),
    );
    for (const { f, feed } of loaded) {
      for (const vcal of feed.calendars) collectOccurrences(vcal, win, f.name, found);
    }
  }

  sortOccurrences(found);
  const truncated = found.length > MAX_EVENTS;
  const kept = truncated ? found.slice(0, MAX_EVENTS) : found;
  return {
    events: kept.map((o) => toEvent(o, q.timeZone)),
    agenda: agendaText(kept, { from: q.from, days: q.days, timeZone: q.timeZone, truncated }),
    truncated,
  };
}

// ------------------------------------------------------------- adding events

export interface NewEvent {
  calendar: string;
  title: string;
  start: string;
  end: string;
  durationMinutes: number;
  allDay: boolean;
  location: string;
  description: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** A date-time as typed: local to `zone` unless it carries Z or an offset. */
export function parseWhen(value: string, zone: string, field: string): number {
  const m = DATE_TIME.exec(value.trim());
  if (!m) {
    throw new NodeError(
      `${field} should look like 2026-11-06T14:00, or 2026-11-06T14:00:00+01:00 with an offset.`,
      { code: "invalid_time" },
    );
  }
  const [, y, mo, d, h, mi, s, off] = m;
  const wall = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s ?? 0),
  };
  if (
    wall.month < 1 ||
    wall.month > 12 ||
    wall.day < 1 ||
    wall.day > 31 ||
    wall.hour > 23 ||
    wall.minute > 59
  ) {
    throw new NodeError(`${field} isn't a real date and time.`, { code: "invalid_time" });
  }
  if (!off) return wallToInstant(wall, zone);
  const utc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  if (off.toUpperCase() === "Z") return utc;
  const sign = off.startsWith("-") ? -1 : 1;
  const digits = off.slice(1).replace(":", "");
  return utc - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
}

function parseDay(value: string, field: string): string {
  const v = value.trim();
  const m = DATE.exec(v) ?? DATE.exec(v.slice(0, 10));
  if (!m)
    throw new NodeError(`${field} should be a date such as 2026-11-06.`, { code: "invalid_time" });
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The same idempotency key always gives the same UID, so a repeat finds the first event. */
export function uidFor(idempotencyKey: string): string {
  return `sling-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

export interface Added {
  created: boolean;
  /** `uid` finds the event again: its iCalendar UID, or its ID on Google. `link` opens it on Google. */
  event: CalendarEvent & { uid: string; link?: string };
}

/** Builds the iCalendar text for a new event. Times are written in UTC, which every client reads. */
export function eventIcs(e: {
  uid: string;
  title: string;
  location: string;
  description: string;
  allDay: boolean;
  startMs: number;
  endMs: number;
  startDate: string;
  endDate: string;
  now: number;
}): string {
  const vcal = new ICAL.Component(["vcalendar", [], []]);
  vcal.updatePropertyWithValue("prodid", "-//Sling//Calendar//EN");
  vcal.updatePropertyWithValue("version", "2.0");
  const ve = new ICAL.Component("vevent");
  ve.updatePropertyWithValue("uid", e.uid);
  ve.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(e.now), true));
  if (e.allDay) {
    ve.updatePropertyWithValue("dtstart", ICAL.Time.fromDateString(e.startDate));
    ve.updatePropertyWithValue("dtend", ICAL.Time.fromDateString(e.endDate));
  } else {
    ve.updatePropertyWithValue("dtstart", ICAL.Time.fromJSDate(new Date(e.startMs), true));
    ve.updatePropertyWithValue("dtend", ICAL.Time.fromJSDate(new Date(e.endMs), true));
  }
  ve.updatePropertyWithValue("summary", e.title);
  if (e.location) ve.updatePropertyWithValue("location", e.location);
  if (e.description) ve.updatePropertyWithValue("description", e.description);
  vcal.addSubcomponent(ve);
  return `${vcal.toString().replace(/\r?\n/g, "\r\n")}\r\n`;
}

/** When a new event happens, from what was asked. All-day end dates are the day after the last. */
export interface EventTimes {
  allDay: boolean;
  startDate: string;
  endDate: string;
  startMs: number;
  endMs: number;
}

export function eventTimes(input: NewEvent, zone: string): EventTimes {
  if (input.allDay) {
    const first = parseDay(input.start, "start");
    const last = input.end.trim() ? parseDay(input.end, "end") : first;
    if (last < first)
      throw new NodeError("The event ends before it starts.", { code: "invalid_time" });
    return { allDay: true, startDate: first, endDate: addDays(last, 1), startMs: 0, endMs: 0 };
  }
  if (DATE.test(input.start.trim())) {
    throw new NodeError(
      "start needs a time, such as 2026-11-06T14:00. For a whole day, set allDay.",
      { code: "invalid_time" },
    );
  }
  const startMs = parseWhen(input.start, zone, "start");
  const endMs = input.end.trim()
    ? parseWhen(input.end, zone, "end")
    : startMs + input.durationMinutes * 60_000;
  if (endMs <= startMs)
    throw new NodeError("The event ends before it starts.", { code: "invalid_time" });
  const d = new Date(startMs);
  const startDate = dateOf({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  });
  return { allDay: false, startDate, endDate: startDate, startMs, endMs };
}

/** The added event as `calendar.create_event` outputs it. */
function shownEvent(
  e: { title: string; location: string; description: string; calendar: string },
  t: EventTimes,
  zone: string,
): CalendarEvent {
  return {
    title: e.title,
    start: t.allDay ? t.startDate : isoIn(t.startMs, zone),
    end: t.allDay ? addDays(t.endDate, -1) : isoIn(t.endMs, zone),
    allDay: t.allDay,
    location: e.location,
    description: e.description,
    calendar: e.calendar,
  };
}

/** Adds an event to a CalDAV or Google calendar. Asking twice with the same key adds it once. */
export async function addEvent(
  inst: CalendarInstallation,
  input: NewEvent,
  ctx: { idempotencyKey: string; timeZone: string; signal: AbortSignal; now?: number },
): Promise<Added> {
  const p = parseInstallation(inst);
  if (p.config.kind === "google") return addGoogleEvent(p, input, ctx);
  if (p.config.kind !== "caldav") {
    throw new NodeError(
      `${p.name} reads iCal links, which can't take new events. Use a CalDAV installation.`,
      { code: "read_only_calendar" },
    );
  }
  const title = input.title.trim();
  if (!title) throw new NodeError("The event needs a title.", { code: "invalid_config" });
  const account = accountOf(p);
  const all = await calendarsOf(account, ctx.signal);
  const wanted = input.calendar.trim() || p.config.defaultCalendar.trim();
  let calendar: DavCalendar | undefined;
  if (wanted) {
    calendar = all.find((c) => sameName(c.name, wanted));
    if (!calendar) {
      forgetCalendars(account);
      const again = await calendarsOf(account, ctx.signal);
      calendar = again.find((c) => sameName(c.name, wanted));
      if (!calendar) {
        throw new NodeError(
          `No calendar called ${wanted} in ${p.name}. Calendars: ${again.map((c) => c.name).join(", ") || "none"}.`,
          { code: "no_calendar" },
        );
      }
    }
  } else {
    calendar = all[0];
    if (!calendar) throw new NodeError(`${p.name} has no calendars.`, { code: "no_calendar" });
  }

  const uid = uidFor(ctx.idempotencyKey);
  const t = eventTimes(input, ctx.timeZone);
  const base = {
    uid,
    title,
    location: input.location.trim(),
    description: input.description.trim(),
  };
  const ics = eventIcs({ ...base, ...t, now: ctx.now ?? Date.now() });
  const event = shownEvent({ ...base, calendar: calendar.name }, t, ctx.timeZone);
  const outcome = await putEvent(account, calendar, `${uid}.ics`, ics, ctx.signal);
  return { created: outcome === "created", event: { ...event, uid } };
}

/** The calendar a new Google event goes to: the one asked for, the default, or the account's own. */
async function googleTarget(
  p: Parsed,
  token: string,
  wanted: string,
  signal: AbortSignal,
): Promise<GoogleCalendar> {
  const all = await googleCalendars(token, signal);
  const name = wanted.trim() || p.config.defaultCalendar.trim() || "primary";
  const calendar = findCalendar(all, name);
  if (!calendar) {
    throw new NodeError(
      `No calendar called ${name} in ${p.name}. Calendars: ${all.map((c) => c.name).join(", ") || "none"}.`,
      { code: "no_calendar" },
    );
  }
  return calendar;
}

/** Adds an event through Google's API, with an ID from the idempotency key, so a repeat adds nothing. */
async function addGoogleEvent(
  p: Parsed,
  input: NewEvent,
  ctx: { idempotencyKey: string; timeZone: string; signal: AbortSignal },
): Promise<Added> {
  const title = input.title.trim();
  if (!title) throw new NodeError("The event needs a title.", { code: "invalid_config" });
  const token = googleTokenOf(p);
  const t = eventTimes(input, ctx.timeZone);
  const calendar = await googleTarget(p, token, input.calendar, ctx.signal);
  if (calendar.accessRole !== "owner" && calendar.accessRole !== "writer") {
    throw new NodeError(`${calendar.name} is read-only for this account. Pick another calendar.`, {
      code: "read_only_calendar",
    });
  }
  const base = { title, location: input.location.trim(), description: input.description.trim() };
  const id = googleEventId(ctx.idempotencyKey);
  const done = await insertGoogleEvent(
    token,
    calendar,
    { id, ...base, ...t, timeZone: ctx.timeZone },
    ctx.signal,
  );
  return {
    created: done.created,
    event: {
      ...shownEvent({ ...base, calendar: calendar.name }, t, ctx.timeZone),
      uid: id,
      ...(done.event.htmlLink ? { link: done.event.htmlLink } : {}),
    },
  };
}

/** What reading a Google event back found. */
export type ReadBack =
  | { found: true; calendar: string; occurrence: Occurrence }
  | { found: false; calendar: string };

/** Reads an added event back from Google by its ID, from the calendar it went to. */
export async function readBackGoogleEvent(
  inst: CalendarInstallation,
  event: { uid: string; calendar: string },
  zone: string,
  signal: AbortSignal,
): Promise<ReadBack> {
  const p = parseInstallation(inst);
  const token = googleTokenOf(p);
  const calendar = await googleTarget(p, token, event.calendar, signal);
  const found = await getGoogleEvent(token, calendar, event.uid, signal);
  const occurrence = found ? occurrenceOf(found, calendar.name, zone) : null;
  return occurrence
    ? { found: true, calendar: calendar.name, occurrence }
    : { found: false, calendar: calendar.name };
}
