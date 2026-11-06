/**
 * iCal links, such as Google's or Outlook's private address for a calendar.
 * A feed is fetched at most every five minutes; after that Sling asks again
 * with its ETag, and a 304 keeps the parsed copy, so a large feed isn't
 * parsed twice.
 */
import { createHash } from "node:crypto";
import { NodeError } from "@sling/connector-sdk";
import type ICAL from "ical.js";
import { request } from "./http.ts";
import { CalendarParseError, countEvents, parseCalendars } from "./ical.ts";

type Component = InstanceType<typeof ICAL.Component>;

export const FEED_TTL_MS = 5 * 60_000;
const MAX_FEEDS_CACHED = 100;

export interface Feed {
  calendars: Component[];
  /** Events in the feed, with each recurring series counted once. */
  events: number;
}

interface Entry extends Feed {
  etag: string | null;
  lastModified: string | null;
  checkedAt: number;
}

/** webcal:// is how calendar apps link a feed; it's plain HTTPS underneath. */
export function feedUrl(raw: string): string {
  const url = raw.trim().replace(/^webcals?:\/\//i, "https://");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NodeError("An iCal link isn't a valid URL.", { code: "invalid_feed_url" });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new NodeError("An iCal link has to start with https://, http://, or webcal://.", {
      code: "invalid_feed_url",
    });
  }
  return parsed.toString();
}

/** A feed's host, for messages. The path is the secret part of a private address. */
export function feedLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the iCal link";
  }
}

export interface FeedCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

export class FeedCache {
  readonly #entries = new Map<string, Entry>();
  readonly #ttl: number;
  readonly #now: () => number;
  /** Requests sent, for tests. */
  requests = 0;

  constructor(opts: FeedCacheOptions = {}) {
    this.#ttl = opts.ttlMs ?? FEED_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** Keyed by a hash, so the cache never holds the secret address itself as a key. */
  #key(url: string) {
    return createHash("sha256").update(url).digest("base64url");
  }

  /** The feed, from the cache when it's fresh. `fresh` skips the cache, for connection tests. */
  async get(raw: string, signal: AbortSignal, opts: { fresh?: boolean } = {}): Promise<Feed> {
    const url = feedUrl(raw);
    const key = this.#key(url);
    const hit = this.#entries.get(key);
    const now = this.#now();
    if (hit && !opts.fresh && now - hit.checkedAt < this.#ttl) return hit;

    const headers: Record<string, string> = { accept: "text/calendar, */*;q=0.5" };
    if (hit && !opts.fresh) {
      if (hit.etag) headers["if-none-match"] = hit.etag;
      if (hit.lastModified) headers["if-modified-since"] = hit.lastModified;
    }
    const what = `The iCal link at ${feedLabel(url)}`;
    this.requests++;
    const res = await request(url, { method: "GET", headers, signal }, what);
    if (res.status === 304 && hit) {
      hit.checkedAt = now;
      return hit;
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new NodeError(
        `${what} answered ${res.status}. The link may have been reset; copy the private iCal address again.`,
        { code: "feed_unavailable" },
      );
    }
    if (res.status < 200 || res.status > 299) {
      throw new NodeError(`${what} answered ${res.status}.`, {
        code: "feed_unavailable",
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    let calendars: Component[];
    try {
      calendars = parseCalendars(res.body);
    } catch (err) {
      if (err instanceof CalendarParseError) {
        throw new NodeError(`${what} didn't send a calendar. ${err.message}`, {
          code: "feed_invalid",
        });
      }
      throw err;
    }
    if (calendars.length === 0 || !calendars.some((c) => c.name === "vcalendar")) {
      throw new NodeError(`${what} didn't send a calendar.`, { code: "feed_invalid" });
    }
    const entry: Entry = {
      calendars,
      events: countEvents(calendars),
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      checkedAt: now,
    };
    if (this.#entries.size >= MAX_FEEDS_CACHED && !this.#entries.has(key)) {
      const oldest = this.#entries.keys().next().value;
      if (oldest) this.#entries.delete(oldest);
    }
    this.#entries.set(key, entry);
    return entry;
  }
}
