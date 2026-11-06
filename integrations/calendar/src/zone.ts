/**
 * Wall-clock arithmetic in IANA time zones, through Intl. Formatters are
 * cached per zone, since building one costs far more than using it.
 */

export const DAY_MS = 86_400_000;

export interface Wall {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, f);
  }
  return f;
}

/** True for a zone name Intl knows, such as Europe/Lisbon. */
export function isZone(name: string | null | undefined): name is string {
  if (!name || name.length > 64) return false;
  if (formatters.has(name)) return true;
  try {
    formatter(name);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time in `zone` at an instant. */
export function wallAt(ms: number, zone: string): Wall {
  const out: Wall = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatter(zone).formatToParts(ms)) {
    if (p.type === "literal") continue;
    if (p.type in out) out[p.type as keyof Wall] = Number(p.value);
  }
  return out;
}

/** Milliseconds `zone` is ahead of UTC at an instant. */
export function offsetAt(ms: number, zone: string): number {
  const w = wallAt(ms, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in `zone`. A time skipped by a
 * spring-forward change lands after it; one repeated in autumn takes the
 * first of the two.
 */
export function wallToInstant(w: Wall, zone: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // The offsets in force a day either side cover any change on this date.
  const before = offsetAt(guess - DAY_MS, zone);
  const after = offsetAt(guess + DAY_MS, zone);
  let best: number | null = null;
  for (const o of before === after ? [before] : [before, after]) {
    const t = guess - o;
    if (offsetAt(t, zone) === o && (best === null || t < best)) best = t;
  }
  return best ?? guess - before;
}

/** Midnight at the start of a calendar date (YYYY-MM-DD) in `zone`. */
export function startOfDate(date: string, zone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return wallToInstant({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, zone);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** YYYY-MM-DD for a wall time. */
export function dateOf(w: Pick<Wall, "year" | "month" | "day">): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** The calendar date of an instant in `zone`. */
export function dateIn(ms: number, zone: string): string {
  return dateOf(wallAt(ms, zone));
}

/** A date plus some days, as YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return dateOf({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() });
}

/** An instant as ISO 8601 with `zone`'s offset, such as 2026-11-06T09:00:00+00:00. */
export function isoIn(ms: number, zone: string): string {
  const w = wallAt(ms, zone);
  const off = Math.round(offsetAt(ms, zone) / 60_000);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${dateOf(w)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** HH:MM in `zone`. */
export function clockIn(ms: number, zone: string): string {
  const w = wallAt(ms, zone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Friday, 6 November 2026" for a YYYY-MM-DD date. */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${d} ${MONTHS[m - 1]} ${y}`;
}
