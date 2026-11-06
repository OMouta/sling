/**
 * The calendar connector against Radicale, a real CalDAV server, in Docker,
 * and against a local HTTP server for iCal links.
 * `pnpm --filter @sling/integration-calendar test:integration`
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Installation, NodeContext } from "@sling/connector-sdk";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calendarTag, discover, eventData } from "../src/caldav.ts";
import { FeedCache } from "../src/feeds.ts";
import { collectOccurrences, type Occurrence, parseCalendars } from "../src/ical.ts";
import { createCalendarConnector } from "../src/index.ts";
import { createEvent, createListEvents } from "../src/nodes.ts";
import { addDays, dateIn, startOfDate } from "../src/zone.ts";

const IMAGE = "tomsquest/docker-radicale:3.8.3.0";
const ZONE = "Europe/Lisbon";
const USER = "ana";
const PASSWORD = "app-pass";

const CONFIG = `[server]
hosts = 0.0.0.0:5232
[auth]
type = htpasswd
htpasswd_filename = /config/users
htpasswd_encryption = plain
[rights]
type = owner_only
[storage]
filesystem_folder = /data/collections
`;

let radicale: StartedTestContainer;
let base = "";
const auth = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;

async function dav(method: string, path: string, body = "", headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: auth, ...headers },
    body: body || undefined,
  });
  return { status: res.status, text: await res.text() };
}

async function mkcalendar(slug: string, name: string) {
  const res = await dav(
    "MKCALENDAR",
    `/${USER}/${slug}/`,
    `<?xml version="1.0" encoding="utf-8"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>${name}</D:displayname></D:prop></D:set></C:mkcalendar>`,
    { "content-type": "application/xml" },
  );
  if (res.status !== 201) throw new Error(`MKCALENDAR ${slug}: ${res.status} ${res.text}`);
}

async function put(slug: string, uid: string, ics: string) {
  const res = await dav("PUT", `/${USER}/${slug}/${uid}.ics`, ics, {
    "content-type": "text/calendar; charset=utf-8",
  });
  if (res.status !== 201 && res.status !== 204) throw new Error(`PUT ${uid}: ${res.status}`);
}

const LISBON_TZ = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Lisbon",
  "BEGIN:STANDARD",
  "DTSTART:19701025T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T010000",
  "TZOFFSETFROM:+0000",
  "TZOFFSETTO:+0100",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

const vcal = (...lines: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sling tests//EN",
    ...lines,
    "END:VCALENDAR",
    "",
  ].join("\r\n");

const caldav = (): Installation => ({
  id: "ins_cal",
  connectorId: "calendar",
  name: "Radicale",
  credentials: { password: PASSWORD },
  config: {
    kind: "caldav",
    serverUrl: `${base}/`,
    username: USER,
    calendars: [],
    defaultCalendar: "Home",
  },
});

function context(installation: Installation, idempotencyKey = "run_1:node:0"): NodeContext {
  return {
    runId: "run_1",
    nodeId: "node",
    nodeRunId: "nrn_1",
    workflowId: "wf_1",
    workspaceId: "ws_1",
    ownerId: "usr_1",
    iteration: 0,
    attempt: 1,
    idempotencyKey,
    signal: AbortSignal.timeout(30_000),
    log: { info() {}, warn() {}, error() {} },
    installation: async () => installation as never,
    services: { timeZone: async () => ZONE },
  };
}

const today = () => dateIn(Date.now(), ZONE);

interface Listed {
  events: { title: string; start: string }[];
  agenda: string;
  date: string;
}

/** A node's outputs, from a run that went on to `next`. */
function outputsOf<T = Listed>(result: unknown): T {
  return (result as { outputs: T }).outputs;
}

beforeAll(async () => {
  radicale = await new GenericContainer(IMAGE)
    .withCopyContentToContainer([
      { content: CONFIG, target: "/config/config" },
      { content: `${USER}:${PASSWORD}\n`, target: "/config/users" },
    ])
    .withExposedPorts(5232)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  base = `http://${radicale.getHost()}:${radicale.getMappedPort(5232)}`;
  // Radicale makes the user's principal on their first request.
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/`, {
      method: "PROPFIND",
      headers: { authorization: auth, depth: "0" },
    }).catch(() => null);
    if (res?.status === 207) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await mkcalendar("home", "Home");
  await mkcalendar("work", "Work");
  await mkcalendar("family", "Family");

  // Every weekday since last year at 09:30 Lisbon time, so today's has to be expanded.
  await put(
    "work",
    "standup",
    vcal(
      ...LISBON_TZ,
      "BEGIN:VEVENT",
      "UID:standup",
      "DTSTAMP:20250101T000000Z",
      "DTSTART;TZID=Europe/Lisbon:20250106T093000",
      "DTEND;TZID=Europe/Lisbon:20250106T094500",
      "RRULE:FREQ=DAILY",
      "SUMMARY:Standup",
      "END:VEVENT",
    ),
  );
  // A weekly series with one week skipped and one moved, across the October clock change.
  await put(
    "family",
    "swim",
    vcal(
      ...LISBON_TZ,
      "BEGIN:VEVENT",
      "UID:swim",
      "DTSTAMP:20250101T000000Z",
      "DTSTART;TZID=Europe/Lisbon:20261003T100000",
      "DTEND;TZID=Europe/Lisbon:20261003T110000",
      "RRULE:FREQ=WEEKLY;COUNT=8",
      "EXDATE;TZID=Europe/Lisbon:20261017T100000",
      "SUMMARY:Swimming",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:swim",
      "DTSTAMP:20250101T000000Z",
      "RECURRENCE-ID;TZID=Europe/Lisbon:20261024T100000",
      "DTSTART;TZID=Europe/Lisbon:20261025T120000",
      "DTEND;TZID=Europe/Lisbon:20261025T130000",
      "SUMMARY:Swimming (Sunday)",
      "END:VEVENT",
    ),
  );
}, 180_000);

afterAll(async () => {
  await radicale?.stop();
});

describe("a CalDAV installation", () => {
  it("passes its connection test and lists the calendars", async () => {
    const connector = createCalendarConnector();
    const inst = caldav();
    const result = await connector.test({
      credentials: inst.credentials as never,
      config: inst.config as never,
      log: { info() {}, warn() {}, error() {} },
      signal: AbortSignal.timeout(20_000),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail).toMatch(/^Found 3 calendars: /);
    for (const name of ["Home", "Work", "Family"]) expect(result.detail).toContain(name);

    const wrong = await connector.test({
      credentials: { password: "nope" },
      config: inst.config as never,
      log: { info() {}, warn() {}, error() {} },
      signal: AbortSignal.timeout(20_000),
    });
    expect(wrong).toEqual({ ok: false, error: expect.stringContaining("CalDAV login failed") });
  });

  it("returns today's events in the workspace's zone, recurring ones included", async () => {
    const node = createListEvents(new FeedCache());
    const result = await node.run?.(context(caldav()), {
      inputs: {},
      config: { installationId: "ins_cal", from: "today", days: 1, calendars: [] },
    });
    const outputs = outputsOf(result);
    expect(outputs.date).toBe(today());
    const standup = outputs.events.find((e) => e.title === "Standup");
    expect(standup?.start.slice(0, 16)).toBe(`${today()}T09:30`);
    expect(outputs.agenda).toContain("09:30–09:45: Standup (Work)");
  });

  it("expands exceptions across the clock change", async () => {
    const node = createListEvents(new FeedCache());
    const result = await node.run?.(context(caldav()), {
      inputs: {},
      config: { installationId: "ins_cal", from: "2026-10-01", days: 31, calendars: ["family"] },
    });
    const { events } = outputsOf(result);
    expect(events.map((e) => [e.title, e.start])).toEqual([
      ["Swimming", "2026-10-03T10:00:00+01:00"],
      ["Swimming", "2026-10-10T10:00:00+01:00"],
      ["Swimming (Sunday)", "2026-10-25T12:00:00+00:00"],
      ["Swimming", "2026-10-31T10:00:00+00:00"],
    ]);
  });

  it("adds an event once, however often it's asked with the same key", async () => {
    const config = {
      installationId: "ins_cal",
      calendar: "",
      title: "Dentist",
      start: `${addDays(today(), 1)}T15:00`,
      end: "",
      durationMinutes: 45,
      allDay: false,
      location: "Rua Augusta 10",
      description: "",
    };
    const first = await createEvent.run?.(context(caldav(), "chat:call_dentist"), {
      inputs: {},
      config,
    });
    expect(first).toMatchObject({
      exec: "next",
      outputs: { created: true, event: { title: "Dentist", calendar: "Home" } },
    });
    const again = await createEvent.run?.(context(caldav(), "chat:call_dentist"), {
      inputs: {},
      config: { ...config, title: "Dentist (again)" },
    });
    expect(again).toMatchObject({ outputs: { created: false } });

    const [home] = (
      await discover(
        { serverUrl: `${base}/`, username: USER, password: PASSWORD },
        AbortSignal.timeout(10_000),
      )
    ).filter((c) => c.name === "Home");
    if (!home) throw new Error("no Home calendar");
    const start = startOfDate(addDays(today(), 1), ZONE);
    const stored = await eventData(
      { serverUrl: `${base}/`, username: USER, password: PASSWORD },
      home,
      { start, end: start + 86_400_000 },
      AbortSignal.timeout(10_000),
    );
    expect(stored).toHaveLength(1);
    // Line endings come back as LF: XML normalizes them.
    expect(stored[0]).toMatch(/^SUMMARY:Dentist\r?$/m);

    const list = createListEvents(new FeedCache());
    const read = await list.run?.(context(caldav()), {
      inputs: {},
      config: { installationId: "ins_cal", from: "tomorrow", days: 1, calendars: ["Home"] },
    });
    expect(outputsOf(read).events).toEqual([
      {
        title: "Dentist",
        start: expect.stringMatching(/T15:00:00\+0[01]:00$/),
        end: expect.stringMatching(/T15:45:00\+0[01]:00$/),
        allDay: false,
        location: "Rua Augusta 10",
        description: "",
        calendar: "Home",
      },
    ]);
  });

  it("reads today out of 1,000 events, with recurring ones, within 300 ms once the calendar is known", async () => {
    await mkcalendar("busy", "Busy");
    const day = today();
    const events: string[] = [];
    for (let i = 0; i < 1_000; i++) {
      // One in five repeats, from up to a year back; the rest are spread over a year.
      const recurring = i % 5 === 0;
      const date = addDays(day, recurring ? -400 + (i % 300) : -180 + (i % 360)).replace(/-/g, "");
      const hour = String(8 + (i % 10)).padStart(2, "0");
      events.push(
        "BEGIN:VEVENT",
        `UID:e${i}`,
        "DTSTAMP:20250101T000000Z",
        `DTSTART;TZID=Europe/Lisbon:${date}T${hour}0000`,
        `DTEND;TZID=Europe/Lisbon:${date}T${hour}3000`,
        ...(recurring ? [i % 2 ? "RRULE:FREQ=WEEKLY" : "RRULE:FREQ=DAILY;INTERVAL=2"] : []),
        `SUMMARY:Event ${i}`,
        `DESCRIPTION:${"Agenda item. ".repeat(10)}`,
        "END:VEVENT",
      );
    }
    // Radicale splits a calendar PUT to a collection into one item per UID, in one request.
    const upload = await dav("PUT", `/${USER}/busy/`, vcal(...LISBON_TZ, ...events), {
      "content-type": "text/calendar; charset=utf-8",
    });
    if (upload.status !== 201 && upload.status !== 204) {
      throw new Error(`upload: ${upload.status} ${upload.text}`);
    }
    await dav(
      "PROPPATCH",
      `/${USER}/busy/`,
      '<?xml version="1.0" encoding="utf-8"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>Busy</D:displayname></D:prop></D:set></D:propertyupdate>',
      { "content-type": "application/xml" },
    );

    const node = createListEvents(new FeedCache());
    const run = async () => {
      const t0 = performance.now();
      const r = await node.run?.(context(caldav()), {
        inputs: {},
        config: { installationId: "ins_cal", from: "today", days: 1, calendars: ["Busy"] },
      });
      return { ms: performance.now() - t0, count: outputsOf(r).events.length };
    };
    // Radicale's REPORT alone. Radicale works out a new collection's tag and item cache on
    // its first requests, which takes it a couple of seconds after an upload; warm both first.
    const account = { serverUrl: `${base}/`, username: USER, password: PASSWORD };
    const [busy] = (await discover(account, AbortSignal.timeout(10_000))).filter(
      (c) => c.name === "Busy",
    );
    if (!busy) throw new Error("no Busy calendar");
    const start = startOfDate(day, ZONE);
    await calendarTag(account, busy, AbortSignal.timeout(30_000));
    await eventData(account, busy, { start, end: start + 86_400_000 }, AbortSignal.timeout(30_000));
    const server: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await eventData(
        account,
        busy,
        { start, end: start + 86_400_000 },
        AbortSignal.timeout(10_000),
      );
      server.push(performance.now() - t0);
    }
    server.sort((a, b) => a - b);

    // The first read fetches the day's events; later ones find the calendar unchanged.
    const cold = await run();
    const times: number[] = [];
    let count = 0;
    for (let i = 0; i < 5; i++) {
      const r = await run();
      times.push(r.ms);
      count = r.count;
    }
    times.sort((a, b) => a - b);
    const median = times[2] ?? 0;
    console.log(
      `today's ${count} events out of 1,000 on CalDAV: first read ${cold.ms.toFixed(0)} ms, of which Radicale's REPORT is ${(server[2] ?? 0).toFixed(0)} ms; later reads median ${median.toFixed(1)} ms (${times.map((t) => t.toFixed(0)).join(", ")})`,
    );
    expect(cold.count).toBe(count);
    expect(count).toBeGreaterThan(0);
    expect(median).toBeLessThan(300);
  });
});

describe("iCal links", () => {
  let server: Server;
  let url = "";
  const requests: { ifNoneMatch: string | undefined }[] = [];
  let body = "";

  beforeAll(async () => {
    body = vcal(
      "BEGIN:VEVENT",
      "UID:a",
      "DTSTART:20261106T100000Z",
      "SUMMARY:One",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:b",
      "DTSTART;VALUE=DATE:20261106",
      "RRULE:FREQ=YEARLY",
      "SUMMARY:Birthday",
      "END:VEVENT",
    );
    server = createServer((req, res) => {
      const inm = req.headers["if-none-match"] as string | undefined;
      requests.push({ ifNoneMatch: inm });
      if (inm === '"v1"') {
        res.writeHead(304, { etag: '"v1"' }).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/calendar", etag: '"v1"' }).end(body);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/secret/basic.ics`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it("passes the connection test with the number of events", async () => {
    const connector = createCalendarConnector();
    const result = await connector.test({
      credentials: { feedUrls: [url] },
      config: {
        kind: "ics",
        serverUrl: "",
        username: "",
        calendars: [],
        defaultCalendar: "",
        feedNames: ["Google"],
      },
      log: { info() {}, warn() {}, error() {} },
      signal: AbortSignal.timeout(10_000),
    });
    expect(result).toEqual({ ok: true, detail: "2 events." });
  });

  it("asks again with the ETag after five minutes and keeps the parsed feed on a 304", async () => {
    let now = Date.parse("2026-11-06T08:00:00Z");
    const cache = new FeedCache({ now: () => now });
    requests.length = 0;
    const first = await cache.get(url, AbortSignal.timeout(5_000));
    const again = await cache.get(url, AbortSignal.timeout(5_000));
    expect(again).toBe(first);
    expect(requests).toEqual([{ ifNoneMatch: undefined }]);
    now += 5 * 60_000 + 1;
    const later = await cache.get(url, AbortSignal.timeout(5_000));
    expect(requests).toEqual([{ ifNoneMatch: undefined }, { ifNoneMatch: '"v1"' }]);
    expect(later).toBe(first);
  });

  it("parses a 1 MB feed within 150 ms", () => {
    const lines: string[] = [];
    let i = 0;
    while (lines.join("\r\n").length < 1_048_576) {
      for (let k = 0; k < 200; k++, i++) {
        const date = `2026${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}`;
        lines.push(
          "BEGIN:VEVENT",
          `UID:feed-${i}`,
          `DTSTART:${date}T090000Z`,
          `DTEND:${date}T100000Z`,
          ...(i % 10 === 0 ? ["RRULE:FREQ=WEEKLY"] : []),
          `SUMMARY:Event number ${i}`,
          `LOCATION:Room ${i % 40}`,
          `DESCRIPTION:${"Notes for the meeting\\, with details. ".repeat(4)}`,
          "END:VEVENT",
        );
      }
    }
    const text = vcal(...lines);
    expect(text.length).toBeGreaterThan(1_000_000);
    const win = {
      start: startOfDate("2026-11-06", ZONE),
      end: startOfDate("2026-11-07", ZONE),
      timeZone: ZONE,
    };
    const runs: number[] = [];
    let found = 0;
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      const out: Occurrence[] = [];
      for (const c of parseCalendars(text)) collectOccurrences(c, win, "Feed", out);
      runs.push(performance.now() - t0);
      found = out.length;
    }
    runs.sort((a, b) => a - b);
    const median = runs[2] ?? 0;
    console.log(
      `1 MB feed (${(text.length / 1_048_576).toFixed(2)} MB, ${i} events): parse and read a day, median ${median.toFixed(1)} ms; ${found} events that day`,
    );
    expect(median).toBeLessThan(150);
  });
});
