/**
 * The Google kind against a local stand-in for Calendar API v3: the calendar
 * list, events over a window with recurrences already expanded, insert with
 * a chosen ID and its 409 on a repeat, and reading an event back.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Installation, NodeContext } from "@sling/connector-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FeedCache } from "./feeds.ts";
import { type GoogleEvent, googleEventId, occurrenceOf, whenText } from "./google.ts";
import { createCalendarConnector } from "./index.ts";
import { createConfigSchema, createEvent, createListEvents } from "./nodes.ts";

const TOKEN = "ya29.live-token";
const ZONE = "Europe/Lisbon";

interface Stored {
  calendar: string;
  event: GoogleEvent & Record<string, unknown>;
}

let server: Server;
let base = "";
let events: Stored[] = [];
const seen: { method: string; path: string; query: URLSearchParams; auth: string }[] = [];

const CALENDARS = [
  { id: "team@group.calendar.google.com", summary: "Team", accessRole: "reader" },
  { id: "ana@gmail.com", summary: "ana@gmail.com", primary: true, accessRole: "owner" },
  {
    id: "work@group.calendar.google.com",
    summary: "Work stuff",
    summaryOverride: "Work",
    accessRole: "writer",
  },
];

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/^\/calendar\/v3/, "");
    seen.push({
      method: req.method ?? "",
      path,
      query: url.searchParams,
      auth: req.headers.authorization ?? "",
    });
    const json = (status: number, value: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return json(401, { error: { code: 401, message: "Invalid Credentials" } });
    }
    if (req.method === "GET" && path === "/users/me/calendarList") {
      return json(200, { items: CALENDARS });
    }
    const list = /^\/calendars\/([^/]+)\/events$/.exec(path);
    if (list?.[1]) {
      const calendar = decodeURIComponent(list[1]);
      if (req.method === "GET") {
        const min = Date.parse(url.searchParams.get("timeMin") ?? "");
        const max = Date.parse(url.searchParams.get("timeMax") ?? "");
        const items = events
          .filter((e) => e.calendar === calendar)
          .map((e) => e.event)
          .filter((e) => {
            const s = Date.parse(e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`);
            return s < max && s >= min - 86_400_000;
          });
        return json(200, { items });
      }
      const event = (await body(req)) as GoogleEvent & Record<string, unknown>;
      if (events.some((e) => e.calendar === calendar && e.event.id === event.id)) {
        return json(409, {
          error: { code: 409, message: "The requested identifier already exists." },
        });
      }
      const stored = {
        ...event,
        status: "confirmed",
        htmlLink: `https://calendar.google.com/event?eid=${event.id}`,
      };
      events.push({ calendar, event: stored });
      return json(200, stored);
    }
    const one = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(path);
    if (one?.[1] && one[2] && req.method === "GET") {
      const hit = events.find(
        (e) => e.calendar === decodeURIComponent(one[1] as string) && e.event.id === one[2],
      );
      return hit ? json(200, hit.event) : json(404, { error: { code: 404, message: "Not Found" } });
    }
    json(404, { error: { code: 404, message: `no ${req.method} ${path}` } });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/calendar/v3`;
  createCalendarConnector({ googleApiUrl: base });
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
beforeEach(() => {
  events = [
    {
      calendar: "ana@gmail.com",
      event: {
        id: "standup20261109",
        summary: "Standup",
        location: "Room 4",
        start: { dateTime: "2026-11-09T09:30:00Z" },
        end: { dateTime: "2026-11-09T09:45:00Z" },
      },
    },
    {
      calendar: "team@group.calendar.google.com",
      event: {
        id: "offsite",
        summary: "Offsite",
        description: "<p>Bring a <b>laptop</b></p>",
        start: { date: "2026-11-09" },
        end: { date: "2026-11-11" },
      },
    },
    {
      calendar: "ana@gmail.com",
      event: {
        id: "gone",
        status: "cancelled",
        summary: "Moved",
        start: { dateTime: "2026-11-09T12:00:00Z" },
        end: { dateTime: "2026-11-09T13:00:00Z" },
      },
    },
  ];
  seen.length = 0;
});

const google = (over: Partial<Installation> = {}): Installation => ({
  id: "ins_g",
  connectorId: "calendar",
  name: "Google Calendar",
  credentials: { clientId: "1.apps.googleusercontent.com", clientSecret: "s", accessToken: TOKEN },
  config: { kind: "google", calendars: [], defaultCalendar: "" },
  ...over,
});

function context(installation: Installation, key = "chat:call_1"): NodeContext {
  return {
    runId: "chat:conv",
    nodeId: "calendar_create_event",
    nodeRunId: "call_1",
    workflowId: "",
    workspaceId: "ws_1",
    ownerId: "usr_1",
    iteration: 0,
    attempt: 1,
    idempotencyKey: key,
    signal: AbortSignal.timeout(5_000),
    log: { info() {}, warn() {}, error() {} },
    installation: async () => installation as never,
    services: { timeZone: async () => ZONE },
  };
}

async function outputs(run: Promise<unknown>) {
  const r = (await run) as { exec: string; outputs: Record<string, unknown> };
  return r.outputs;
}

describe("reading a Google calendar", () => {
  it("lists every calendar's events in the workspace's zone, skipping cancelled ones", async () => {
    const node = createListEvents(new FeedCache());
    const out = await outputs(
      node.run?.(context(google()), {
        inputs: {},
        config: { installationId: "ins_g", from: "2026-11-09", days: 1, calendars: [] },
      }) as Promise<unknown>,
    );
    expect(out.events).toEqual([
      {
        title: "Offsite",
        start: "2026-11-09",
        end: "2026-11-10",
        allDay: true,
        location: "",
        description: "Bring a laptop",
        calendar: "Team",
      },
      {
        title: "Standup",
        start: "2026-11-09T09:30:00+00:00",
        end: "2026-11-09T09:45:00+00:00",
        allDay: false,
        location: "Room 4",
        description: "",
        calendar: "ana@gmail.com",
      },
    ]);
    expect(out.agenda).toContain("- 09:30–09:45: Standup (ana@gmail.com), at Room 4");
    const reads = seen.filter((s) => s.path.endsWith("/events"));
    expect(reads).toHaveLength(3);
    for (const r of reads) {
      expect(r.query.get("singleEvents")).toBe("true");
      expect(r.query.get("timeMin")).toBe("2026-11-09T00:00:00.000Z");
      expect(r.auth).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("reads only the calendars picked, by name", async () => {
    const node = createListEvents(new FeedCache());
    const out = await outputs(
      node.run?.(context(google({ config: { kind: "google", calendars: ["work"] } })), {
        inputs: {},
        config: { installationId: "ins_g", from: "2026-11-09", days: 1, calendars: [] },
      }) as Promise<unknown>,
    );
    expect(out.events).toEqual([]);
    expect(seen.filter((s) => s.path.endsWith("/events")).map((s) => s.path)).toEqual([
      "/calendars/work%40group.calendar.google.com/events",
    ]);
  });

  it("says why when it isn't connected, and when Google refuses the token", async () => {
    const node = createListEvents(new FeedCache());
    const run = (inst: Installation) =>
      node.run?.(context(inst), {
        inputs: {},
        config: { installationId: "ins_g", from: "today", days: 1, calendars: [] },
      });
    await expect(run(google({ credentials: {} }))).rejects.toThrow(
      "Google Calendar isn't connected to Google yet. Connect it on the Connectors page.",
    );
    await expect(
      run(
        google({
          credentials: {
            signIn: {
              redirectUrl: "x",
              problem: "Not connected yet. Connect it on the Connectors page.",
            },
          },
        }),
      ),
    ).rejects.toThrow("Not connected yet.");
    await expect(run(google({ credentials: { accessToken: "stale" } }))).rejects.toThrow(
      /no longer accepts Sling's sign-in/,
    );
  });
});

describe("adding to a Google calendar", () => {
  const add = (config: Record<string, unknown>, key = "chat:call_dentist") =>
    outputs(
      createEvent.run?.(context(google(), key), {
        inputs: {},
        config: createConfigSchema.parse({
          installationId: "ins_g",
          title: "Dentist",
          start: "2026-11-12T15:00",
          ...config,
        }),
      }) as Promise<unknown>,
    );

  it("inserts with an ID from the idempotency key into the account's own calendar, once", async () => {
    const first = await add({ durationMinutes: 30, location: "Rua Augusta" });
    const id = googleEventId("chat:call_dentist");
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(first).toEqual({
      created: true,
      event: {
        title: "Dentist",
        start: "2026-11-12T15:00:00+00:00",
        end: "2026-11-12T15:30:00+00:00",
        allDay: false,
        location: "Rua Augusta",
        description: "",
        calendar: "ana@gmail.com",
        uid: id,
        link: `https://calendar.google.com/event?eid=${id}`,
      },
    });
    const inserted = events.find((e) => e.event.id === id)?.event;
    expect(inserted?.start).toEqual({ dateTime: "2026-11-12T15:00:00.000Z", timeZone: ZONE });
    expect(inserted?.end).toEqual({ dateTime: "2026-11-12T15:30:00.000Z", timeZone: ZONE });

    const again = await add({ durationMinutes: 30, location: "Rua Augusta" });
    expect(again.created).toBe(false);
    expect(events.filter((e) => e.event.id === id)).toHaveLength(1);
  });

  it("adds an all-day event to the calendar named, and refuses a read-only one", async () => {
    const out = await add(
      { calendar: "Work", start: "2026-11-20", end: "2026-11-21", allDay: true },
      "k2",
    );
    expect(out.event).toMatchObject({ start: "2026-11-20", end: "2026-11-21", calendar: "Work" });
    expect(events.at(-1)).toMatchObject({
      calendar: "work@group.calendar.google.com",
      event: { start: { date: "2026-11-20" }, end: { date: "2026-11-22" } },
    });
    await expect(add({ calendar: "Team" }, "k3")).rejects.toThrow(
      "Team is read-only for this account.",
    );
    await expect(add({ calendar: "Gym" }, "k4")).rejects.toThrow(
      "No calendar called Gym in Google Calendar. Calendars: ana@gmail.com, Team, Work.",
    );
  });

  it("reads the event back by its ID and says which calendar it's in", async () => {
    const out = await add({ durationMinutes: 30 });
    const config = createConfigSchema.parse({
      installationId: "ins_g",
      title: "Dentist",
      start: "2026-11-12T15:00",
    });
    expect(
      await createEvent.verify?.(context(google()), { inputs: {}, config, outputs: out }),
    ).toEqual({
      state: "passed",
      message: "In ana@gmail.com, Thu 12 Nov 15:00",
    });
    events = events.filter((e) => e.event.id !== (out.event as { uid: string }).uid);
    expect(
      await createEvent.verify?.(context(google()), { inputs: {}, config, outputs: out }),
    ).toEqual({
      state: "failed",
      message: "It isn't in ana@gmail.com on Google",
    });
  });
});

describe("the connection test and the setup lookup", () => {
  const connector = createCalendarConnector({ googleApiUrl: base });
  const log = { info() {}, warn() {}, error() {} };
  const signal = () => AbortSignal.timeout(5_000);

  it("lists the calendars once connected, and says to connect before", async () => {
    expect(
      await connector.test({
        credentials: { accessToken: TOKEN },
        config: {
          kind: "google",
          calendars: [],
          defaultCalendar: "",
          username: "",
          serverUrl: "",
          feedNames: [],
        },
        log,
        signal: signal(),
      }),
    ).toEqual({ ok: true, detail: "Found 3 calendars: ana@gmail.com, Team, Work." });
    expect(
      await connector.test({
        credentials: {},
        config: {
          kind: "google",
          calendars: [],
          defaultCalendar: "",
          username: "",
          serverUrl: "",
          feedNames: [],
        },
        log,
        signal: signal(),
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/isn't connected to Google yet/) });
  });

  it("shows the redirect URI to add before connecting, and checks the client ID's shape", async () => {
    const redirect = "http://localhost:5195/api/oauth/google/callback";
    const before = await connector.setup?.({
      credentials: { clientId: "123-abc", signIn: { redirectUrl: redirect, problem: null } },
      config: { kind: "google" },
      log,
      signal: signal(),
    });
    expect(before?.notes).toEqual([
      expect.objectContaining({
        field: "clientId",
        tone: "info",
        text: `Make an OAuth client ID for a web application, with ${redirect} as its redirect URI.`,
      }),
      {
        field: "clientId",
        tone: "error",
        text: "A Google client ID ends in .apps.googleusercontent.com.",
      },
      expect.objectContaining({ field: "clientSecret", tone: "info" }),
    ]);
  });

  it("offers the calendars once connected, with only writable ones for new events", async () => {
    const after = await connector.setup?.({
      credentials: { accessToken: TOKEN },
      config: { kind: "google" },
      log,
      signal: signal(),
    });
    expect(after?.options?.calendars?.map((o) => o.label)).toEqual([
      "ana@gmail.com",
      "Team",
      "Work",
    ]);
    expect(after?.options?.defaultCalendar?.map((o) => o.label)).toEqual(["ana@gmail.com", "Work"]);
    expect(after?.config).toEqual({ defaultCalendar: "ana@gmail.com" });
    expect(after?.notes).toEqual([
      { field: "clientId", tone: "ok", text: "Connected as ana@gmail.com" },
    ]);
  });

  it("declares how it signs in, for the server", () => {
    expect(connector.oauth).toEqual({
      provider: "google",
      scopes: [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.readonly",
      ],
      when: { kind: "google" },
    });
    expect(connector.secretFields).toContain("accessToken");
  });
});

describe("occurrences and when they are", () => {
  it("keeps Google's day after for all-day events and reads offsets on timed ones", () => {
    expect(
      occurrenceOf(
        {
          id: "a",
          start: { dateTime: "2026-11-09T10:00:00+01:00" },
          end: { dateTime: "2026-11-09T11:00:00+01:00" },
        },
        "Work",
        ZONE,
      ),
    ).toMatchObject({
      startMs: Date.parse("2026-11-09T09:00:00Z"),
      allDay: false,
      title: "(no title)",
    });
    expect(
      whenText(
        { allDay: false, startDate: "", startMs: Date.parse("2026-11-09T09:00:00Z") },
        "Asia/Tokyo",
      ),
    ).toBe("Mon 9 Nov 18:00");
    expect(whenText({ allDay: true, startDate: "2026-11-09", startMs: 0 }, ZONE)).toBe("Mon 9 Nov");
  });
});
