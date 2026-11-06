import type { Occurrence } from "./ical.ts";
import { addDays, clockIn, dateIn, isoIn, longDate, startOfDate } from "./zone.ts";

/** An event as `calendar.list_events` outputs it. */
export interface CalendarEvent {
  title: string;
  /** ISO 8601 with the workspace's offset, or YYYY-MM-DD for an all-day event. */
  start: string;
  /** When it ends. For an all-day event, its last day. */
  end: string;
  allDay: boolean;
  location: string;
  /** The first 500 characters. */
  description: string;
  calendar: string;
}

export function toEvent(o: Occurrence, zone: string): CalendarEvent {
  return {
    title: o.title,
    start: o.allDay ? o.startDate : isoIn(o.startMs, zone),
    end: o.allDay ? addDays(o.endDate, -1) : isoIn(o.endMs, zone),
    allDay: o.allDay,
    location: o.location,
    description: o.description,
    calendar: o.calendar,
  };
}

const NOTE_LIMIT = 200;

function shortDay(date: string): string {
  return longDate(date).replace(/ \d{4}$/, "");
}

/** "09:00–09:30", with the day when the event starts or ends on another one. */
function timeText(o: Occurrence, day: string, zone: string): string {
  const startDay = dateIn(o.startMs, zone);
  const start =
    startDay === day
      ? clockIn(o.startMs, zone)
      : `${shortDay(startDay)} ${clockIn(o.startMs, zone)}`;
  if (o.endMs <= o.startMs) return start;
  // An event ending at midnight ends on its own day, as far as a reader is concerned.
  const endDay = dateIn(o.endMs - 1, zone);
  const end =
    endDay === startDay ? clockIn(o.endMs, zone) : `${shortDay(endDay)} ${clockIn(o.endMs, zone)}`;
  return `${start}–${end}`;
}

function line(o: Occurrence, day: string, zone: string): string {
  let when = "All day";
  if (o.allDay) {
    const last = addDays(o.endDate, -1);
    if (last !== o.startDate) when = `All day, ${shortDay(o.startDate)} to ${shortDay(last)}`;
  } else {
    when = timeText(o, day, zone);
  }
  let out = `- ${when}: ${o.title} (${o.calendar})`;
  if (o.location) out += `, at ${o.location}`;
  if (o.description) {
    const note = o.description.replace(/\s+/g, " ").trim();
    out += `\n  Notes: ${note.length > NOTE_LIMIT ? `${note.slice(0, NOTE_LIMIT - 1)}…` : note}`;
  }
  return out;
}

/**
 * The events as plain text for a prompt, one section per day. An event that
 * began before the first day shows under it.
 */
export function agendaText(
  list: Occurrence[],
  opts: { from: string; days: number; timeZone: string; truncated: boolean },
): string {
  const { from, days, timeZone } = opts;
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const byDay = new Map<string, Occurrence[]>(dates.map((d) => [d, []]));
  const first = startOfDate(from, timeZone);
  for (const o of list) {
    const began = o.allDay ? o.startDate : dateIn(o.startMs, timeZone);
    const before = o.allDay ? o.startDate < from : o.startMs < first;
    byDay.get(before ? from : began)?.push(o);
  }
  const range =
    days === 1 ? longDate(from) : `${longDate(from)} to ${longDate(dates.at(-1) ?? from)}`;
  const out = [`Calendar for ${range}, times in ${timeZone}:`];
  for (const d of dates) {
    const items = byDay.get(d) ?? [];
    if (days > 1) out.push("", longDate(d));
    if (items.length === 0) out.push("- Nothing on the calendar.");
    for (const o of items) out.push(line(o, d, timeZone));
  }
  if (opts.truncated)
    out.push("", "There were more events than Sling reads at once; the rest aren't listed.");
  return out.join("\n");
}
