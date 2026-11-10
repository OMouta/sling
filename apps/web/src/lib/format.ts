const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

/** When something runs out: "expires in 5 minutes", "expires in under a minute", "expired". */
export function expiresIn(iso: string, now = Date.now()): string {
  const left = new Date(iso).getTime() - now;
  if (!(left > 0)) return "expired";
  if (left < 60_000) return "expires in under a minute";
  return `expires ${ago(iso, now)}`;
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const CLOCK_SECONDS = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** The time of day in the reader's own 12 or 24 hour style: "14:05" or "2:05 PM". */
export function clockTime(iso: string | Date, { seconds = false } = {}): string {
  return (seconds ? CLOCK_SECONDS : CLOCK).format(new Date(iso));
}

/** A date and time in the reader's style: "Nov 10, 14:05". */
export function dateTime(iso: string | Date): string {
  return DATE_TIME.format(new Date(iso));
}

/** Whether the reader's clock is 12 hour, so a column of times can be sized for "10:04:05 PM". */
export const TWELVE_HOUR = /h1[12]/.test(CLOCK.resolvedOptions().hourCycle ?? "");

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : "";
}

/** "1 task", "3 tasks", or with its own plural, "2 replies". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${noun(n, one, many)}`;
}

/** The word alone, for a count set in its own style: "task" or "tasks". */
export function noun(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** "850 ms", "3.2 s", "45 s", "4m 05s", "1h 02m". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.floor(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A duration that ticks by the second, such as a running timer: "0 s", "12 s", "4m 05s". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 10 ? `${s} s` : duration(s * 1000);
}

export function between(start: string | null, end: string | null, now = Date.now()): number | null {
  if (!start) return null;
  return (end ? new Date(end).getTime() : now) - new Date(start).getTime();
}

/**
 * A coding agent's summary links files by their path on its own machine,
 * which leads nowhere in a browser. Shows each such link's text as code.
 */
export function withoutLocalLinks(markdown: string): string {
  return markdown.replace(
    /\[([^\]\n]+)\]\(((?:\/|~\/|file:)[^)\s]*)\)/g,
    (_m, text: string) => `\`${text.replaceAll("`", "")}\``,
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A local date or date and time, such as a calendar event's start, as people
 * write it: "2026-11-07T10:00" is "Sat 7 Nov, 10:00". Anything else comes back
 * as it was.
 */
export function readableLocalDate(text: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(text.trim());
  if (!m) return text;
  const [, y, mo, d, h, mi] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(day.getTime()) || day.getUTCDate() !== Number(d)) return text;
  const date = `${WEEKDAYS[day.getUTCDay()]} ${Number(d)} ${MONTHS[day.getUTCMonth()]}`;
  return h ? `${date}, ${h}:${mi}` : date;
}
