/**
 * Google Calendar through its API (v3), with an access token Sling's server
 * keeps fresh. The connector signs in with the person's own OAuth client;
 * the server hands each call a live token as the `accessToken` credential.
 */
import { createHash } from "node:crypto";
import { NodeError } from "@sling/connector-sdk";
import { errorMessage, request } from "./http.ts";
import { DESCRIPTION_LIMIT, type Occurrence } from "./ical.ts";
import { dateIn, startOfDate } from "./zone.ts";

/** Where the API lives. Tests point it at a stand-in. */
export const GOOGLE_API = { url: "https://www.googleapis.com/calendar/v3" };

/** What the calendar asks Google for: its events, and the list of calendars to read. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export const GOOGLE_CLOUD_CREDENTIALS = "https://console.cloud.google.com/apis/credentials";
export const GOOGLE_CALENDAR_API_PAGE =
  "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com";

/** Most events read from one calendar. */
const MAX_PAGES = 10;

export interface GoogleCalendar {
  id: string;
  name: string;
  primary: boolean;
  /** owner, writer, reader, or freeBusyReader. */
  accessRole: string;
}

interface GoogleTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  start?: GoogleTime;
  end?: GoogleTime;
}

interface Answer {
  status: number;
  body: unknown;
}

function field(v: unknown, key: string): unknown {
  return v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
}

/** Google's error body: `{ error: { code, message, errors: [{ reason }] } }`. */
function problemOf(body: unknown): { message: string; reason: string } {
  const error = field(body, "error");
  const errors = field(error, "errors");
  const first = Array.isArray(errors) ? errors[0] : undefined;
  return {
    message: String(field(error, "message") ?? ""),
    reason: String(field(first, "reason") ?? field(error, "status") ?? ""),
  };
}

/** A refusal from Google, said so the person knows what to do about it. */
export function googleError(res: Answer, action: string): NodeError {
  const { message, reason } = problemOf(res.body);
  if (res.status === 401) {
    return new NodeError(
      "Google no longer accepts Sling's sign-in. Connect the calendar again on the Connectors page.",
      { code: "google_unauthorized" },
    );
  }
  if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(`${reason} ${message}`)) {
    return new NodeError(
      `Turn on the Google Calendar API for your Google Cloud project, at ${GOOGLE_CALENDAR_API_PAGE}, then try again.`,
      { code: "google_api_off" },
    );
  }
  if (res.status === 429 || /rateLimitExceeded|userRateLimitExceeded/.test(reason)) {
    return new NodeError(`Google is rate limiting ${action}. Try again in a minute.`, {
      code: "google_rate_limited",
      retryable: true,
    });
  }
  if (res.status >= 500) {
    return new NodeError(`Google failed while ${action}: ${message || `HTTP ${res.status}`}`, {
      code: "google_unavailable",
      retryable: true,
    });
  }
  if (res.status === 403) {
    return new NodeError(`Google refused ${action}: ${message || "forbidden"}`, {
      code: "google_forbidden",
    });
  }
  if (res.status === 404) {
    return new NodeError(`Google couldn't find that while ${action}.`, {
      code: "google_not_found",
    });
  }
  return new NodeError(`Google refused ${action}: ${message || `HTTP ${res.status}`}`, {
    code: "google_error",
  });
}

async function call(
  token: string,
  method: "GET" | "POST",
  path: string,
  signal: AbortSignal,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<Answer> {
  const url = new URL(`${GOOGLE_API.url}${path}`);
  for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
  const res = await request(
    url.href,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal,
    },
    "Google Calendar",
  );
  let body: unknown = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = res.body;
  }
  return { status: res.status, body };
}

const ok = (res: Answer) => res.status >= 200 && res.status < 300;

/** Every calendar on the account the person can at least read events in. */
export async function googleCalendars(
  token: string,
  signal: AbortSignal,
): Promise<GoogleCalendar[]> {
  const out: GoogleCalendar[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await call(token, "GET", "/users/me/calendarList", signal, {
      query: {
        minAccessRole: "reader",
        maxResults: "250",
        ...(pageToken ? { pageToken } : {}),
      },
    });
    if (!ok(res)) throw googleError(res, "listing your calendars");
    const items = field(res.body, "items");
    for (const c of Array.isArray(items) ? items : []) {
      const id = field(c, "id");
      if (typeof id !== "string" || field(c, "deleted") === true) continue;
      const name = field(c, "summaryOverride") ?? field(c, "summary") ?? id;
      out.push({
        id,
        name: String(name),
        primary: field(c, "primary") === true,
        accessRole: String(field(c, "accessRole") ?? "reader"),
      });
    }
    pageToken = String(field(res.body, "nextPageToken") ?? "");
    if (!pageToken) break;
  }
  // The person's own calendar first, the way Google lists it.
  return out.sort((a, b) => Number(b.primary) - Number(a.primary));
}

/** The calendar a name or ID means, ignoring case. `primary` is the account's own. */
export function findCalendar(all: GoogleCalendar[], wanted: string): GoogleCalendar | undefined {
  const w = wanted.trim().toLowerCase();
  if (w === "primary") return all.find((c) => c.primary);
  return all.find((c) => c.name.toLowerCase() === w) ?? all.find((c) => c.id.toLowerCase() === w);
}

/** Google allows HTML in descriptions; an agenda wants the words. */
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** One of Google's events as an occurrence, or null when it isn't one to show. */
export function occurrenceOf(e: GoogleEvent, calendar: string, zone: string): Occurrence | null {
  if (e.status === "cancelled") return null;
  const description = plainText(e.description ?? "");
  const info = {
    title: e.summary?.trim() || "(no title)",
    location: e.location?.trim() ?? "",
    description:
      description.length > DESCRIPTION_LIMIT
        ? `${description.slice(0, DESCRIPTION_LIMIT - 1)}…`
        : description,
    calendar,
  };
  const startDate = e.start?.date;
  if (startDate) {
    // All-day: Google's end date is the day after the last, like iCalendar's.
    const endDate = e.end?.date && e.end.date > startDate ? e.end.date : startDate;
    return {
      ...info,
      allDay: true,
      startDate,
      endDate,
      startMs: startOfDate(startDate, zone),
      endMs: startOfDate(endDate, zone),
    };
  }
  const startMs = Date.parse(e.start?.dateTime ?? "");
  if (!Number.isFinite(startMs)) return null;
  const end = Date.parse(e.end?.dateTime ?? "");
  return {
    ...info,
    allDay: false,
    startDate: "",
    endDate: "",
    startMs,
    endMs: Number.isFinite(end) && end > startMs ? end : startMs,
  };
}

/** A calendar's events in the window, recurring ones expanded by Google. */
export async function googleEvents(
  token: string,
  calendar: GoogleCalendar,
  win: { start: number; end: number; timeZone: string },
  limit: number,
  signal: AbortSignal,
): Promise<Occurrence[]> {
  const out: Occurrence[] = [];
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES && out.length < limit; page++) {
    const res = await call(
      token,
      "GET",
      `/calendars/${encodeURIComponent(calendar.id)}/events`,
      signal,
      {
        query: {
          timeMin: new Date(win.start).toISOString(),
          timeMax: new Date(win.end).toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "2500",
          timeZone: win.timeZone,
          ...(pageToken ? { pageToken } : {}),
        },
      },
    );
    if (!ok(res)) throw googleError(res, `reading ${calendar.name}`);
    const items = field(res.body, "items");
    for (const e of Array.isArray(items) ? (items as GoogleEvent[]) : []) {
      const o = occurrenceOf(e, calendar.name, win.timeZone);
      if (o) out.push(o);
    }
    pageToken = String(field(res.body, "nextPageToken") ?? "");
    if (!pageToken) break;
  }
  return out;
}

/**
 * The event's ID from the idempotency key, so a repeat finds the first one.
 * Google takes 5 to 1024 of a to v and 0 to 9, which hex and "sling" are.
 */
export function googleEventId(idempotencyKey: string): string {
  return `sling${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

export interface GoogleNewEvent {
  id: string;
  title: string;
  location: string;
  description: string;
  /** All-day: YYYY-MM-DD, and the day after the last. Timed: epoch milliseconds. */
  allDay: boolean;
  startDate: string;
  endDate: string;
  startMs: number;
  endMs: number;
  timeZone: string;
}

/** Adds an event. Adding the same ID again changes nothing and says so. */
export async function insertGoogleEvent(
  token: string,
  calendar: GoogleCalendar,
  e: GoogleNewEvent,
  signal: AbortSignal,
): Promise<{ created: boolean; event: GoogleEvent }> {
  const when = (date: string, ms: number) =>
    e.allDay ? { date } : { dateTime: new Date(ms).toISOString(), timeZone: e.timeZone };
  const path = `/calendars/${encodeURIComponent(calendar.id)}/events`;
  const res = await call(token, "POST", path, signal, {
    body: {
      id: e.id,
      summary: e.title,
      ...(e.location ? { location: e.location } : {}),
      ...(e.description ? { description: e.description } : {}),
      start: when(e.startDate, e.startMs),
      end: when(e.endDate, e.endMs),
    },
  });
  if (ok(res)) return { created: true, event: res.body as GoogleEvent };
  if (res.status !== 409) throw googleError(res, `adding the event to ${calendar.name}`);
  // The ID is taken: this is a repeat of an event already added.
  const found = await getGoogleEvent(token, calendar, e.id, signal);
  if (!found) {
    throw new NodeError(
      `Google says the event is already in ${calendar.name}, but can't find it.`,
      {
        code: "google_conflict",
      },
    );
  }
  return { created: false, event: found };
}

/** One event by its ID, or null when the calendar doesn't have it. */
export async function getGoogleEvent(
  token: string,
  calendar: GoogleCalendar,
  id: string,
  signal: AbortSignal,
): Promise<GoogleEvent | null> {
  const res = await call(
    token,
    "GET",
    `/calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(id)}`,
    signal,
  );
  if (res.status === 404 || res.status === 410) return null;
  if (!ok(res)) throw googleError(res, `reading the event back from ${calendar.name}`);
  return res.body as GoogleEvent;
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Mon 9 Nov 10:00", or "Mon 9 Nov" for an all-day event, in `zone`. */
export function whenText(o: Pick<Occurrence, "allDay" | "startDate" | "startMs">, zone: string) {
  const date = o.allDay ? o.startDate : dateIn(o.startMs, zone);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const day = `${SHORT_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${SHORT_MONTHS[m - 1]}`;
  if (o.allDay) return day;
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(o.startMs));
  return `${day} ${clock}`;
}

export { errorMessage };
