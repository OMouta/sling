/**
 * One-time schedules. A Schedule trigger with `at`, a local date and time
 * such as 2026-11-09T17:00, runs its workflow once then, in the node's time
 * zone or the workspace's, and turns the workflow off.
 */
import type { ValidationIssue, WorkflowDefinition } from "@sling/workflow";

/** A local date and time, to the minute or the second. */
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const SCHEDULE = "core.schedule";

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The parts of a local date and time, or null when it isn't one, such as 2026-02-30T10:00. */
export function parseLocal(at: string): LocalTime | null {
  const m = LOCAL.exec(at.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map((v) => Number(v ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { year, month, day, hour, minute, second };
}

/** A schedule's one-time `at`, or null for a cron schedule. */
export function oneTimeAt(config: Record<string, unknown> | null | undefined): string | null {
  const at = config?.at;
  return typeof at === "string" && at.trim() ? at.trim() : null;
}

const offsets = new Map<string, Intl.DateTimeFormat>();

/** How far the zone's clocks are ahead of UTC at an instant, in ms. */
function offsetAt(ms: number, timeZone: string): number {
  let f = offsets.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    offsets.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, Number(x.value)]));
  const wall = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a local time names in a time zone. A time the clocks skip
 * when they go forward lands just after the change. Null when it isn't a
 * local time; throws on an unknown zone.
 */
export function instantOf(at: string, timeZone: string): Date | null {
  const p = parseLocal(at);
  if (!p) return null;
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // The offset at a first guess, then at the result, which settles it across a change.
  let t = wall - offsetAt(wall, timeZone);
  const settled = offsetAt(t, timeZone);
  if (settled !== wall - t) t = wall - settled;
  return new Date(t);
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

const pad = (n: number) => String(n).padStart(2, "0");

function dayText(p: Pick<LocalTime, "year" | "month" | "day">, now: Date): string {
  const weekday = WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  const year = p.year === now.getUTCFullYear() ? "" : ` ${p.year}`;
  return `${weekday} ${p.day} ${MONTHS[p.month - 1]}${year}`;
}

/**
 * "Saturday 7 November at 17:00", with the year when it isn't this one.
 * The local time as written, so it reads the same in any zone.
 */
export function localTimeText(at: string, now: Date = new Date()): string {
  const p = parseLocal(at);
  if (!p) return at;
  const time = `${pad(p.hour)}:${pad(p.minute)}${p.second ? `:${pad(p.second)}` : ""}`;
  return `${dayText(p, now)} at ${time}`;
}

/** "Monday 9 November" for 2026-11-09. */
export function localDateText(date: string, now: Date = new Date()): string {
  const p = parseLocal(`${date.trim()}T00:00`);
  return p ? dayText(p, now) : date;
}

/** The zone a schedule follows: its own, or the workspace's when it's empty. */
export function zoneFor(config: Record<string, unknown>, workspaceZone: string): string {
  const tz = config.timezone;
  return typeof tz === "string" && tz.trim() ? tz.trim() : workspaceZone;
}

/** When a node's one-time schedule fires, or null when it isn't one or can't be read. */
export function oneTimeInstant(
  config: Record<string, unknown>,
  workspaceZone: string,
): Date | null {
  const at = oneTimeAt(config);
  if (!at) return null;
  try {
    return instantOf(at, zoneFor(config, workspaceZone));
  } catch {
    return null;
  }
}

/** One-time schedules in a definition whose time has passed, each with when it was, in words. */
export function passedSchedules(
  definition: WorkflowDefinition,
  workspaceZone: string,
  now: Date = new Date(),
): (ValidationIssue & { when: string })[] {
  const issues: (ValidationIssue & { when: string })[] = [];
  for (const node of definition.nodes) {
    if (node.type !== SCHEDULE) continue;
    const at = oneTimeAt(node.config);
    const instant = oneTimeInstant(node.config, workspaceZone);
    if (!at || !instant || instant.getTime() > now.getTime()) continue;
    const when = `${localTimeText(at, now)} in ${zoneFor(node.config, workspaceZone)}`;
    issues.push({
      code: "time_passed",
      message: `at: ${when} has already passed`,
      nodeId: node.id,
      port: "at",
      when,
    });
  }
  return issues;
}
