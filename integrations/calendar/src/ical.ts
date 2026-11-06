/**
 * Reading events out of iCalendar data with ical.js: recurrences expanded
 * within a window, with EXDATE, moved or changed instances (RECURRENCE-ID),
 * and cancelled ones. A TZID that names an IANA zone is read through Intl,
 * whether or not a VTIMEZONE came with it: it's the same data, and ical.js
 * would otherwise rebuild the zone's rules for every event it parses. Other
 * TZIDs, such as Outlook's Windows names, use their VTIMEZONE. A floating
 * time is in the workspace's zone; ical.js would read it as UTC.
 */
import ICAL from "ical.js";
import { dateOf, isZone, startOfDate, wallToInstant } from "./zone.ts";

type Component = InstanceType<typeof ICAL.Component>;
type Time = InstanceType<typeof ICAL.Time>;

/** Longest description kept, in characters. */
export const DESCRIPTION_LIMIT = 500;
/** Occurrences a single series may step through before it's given up on. */
const MAX_STEPS = 20_000;

/** What the events are read for: an instant range and the zone for floating times. */
export interface Window {
  /** Epoch milliseconds, inclusive. */
  start: number;
  /** Epoch milliseconds, exclusive. */
  end: number;
  timeZone: string;
}

/** One event occurrence, before it's formatted for output. */
export interface Occurrence {
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  /** All-day events: the first date and the day after the last, as YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  calendar: string;
}

export class CalendarParseError extends Error {}

/**
 * The calendar components in iCalendar text. A feed is normally one
 * VCALENDAR; some servers send several back to back.
 */
export function parseCalendars(text: string): Component[] {
  let jcal: unknown;
  try {
    jcal = ICAL.parse(text);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new CalendarParseError(`It isn't valid iCalendar data: ${why}`);
  }
  if (!Array.isArray(jcal) || jcal.length === 0) return [];
  const list = typeof jcal[0] === "string" ? [jcal] : (jcal as unknown[]);
  return list.map((j) => new ICAL.Component(j as unknown[]));
}

/** How many events (series count once) a calendar holds. */
export function countEvents(calendars: Component[]): number {
  let n = 0;
  for (const c of calendars) {
    for (const ve of c.getAllSubcomponents("vevent")) {
      if (!ve.hasProperty("recurrence-id")) n++;
    }
  }
  return n;
}

const dateKeyOf = (t: Time) => dateOf({ year: t.year, month: t.month, day: t.day });

/** The instant a time happens. All-day dates start at midnight in the window's zone. */
export function instantOf(t: Time, fallbackZone: string): number {
  if (t.isDate) return startOfDate(dateKeyOf(t), fallbackZone);
  const tzid = t.zone?.tzid;
  if (tzid === "UTC") {
    return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  }
  const wall = {
    year: t.year,
    month: t.month,
    day: t.day,
    hour: t.hour,
    minute: t.minute,
    second: t.second,
  };
  if (t.zone && tzid !== "floating") {
    return isZone(tzid) ? wallToInstant(wall, tzid) : t.toUnixTime() * 1000;
  }
  const named = (t as Time & { timezone?: string }).timezone;
  return wallToInstant(wall, isZone(named) ? named : fallbackZone);
}

/** Matches an occurrence to the RECURRENCE-ID of the instance that replaces it. */
function recurrenceKey(t: Time, zone: string): string {
  return t.isDate ? `d:${dateKeyOf(t)}` : `t:${instantOf(t, zone)}`;
}

function text(c: Component, name: string): string {
  const v = c.getFirstPropertyValue(name);
  return typeof v === "string" ? v.trim() : "";
}

function cancelled(c: Component): boolean {
  return text(c, "status").toUpperCase() === "CANCELLED";
}

function details(c: Component, calendar: string) {
  const description = text(c, "description");
  return {
    title: text(c, "summary") || "(no title)",
    location: text(c, "location"),
    description:
      description.length > DESCRIPTION_LIMIT
        ? `${description.slice(0, DESCRIPTION_LIMIT - 1)}…`
        : description,
    calendar,
  };
}

/** Whole days between two dates, at least one. */
function daysBetween(a: Time, b: Time): number {
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.max(1, Math.round(ms / 86_400_000));
}

interface Span {
  allDay: boolean;
  /** Timed events: length in milliseconds. All-day: length in days. */
  length: number;
}

type Event = InstanceType<typeof ICAL.Event>;

/**
 * An ical.js event that doesn't look for its own changed instances. Without
 * the empty list it scans every sibling event, which makes a large feed
 * quadratic; the changes are matched here by RECURRENCE-ID instead.
 */
const eventOf = (c: Component): Event => new ICAL.Event(c, { exceptions: [] });

function spanOf(event: Event, zone: string): Span {
  const start = event.startDate;
  const end = event.endDate;
  if (start.isDate) return { allDay: true, length: end?.isDate ? daysBetween(start, end) : 1 };
  if (!end) return { allDay: false, length: 0 };
  return { allDay: false, length: Math.max(0, instantOf(end, zone) - instantOf(start, zone)) };
}

function occurrence(
  start: Time,
  span: Span,
  win: Window,
  info: ReturnType<typeof details>,
): Occurrence | null {
  if (span.allDay) {
    const first = dateKeyOf(start);
    const startMs = startOfDate(first, win.timeZone);
    const after = new Date(Date.UTC(start.year, start.month - 1, start.day + span.length));
    const endDate = dateOf({
      year: after.getUTCFullYear(),
      month: after.getUTCMonth() + 1,
      day: after.getUTCDate(),
    });
    const endMs = startOfDate(endDate, win.timeZone);
    if (endMs <= win.start || startMs >= win.end) return null;
    return { ...info, startMs, endMs, allDay: true, startDate: first, endDate };
  }
  const startMs = instantOf(start, win.timeZone);
  const endMs = startMs + span.length;
  // An event with no length counts when it starts inside the window.
  const overlaps = span.length === 0 ? startMs >= win.start : endMs > win.start;
  if (!overlaps || startMs >= win.end) return null;
  return { ...info, startMs, endMs, allDay: false, startDate: "", endDate: "" };
}

/**
 * Where to start stepping a daily or weekly series so it doesn't walk every
 * occurrence since it began. Moving DTSTART by whole intervals keeps the
 * same pattern. Rules with COUNT have to be counted from the start.
 */
function fastStart(master: Component, start: Time, win: Window, span: Span): Time {
  const rules = master.getAllProperties("rrule");
  if (rules.length !== 1 || master.hasProperty("rdate")) return start;
  const rule = rules[0]?.getFirstValue() as InstanceType<typeof ICAL.Recur> | undefined;
  if (!rule || rule.count) return start;
  const interval = rule.interval || 1;
  const stepDays = rule.freq === "DAILY" ? interval : rule.freq === "WEEKLY" ? interval * 7 : 0;
  if (stepDays === 0) return start;
  const lengthDays = span.allDay ? span.length : Math.ceil(span.length / 86_400_000);
  // Days from the series start to a little before the window, leaving room for long events.
  const gap =
    Math.floor((win.start - instantOf(start, win.timeZone)) / 86_400_000) - lengthDays - 8;
  const steps = Math.floor(gap / stepDays);
  if (steps < 2) return start;
  const moved = start.clone();
  moved.adjust(steps * stepDays, 0, 0, 0);
  return moved;
}

/** Adds every occurrence in the window from one calendar to `out`. */
export function collectOccurrences(
  vcal: Component,
  win: Window,
  calendar: string,
  out: Occurrence[],
): void {
  const series = new Map<string, { master: Component | null; changed: Component[] }>();
  let anonymous = 0;
  for (const ve of vcal.getAllSubcomponents("vevent")) {
    let uid = text(ve, "uid") || `anonymous:${anonymous++}`;
    const isChange = ve.hasProperty("recurrence-id");
    let s = series.get(uid);
    // A second event with the same UID and no RECURRENCE-ID is a broken feed; keep both.
    if (s && !isChange && s.master) {
      uid = `${uid}#${anonymous++}`;
      s = undefined;
    }
    if (!s) {
      s = { master: null, changed: [] };
      series.set(uid, s);
    }
    if (isChange) s.changed.push(ve);
    else s.master = ve;
  }

  for (const { master, changed } of series.values()) {
    if (master && cancelled(master)) continue;
    let masterSpan: Span | null = null;
    if (master) {
      const event = eventOf(master);
      const start = event.startDate;
      if (!start) continue;
      const span = spanOf(event, win.timeZone);
      masterSpan = span;
      const info = details(master, calendar);
      if (!event.isRecurring()) {
        const o = occurrence(start, span, win, info);
        if (o) out.push(o);
      } else {
        const replaced = new Set(
          changed.map((c) =>
            recurrenceKey(c.getFirstPropertyValue("recurrence-id") as Time, win.timeZone),
          ),
        );
        const it = event.iterator(fastStart(master, start, win, span));
        for (let i = 0; i < MAX_STEPS; i++) {
          const t = it.next();
          if (!t) break;
          if (instantOf(t, win.timeZone) >= win.end) break;
          if (replaced.size > 0 && replaced.has(recurrenceKey(t, win.timeZone))) continue;
          const o = occurrence(t, span, win, info);
          if (o) out.push(o);
        }
      }
    }
    // Changed instances stand on their own: one may have moved into the window from outside it.
    for (const c of changed) {
      if (cancelled(c)) continue;
      const event = eventOf(c);
      const start = event.startDate;
      if (!start) continue;
      const own = c.hasProperty("dtend") || c.hasProperty("duration");
      const span = own || !masterSpan ? spanOf(event, win.timeZone) : masterSpan;
      const o = occurrence(start, span, win, details(c, calendar));
      if (o) out.push(o);
    }
  }
}

/** Earliest first; all-day events before timed ones that start at the same time. */
export function sortOccurrences(list: Occurrence[]): Occurrence[] {
  return list.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      Number(b.allDay) - Number(a.allDay) ||
      a.endMs - b.endMs ||
      a.title.localeCompare(b.title),
  );
}
