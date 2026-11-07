/**
 * The little of CalDAV the calendar needs, over fetch: find the calendars
 * (PROPFIND for the principal, its calendar home, and the collections in
 * it), read events in a time range (a calendar-query REPORT), and add one
 * (a PUT that never replaces an existing event).
 */
import { createHash } from "node:crypto";
import { NodeError } from "@sling/connector-sdk";
import { XMLParser } from "fast-xml-parser";
import { type HttpAnswer, request } from "./http.ts";

export interface CalDavAccount {
  serverUrl: string;
  username: string;
  password: string;
}

export interface DavCalendar {
  url: string;
  name: string;
}

export interface DavResponse {
  href: string;
  /** The response's own status, when it has one instead of propstats. */
  status: number | null;
  /** Properties from every propstat that succeeded, by local name. */
  props: Record<string, unknown>;
}

/** How long the calendars found for an account are reused. */
const DISCOVERY_TTL_MS = 5 * 60_000;
const SERVER = "The CalDAV server";

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) =>
    name === "response" || name === "propstat" || name === "href" || name === "comp",
});

function statusCode(line: unknown): number | null {
  const m = typeof line === "string" ? /\s(\d{3})(\s|$)/.exec(line) : null;
  return m?.[1] ? Number(m[1]) : null;
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "#text" in v)
    return String((v as { "#text": unknown })["#text"]);
  return "";
}

/** The responses in a 207 Multi-Status body. */
export function parseMultistatus(xml: string): DavResponse[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new NodeError(`${SERVER} sent XML Sling couldn't read: ${(err as Error).message}`, {
      code: "caldav_bad_response",
    });
  }
  const ms = doc.multistatus as { response?: unknown[] } | undefined;
  const out: DavResponse[] = [];
  for (const raw of ms?.response ?? []) {
    const r = raw as { href?: unknown[]; status?: unknown; propstat?: unknown[] };
    const href = textOf(r.href?.[0]).trim();
    const props: Record<string, unknown> = {};
    for (const ps of (r.propstat ?? []) as { status?: unknown; prop?: unknown }[]) {
      const code = statusCode(ps.status);
      if (code === null || code < 200 || code > 299) continue;
      if (ps.prop && typeof ps.prop === "object") Object.assign(props, ps.prop);
    }
    out.push({ href, status: statusCode(r.status), props });
  }
  return out;
}

/** The first href inside a property such as current-user-principal. */
export function hrefIn(prop: unknown): string | null {
  if (!prop || typeof prop !== "object") return null;
  const hrefs = (prop as { href?: unknown[] }).href;
  const h = textOf(hrefs?.[0]).trim();
  return h || null;
}

/** Whether a resourcetype marks a calendar collection. */
export function isCalendar(resourcetype: unknown): boolean {
  return Boolean(resourcetype && typeof resourcetype === "object" && "calendar" in resourcetype);
}

/** Whether a collection can hold events. Collections that don't say are taken to. */
export function holdsEvents(compSet: unknown): boolean {
  const comps = (compSet as { comp?: { "@name"?: unknown }[] } | undefined)?.comp;
  if (!comps?.length) return true;
  return comps.some((c) => String(c["@name"] ?? "").toUpperCase() === "VEVENT");
}

function lastSegment(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const last = parts.at(-1) ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function authHeader(a: CalDavAccount): string {
  return `Basic ${Buffer.from(`${a.username}:${a.password}`).toString("base64")}`;
}

function failure(res: HttpAnswer, action: string): NodeError {
  if (res.status === 401) {
    return new NodeError(
      "CalDAV login failed. Check the username, and use an app password if your provider requires one.",
      { code: "caldav_unauthorized" },
    );
  }
  if (res.status === 403) {
    return new NodeError(`${SERVER} refused ${action} (403). The account may not have access.`, {
      code: "caldav_forbidden",
    });
  }
  if (res.status === 404) {
    return new NodeError(`${SERVER} has nothing at ${new URL(res.url).pathname} (404).`, {
      code: "caldav_not_found",
    });
  }
  const detail = res.body.replace(/\s+/g, " ").trim().slice(0, 200);
  return new NodeError(
    `${SERVER} answered ${res.status} to ${action}${detail ? `: ${detail}` : ""}`,
    {
      code: "caldav_error",
      retryable: res.status >= 500 || res.status === 429,
    },
  );
}

async function dav(
  a: CalDavAccount,
  method: "PROPFIND" | "REPORT",
  url: string,
  depth: "0" | "1",
  body: string,
  signal: AbortSignal,
): Promise<HttpAnswer> {
  return request(
    url,
    {
      method,
      headers: {
        authorization: authHeader(a),
        "content-type": 'application/xml; charset="utf-8"',
        depth,
      },
      body,
      signal,
    },
    SERVER,
  );
}

const propfind = (props: string) =>
  `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`;

async function propfindAt(
  a: CalDavAccount,
  url: string,
  depth: "0" | "1",
  props: string,
  signal: AbortSignal,
): Promise<{ answer: HttpAnswer; responses: DavResponse[] }> {
  const answer = await dav(a, "PROPFIND", url, depth, propfind(props), signal);
  if (answer.status !== 207) return { answer, responses: [] };
  return { answer, responses: parseMultistatus(answer.body) };
}

/**
 * Finds the account's calendars: the principal, its calendar home, and the
 * calendar collections there that hold events. A server URL that is itself
 * a calendar gives just that one.
 */
export async function discover(a: CalDavAccount, signal: AbortSignal): Promise<DavCalendar[]> {
  const first =
    "<d:current-user-principal/><c:calendar-home-set/><d:resourcetype/><d:displayname/>";
  let { answer, responses } = await propfindAt(a, a.serverUrl, "0", first, signal);
  if (answer.status === 401) throw failure(answer, "the login");
  if (answer.status !== 207 || !responses[0]) {
    // Providers that publish only a domain answer at the well-known address.
    const wellKnown = new URL("/.well-known/caldav", a.serverUrl).toString();
    const retry = await propfindAt(a, wellKnown, "0", first, signal);
    if (retry.answer.status !== 207 || !retry.responses[0]) throw failure(answer, "PROPFIND");
    ({ answer, responses } = retry);
  }
  const root = responses[0];
  const base = answer.url;
  if (root && isCalendar(root.props.resourcetype)) {
    const name = textOf(root.props.displayname).trim() || lastSegment(base);
    return [{ url: base, name }];
  }
  let home = hrefIn(root?.props["calendar-home-set"]);
  const principal = hrefIn(root?.props["current-user-principal"]);
  if (!home && principal) {
    const url = new URL(principal, base).toString();
    const p = await propfindAt(a, url, "0", "<c:calendar-home-set/>", signal);
    if (p.answer.status !== 207) throw failure(p.answer, "PROPFIND on the principal");
    home = hrefIn(p.responses[0]?.props["calendar-home-set"]);
  }
  const homeUrl = new URL(home ?? base, base).toString();
  const list = await propfindAt(
    a,
    homeUrl,
    "1",
    "<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>",
    signal,
  );
  if (list.answer.status !== 207) throw failure(list.answer, "PROPFIND on the calendar home");
  const calendars: DavCalendar[] = [];
  for (const r of list.responses) {
    if (!isCalendar(r.props.resourcetype)) continue;
    if (!holdsEvents(r.props["supported-calendar-component-set"])) continue;
    const url = new URL(r.href, list.answer.url).toString();
    calendars.push({ url, name: textOf(r.props.displayname).trim() || lastSegment(url) });
  }
  return calendars;
}

const discovered = new Map<string, { at: number; calendars: DavCalendar[] }>();

function accountKey(a: CalDavAccount): string {
  const secret = createHash("sha256").update(a.password).digest("hex").slice(0, 16);
  return `${a.serverUrl}\n${a.username}\n${secret}`;
}

/** The account's calendars, found again at most every five minutes. */
export async function calendarsOf(
  a: CalDavAccount,
  signal: AbortSignal,
  now = Date.now(),
): Promise<DavCalendar[]> {
  const key = accountKey(a);
  const hit = discovered.get(key);
  if (hit && now - hit.at < DISCOVERY_TTL_MS) return hit.calendars;
  const calendars = await discover(a, signal);
  if (discovered.size > 200) discovered.clear();
  discovered.set(key, { at: now, calendars });
  return calendars;
}

/** Forgets what was found for an account, after a calendar it listed went missing. */
export function forgetCalendars(a: CalDavAccount): void {
  discovered.delete(accountKey(a));
}

/** An instant as iCalendar UTC: 20261106T000000Z. */
export function utcStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * A value that changes whenever anything in the calendar does: the
 * calendarserver ctag, which iCloud, Fastmail, Nextcloud, and Radicale all
 * give, or else the sync token. Null when the server gives neither.
 */
export async function calendarTag(
  a: CalDavAccount,
  calendar: DavCalendar,
  signal: AbortSignal,
): Promise<string | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop><cs:getctag/><d:sync-token/></d:prop></d:propfind>`;
  const res = await dav(a, "PROPFIND", calendar.url, "0", body, signal);
  if (res.status !== 207) return null;
  const props = parseMultistatus(res.body)[0]?.props ?? {};
  const tag = textOf(props.getctag).trim() || textOf(props["sync-token"]).trim();
  return tag || null;
}

/** The iCalendar text of every event in a calendar that has an instance in the range. */
export async function eventData(
  a: CalDavAccount,
  calendar: DavCalendar,
  range: { start: number; end: number },
  signal: AbortSignal,
): Promise<string[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${utcStamp(range.start)}" end="${utcStamp(range.end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const res = await dav(a, "REPORT", calendar.url, "1", body, signal);
  if (res.status !== 207) throw failure(res, `reading ${calendar.name}`);
  const out: string[] = [];
  for (const r of parseMultistatus(res.body)) {
    const data = textOf(r.props["calendar-data"]);
    if (data.trim()) out.push(data);
  }
  return out;
}

/**
 * Adds an event as `<name>` in the calendar. `If-None-Match: *` means an
 * event already stored there is never replaced, so a repeat adds nothing.
 */
export async function putEvent(
  a: CalDavAccount,
  calendar: DavCalendar,
  name: string,
  ics: string,
  signal: AbortSignal,
): Promise<"created" | "exists"> {
  const base = calendar.url.endsWith("/") ? calendar.url : `${calendar.url}/`;
  const res = await request(
    new URL(encodeURIComponent(name), base).toString(),
    {
      method: "PUT",
      headers: {
        authorization: authHeader(a),
        "content-type": "text/calendar; charset=utf-8",
        "if-none-match": "*",
      },
      body: ics,
      signal,
    },
    SERVER,
  );
  if (res.status === 201 || res.status === 204 || res.status === 200) return "created";
  if (res.status === 412) return "exists";
  throw failure(res, `adding the event to ${calendar.name}`);
}

/**
 * Reads one event back by its resource name, as `putEvent` stored it. Null
 * when the calendar has nothing by that name.
 */
export async function getEvent(
  a: CalDavAccount,
  calendar: DavCalendar,
  name: string,
  signal: AbortSignal,
): Promise<string | null> {
  const base = calendar.url.endsWith("/") ? calendar.url : `${calendar.url}/`;
  const res = await request(
    new URL(encodeURIComponent(name), base).toString(),
    { method: "GET", headers: { authorization: authHeader(a), accept: "text/calendar" }, signal },
    SERVER,
  );
  if (res.status === 404 || res.status === 410) return null;
  if (res.status >= 200 && res.status <= 299) return res.body;
  throw failure(res, `reading the event back from ${calendar.name}`);
}
