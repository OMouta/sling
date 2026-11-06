import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Installation, NodeContext } from "@sling/connector-sdk";
import ICAL from "ical.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventIcs, parseWhen, uidFor } from "./calendar.ts";
import { FeedCache } from "./feeds.ts";
import { agendaText } from "./format.ts";
import { collectOccurrences, type Occurrence, parseCalendars, sortOccurrences } from "./ical.ts";
import { createConfigSchema, createEvent, createListEvents, resolveFrom, zoneOf } from "./nodes.ts";
import { configSchema } from "./schemas.ts";
import { startOfDate } from "./zone.ts";

const FEED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//t//EN",
  "BEGIN:VEVENT",
  "UID:standup",
  "DTSTART:20261102T093000Z",
  "DTEND:20261102T094500Z",
  "RRULE:FREQ=DAILY",
  "SUMMARY:Standup",
  "LOCATION:Room 4",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:holiday",
  "DTSTART;VALUE=DATE:20261106",
  "SUMMARY:Office closed",
  "DESCRIPTION:Bank holiday\\nNo deliveries",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:late",
  "DTSTART:20261106T230000Z",
  "DTEND:20261107T010000Z",
  "SUMMARY:Night train",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

let server: Server;
let feedUrl = "";
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "text/calendar" }).end(FEED);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  feedUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/private.ics`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

function context(installation: Installation, timeZone?: string): NodeContext {
  return {
    runId: "run_1",
    nodeId: "n",
    nodeRunId: "nrn_1",
    workflowId: "wf_1",
    workspaceId: "ws_1",
    ownerId: "usr_1",
    iteration: 0,
    attempt: 1,
    idempotencyKey: "run_1:n:0",
    signal: AbortSignal.timeout(5_000),
    log: { info() {}, warn() {}, error() {} },
    installation: async () => installation as never,
    services: timeZone ? { timeZone: async () => timeZone } : {},
  };
}

const feedInstallation = (): Installation => ({
  id: "ins_1",
  connectorId: "calendar",
  name: "Google",
  credentials: { feedUrls: [feedUrl] },
  config: { kind: "ics", feedNames: ["Personal"] },
});

describe("which day today is", () => {
  it("follows the workspace's time zone", () => {
    const now = Date.parse("2026-11-06T23:30:00Z");
    expect(resolveFrom("today", "Europe/Lisbon", now)).toBe("2026-11-06");
    expect(resolveFrom("today", "Asia/Tokyo", now)).toBe("2026-11-07");
    expect(resolveFrom("Tomorrow", "America/Los_Angeles", now)).toBe("2026-11-07");
    expect(resolveFrom("2026-12-24", "UTC", now)).toBe("2026-12-24");
    expect(() => resolveFrom("2026-02-30", "UTC", now)).toThrow(/isn't a date/);
  });

  it("uses UTC when the server gives no zone", async () => {
    expect(await zoneOf(context(feedInstallation()))).toBe("UTC");
    expect(await zoneOf(context(feedInstallation(), "Europe/Lisbon"))).toBe("Europe/Lisbon");
    expect(await zoneOf(context(feedInstallation(), "Nowhere/Else"))).toBe("UTC");
  });
});

describe("the agenda", () => {
  it("lists each day with times in the zone, all-day events first", () => {
    const zone = "Europe/Lisbon";
    const win = {
      start: startOfDate("2026-11-06", zone),
      end: startOfDate("2026-11-08", zone),
      timeZone: zone,
    };
    const out: Occurrence[] = [];
    for (const c of parseCalendars(FEED)) collectOccurrences(c, win, "Personal", out);
    const text = agendaText(sortOccurrences(out), {
      from: "2026-11-06",
      days: 2,
      timeZone: zone,
      truncated: false,
    });
    expect(text).toBe(
      [
        "Calendar for Friday, 6 November 2026 to Saturday, 7 November 2026, times in Europe/Lisbon:",
        "",
        "Friday, 6 November 2026",
        "- All day: Office closed (Personal)",
        "  Notes: Bank holiday No deliveries",
        "- 09:30–09:45: Standup (Personal), at Room 4",
        "- 23:00–Saturday, 7 November 01:00: Night train (Personal)",
        "",
        "Saturday, 7 November 2026",
        "- 09:30–09:45: Standup (Personal), at Room 4",
      ].join("\n"),
    );
    expect(agendaText([], { from: "2026-11-06", days: 1, timeZone: zone, truncated: false })).toBe(
      "Calendar for Friday, 6 November 2026, times in Europe/Lisbon:\n- Nothing on the calendar.",
    );
  });
});

describe("calendar.list_events", () => {
  it("reads today's events from an iCal link, and reuses the feed for five minutes", async () => {
    hits = 0;
    const node = createListEvents(new FeedCache({ now: () => Date.parse("2026-11-06T08:00:00Z") }));
    const ctx = context(feedInstallation(), "Europe/Lisbon");
    const config = { installationId: "ins_1", from: "2026-11-06", days: 1, calendars: [] };
    const result = await node.run?.(ctx, { inputs: {}, config });
    expect(result).toMatchObject({
      exec: "next",
      outputs: {
        date: "2026-11-06",
        events: [
          { title: "Office closed", start: "2026-11-06", end: "2026-11-06", allDay: true },
          { title: "Standup", start: "2026-11-06T09:30:00+00:00", calendar: "Personal" },
          { title: "Night train", end: "2026-11-07T01:00:00+00:00" },
        ],
      },
    });
    await node.run?.(ctx, { inputs: {}, config });
    expect(hits).toBe(1);
  });

  it("names the calendars there are when asked for one that isn't", async () => {
    const node = createListEvents(new FeedCache());
    const ctx = context(feedInstallation(), "UTC");
    await expect(
      node.run?.(ctx, {
        inputs: {},
        config: { installationId: "ins_1", from: "today", days: 1, calendars: ["Work"] },
      }),
    ).rejects.toThrow("No calendar called Work in Google. Calendars: Personal.");
  });

  it("refuses to add events to iCal links", async () => {
    const ctx = context(feedInstallation(), "UTC");
    await expect(
      createEvent.run?.(ctx, {
        inputs: {},
        config: createConfigSchema.parse({
          installationId: "ins_1",
          title: "Dinner",
          start: "2026-11-06T19:00",
        }),
      }),
    ).rejects.toThrow(/can't take new events/);
  });
});

describe("adding an event", () => {
  it("reads typed times in the workspace's zone unless they carry an offset", () => {
    const zone = "Europe/Lisbon";
    expect(new Date(parseWhen("2026-07-01T14:00", zone, "start")).toISOString()).toBe(
      "2026-07-01T13:00:00.000Z",
    );
    expect(new Date(parseWhen("2026-07-01 14:00:30", zone, "start")).toISOString()).toBe(
      "2026-07-01T13:00:30.000Z",
    );
    expect(new Date(parseWhen("2026-07-01T14:00:00-04:00", zone, "start")).toISOString()).toBe(
      "2026-07-01T18:00:00.000Z",
    );
    expect(new Date(parseWhen("2026-07-01T14:00Z", zone, "start")).toISOString()).toBe(
      "2026-07-01T14:00:00.000Z",
    );
    expect(() => parseWhen("tomorrow at 2", zone, "start")).toThrow(/should look like/);
  });

  it("writes a UID from the idempotency key, and text that round-trips", () => {
    expect(uidFor("chat:call_1")).toBe(uidFor("chat:call_1"));
    expect(uidFor("chat:call_1")).not.toBe(uidFor("chat:call_2"));
    const ics = eventIcs({
      uid: uidFor("chat:call_1"),
      title: "Dinner; with Ana, maybe",
      location: "Café Central",
      description: "Line one\nLine two",
      allDay: false,
      startMs: Date.parse("2026-11-06T19:00:00Z"),
      endMs: Date.parse("2026-11-06T21:00:00Z"),
      startDate: "2026-11-06",
      endDate: "2026-11-06",
      now: Date.parse("2026-11-06T08:00:00Z"),
    });
    expect(ics).toContain("SUMMARY:Dinner\\; with Ana\\, maybe");
    expect(ics).toContain("DTSTART:20261106T190000Z");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    const vevent = new ICAL.Component(ICAL.parse(ics) as unknown[]).getFirstSubcomponent("vevent");
    if (!vevent) throw new Error("no VEVENT");
    const event = new ICAL.Event(vevent);
    expect([event.summary, event.location, event.description]).toEqual([
      "Dinner; with Ana, maybe",
      "Café Central",
      "Line one\nLine two",
    ]);
  });

  it("checks CalDAV settings when an installation is saved", () => {
    expect(configSchema.safeParse({ kind: "caldav", serverUrl: "", username: "" }).success).toBe(
      false,
    );
    expect(
      configSchema.safeParse({ kind: "caldav", serverUrl: "https://dav.example", username: "a" })
        .success,
    ).toBe(true);
    expect(configSchema.safeParse({ kind: "ics" }).success).toBe(true);
  });
});
