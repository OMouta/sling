/**
 * CalDAV XML as real servers send it: iCloud's default namespace and absolute
 * home on another host, Fastmail's D: and C: prefixes with a task list mixed
 * in, and calendar data with escaped carriage returns.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Installation, NodeContext } from "@sling/connector-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  discover,
  eventData,
  holdsEvents,
  hrefIn,
  isCalendar,
  parseMultistatus,
  putEvent,
  utcStamp,
} from "./caldav.ts";
import { createEvent } from "./nodes.ts";
import { verifyEvent, whenText } from "./verify.ts";

const ICLOUD_ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/</href>
    <propstat>
      <prop>
        <current-user-principal><href>/1234567/principal/</href></current-user-principal>
        <resourcetype><collection/></resourcetype>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
    <propstat>
      <prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"/><displayname/></prop>
      <status>HTTP/1.1 404 Not Found</status>
    </propstat>
  </response>
</multistatus>`;

const icloudPrincipal = (home: string) => `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/1234567/principal/</href>
    <propstat>
      <prop>
        <calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">${home}</href></calendar-home-set>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;

const FASTMAIL_HOME = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/1234567/calendars/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/1234567/calendars/home/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Home</D:displayname>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/1234567/calendars/work%20stuff/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat><D:prop><D:displayname/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/1234567/calendars/tasks/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Reminders</D:displayname>
        <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/1234567/calendars/inbox/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/><C:schedule-inbox/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`;

const REPORT = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/1234567/calendars/home/a.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"1"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR&#13;
VERSION:2.0&#13;
BEGIN:VEVENT&#13;
UID:a&#13;
DTSTART:20261106T100000Z&#13;
SUMMARY:Dentist &amp; errands&#13;
END:VEVENT&#13;
END:VCALENDAR&#13;
</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/1234567/calendars/home/b.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"2"</d:getetag><cal:calendar-data><![CDATA[BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:b
DTSTART:20261106T110000Z
SUMMARY:<Lunch>
END:VEVENT
END:VCALENDAR
]]></cal:calendar-data></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

interface Seen {
  method: string;
  path: string;
  depth: string | undefined;
  auth: string | undefined;
  body: string;
  ifNoneMatch: string | undefined;
}

let server: Server;
let base = "";
const seen: Seen[] = [];
const stored = new Map<string, string>();

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await bodyOf(req);
    const path = req.url ?? "/";
    seen.push({
      method: req.method ?? "",
      path,
      depth: req.headers.depth as string | undefined,
      auth: req.headers.authorization,
      body,
      ifNoneMatch: req.headers["if-none-match"] as string | undefined,
    });
    if (req.headers.authorization !== `Basic ${Buffer.from("ana:app-pass").toString("base64")}`) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="test"' }).end();
      return;
    }
    const xml = (s: string) => res.writeHead(207, { "content-type": "application/xml" }).end(s);
    if (req.method === "PROPFIND" && path === "/") return xml(ICLOUD_ROOT);
    if (req.method === "PROPFIND" && path === "/1234567/principal/") {
      // iCloud gives an absolute home, on another host in real life.
      return xml(icloudPrincipal(`${base}/1234567/calendars/`));
    }
    if (req.method === "PROPFIND" && path === "/1234567/calendars/") return xml(FASTMAIL_HOME);
    if (req.method === "REPORT" && path === "/1234567/calendars/home/") return xml(REPORT);
    if (req.method === "GET" && stored.has(path)) {
      res.writeHead(200, { "content-type": "text/calendar" }).end(stored.get(path));
      return;
    }
    if (req.method === "PUT") {
      if (stored.has(path) && req.headers["if-none-match"] === "*") {
        res.writeHead(412).end();
        return;
      }
      stored.set(path, body);
      res.writeHead(201).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const account = () => ({ serverUrl: `${base}/`, username: "ana", password: "app-pass" });
const signal = () => AbortSignal.timeout(5_000);

describe("CalDAV XML", () => {
  it("merges the propstats that succeeded and skips the rest", () => {
    const [root] = parseMultistatus(ICLOUD_ROOT);
    expect(root?.href).toBe("/");
    expect(hrefIn(root?.props["current-user-principal"])).toBe("/1234567/principal/");
    expect(root?.props["calendar-home-set"]).toBeUndefined();
    expect(isCalendar(root?.props.resourcetype)).toBe(false);
  });

  it("tells calendars for events from task lists and other collections", () => {
    const list = parseMultistatus(FASTMAIL_HOME);
    const kinds = list.map((r) => [
      r.href,
      isCalendar(r.props.resourcetype) && holdsEvents(r.props["supported-calendar-component-set"]),
    ]);
    expect(kinds).toEqual([
      ["/1234567/calendars/", false],
      ["/1234567/calendars/home/", true],
      ["/1234567/calendars/work%20stuff/", true],
      ["/1234567/calendars/tasks/", false],
      ["/1234567/calendars/inbox/", false],
    ]);
  });

  it("writes UTC stamps the way time-range wants them", () => {
    expect(utcStamp(Date.parse("2026-11-06T00:00:00Z"))).toBe("20261106T000000Z");
  });
});

describe("talking to a CalDAV server", () => {
  it("finds the principal, its home, and the calendars that hold events", async () => {
    seen.length = 0;
    const calendars = await discover(account(), signal());
    expect(calendars).toEqual([
      { url: `${base}/1234567/calendars/home/`, name: "Home" },
      // No display name: the folder's name, decoded.
      { url: `${base}/1234567/calendars/work%20stuff/`, name: "work stuff" },
    ]);
    expect(seen.map((s) => [s.method, s.path, s.depth])).toEqual([
      ["PROPFIND", "/", "0"],
      ["PROPFIND", "/1234567/principal/", "0"],
      ["PROPFIND", "/1234567/calendars/", "1"],
    ]);
    expect(seen[0]?.body).toContain("<d:current-user-principal/>");
  });

  it("says when the login is wrong", async () => {
    await expect(discover({ ...account(), password: "wrong" }, signal())).rejects.toThrow(
      /CalDAV login failed/,
    );
  });

  it("reads events in a time range, with escaped and CDATA calendar data", async () => {
    seen.length = 0;
    const data = await eventData(
      account(),
      { url: `${base}/1234567/calendars/home/`, name: "Home" },
      { start: Date.parse("2026-11-06T00:00:00Z"), end: Date.parse("2026-11-07T00:00:00Z") },
      signal(),
    );
    expect(data).toHaveLength(2);
    expect(data[0]).toContain("SUMMARY:Dentist & errands");
    expect(data[1]).toContain("SUMMARY:<Lunch>");
    expect(seen[0]?.body).toContain(
      '<c:time-range start="20261106T000000Z" end="20261107T000000Z"/>',
    );
    expect(seen[0]?.depth).toBe("1");
  });

  it("adds an event once: a repeat finds it there and changes nothing", async () => {
    const home = { url: `${base}/1234567/calendars/home/`, name: "Home" };
    const ics = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
    expect(await putEvent(account(), home, "sling-abc.ics", ics, signal())).toBe("created");
    expect(await putEvent(account(), home, "sling-abc.ics", `${ics}x`, signal())).toBe("exists");
    expect(stored.get("/1234567/calendars/home/sling-abc.ics")).toBe(ics);
    expect(seen.filter((s) => s.method === "PUT").every((s) => s.ifNoneMatch === "*")).toBe(true);
  });
});

describe("reading an added event back", () => {
  const installation = (): Installation => ({
    id: "ins_cal",
    connectorId: "calendar",
    name: "iCloud",
    credentials: { password: "app-pass" },
    config: { kind: "caldav", serverUrl: `${base}/`, username: "ana", defaultCalendar: "" },
  });
  const ctx = (key: string): NodeContext => ({
    runId: "chat:c1",
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
    installation: async () => installation() as never,
    services: { timeZone: async () => "Europe/Lisbon" },
  });

  it("finds the event by its UID, and says which calendar it's in and when", async () => {
    const config = {
      installationId: "ins_cal",
      calendar: "Home",
      title: "Dentist",
      start: "2026-11-09T10:00",
      end: "",
      durationMinutes: 30,
      allDay: false,
      location: "",
      description: "",
    };
    const run = await createEvent.run?.(ctx("chat:call_verify"), { config, inputs: {} });
    if (!run || !("exec" in run)) throw new Error("no run");
    const outputs = run.outputs ?? {};
    expect(
      await verifyEvent(ctx("chat:call_verify"), { config, inputs: {}, outputs }, "UTC"),
    ).toEqual({
      state: "passed",
      message: "In Home, Mon 9 Nov 10:00",
    });
    // An event that isn't there, such as one a server dropped, fails the check.
    const gone = { event: { ...(outputs.event as object), uid: "sling-not-there" } };
    expect(await verifyEvent(ctx("chat:x"), { config, inputs: {}, outputs: gone }, "UTC")).toEqual({
      state: "failed",
      message: "The event isn't in Home",
    });
    // Nothing to look for claims nothing.
    expect(
      await verifyEvent(ctx("chat:x"), { config, inputs: {}, outputs: {} }, "UTC"),
    ).toMatchObject({
      state: "unchecked",
    });
  });

  it("writes the day the way a card shows it", () => {
    expect(whenText("2026-11-09T10:00:00+00:00", false)).toBe("Mon 9 Nov 10:00");
    expect(whenText("2026-11-13", true)).toBe("Fri 13 Nov");
    expect(whenText("", false)).toBe("");
  });
});
