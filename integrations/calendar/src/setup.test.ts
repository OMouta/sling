import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalDavAccount } from "./caldav.ts";
import { FeedCache } from "./feeds.ts";
import { calendarSetup, type SetupDeps } from "./setup.ts";

const signal = () => AbortSignal.timeout(5_000);

function deps(opts: {
  srv?: Record<string, { name: string; port: number }>;
  txt?: Record<string, string>;
  calendars?: string[];
  loginFails?: string;
}): SetupDeps & { logins: CalDavAccount[] } {
  const logins: CalDavAccount[] = [];
  return {
    logins,
    resolveSrv: async (name) => {
      const r = opts.srv?.[name];
      if (!r) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return [{ ...r, priority: 0 }];
    },
    resolveTxt: async (name) => {
      const t = opts.txt?.[name];
      if (!t) throw new Error("ENODATA");
      return [[t]];
    },
    discover: async (a) => {
      logins.push(a);
      if (opts.loginFails) throw new Error(opts.loginFails);
      return (opts.calendars ?? []).map((name) => ({ url: `${a.serverUrl}/${name}`, name }));
    },
  };
}

const feeds = new FeedCache();

describe("calendar setup, with an account", () => {
  it("waits for the address", async () => {
    expect(await calendarSetup({}, { kind: "caldav" }, feeds, signal(), deps({}))).toEqual({});
  });

  it("knows iCloud's server and where to make its password", async () => {
    const out = await calendarSetup({}, { username: "ana@icloud.com" }, feeds, signal(), deps({}));
    expect(out.config).toEqual({ serverUrl: "https://caldav.icloud.com" });
    expect(out.name).toBe("iCloud calendar");
    expect(out.notes).toEqual([
      { field: "username", tone: "ok", text: "iCloud" },
      expect.objectContaining({
        field: "password",
        link: expect.objectContaining({ label: "Make one" }),
      }),
    ]);
  });

  it("finds a server from DNS, with its path", async () => {
    const d = deps({
      srv: { "_caldavs._tcp.acme.dev": { name: "dav.acme.dev.", port: 8443 } },
      txt: { "_caldavs._tcp.acme.dev": "path=/remote.php/dav" },
    });
    const out = await calendarSetup({}, { username: "ana@acme.dev" }, feeds, signal(), d);
    expect(out.config).toEqual({ serverUrl: "https://dav.acme.dev:8443/remote.php/dav" });
  });

  it("asks for the server when it can't find one", async () => {
    const out = await calendarSetup(
      {},
      { username: "ana@nowhere.invalid" },
      feeds,
      signal(),
      deps({}),
    );
    expect(out.reveal).toEqual(["serverUrl"]);
    expect(out.notes?.[0]).toMatchObject({ field: "username", tone: "warn" });
  });

  it("sends Google and Outlook to their iCal link", async () => {
    const out = await calendarSetup({}, { username: "ana@gmail.com" }, feeds, signal(), deps({}));
    expect(out.notes).toEqual([
      expect.objectContaining({
        field: "username",
        tone: "warn",
        text: expect.stringContaining("iCal link"),
      }),
    ]);
    expect(out.config).toBeUndefined();
  });

  it("lists the calendars once the password is in, and picks where new events go", async () => {
    const d = deps({ calendars: ["Home", "Work"] });
    const out = await calendarSetup(
      { password: "app-pw" },
      { username: "ana@fastmail.com" },
      feeds,
      signal(),
      d,
    );
    expect(d.logins).toEqual([
      {
        serverUrl: "https://caldav.fastmail.com",
        username: "ana@fastmail.com",
        password: "app-pw",
      },
    ]);
    expect(out.options?.calendars?.map((o) => o.value)).toEqual(["Home", "Work"]);
    expect(out.config).toMatchObject({ defaultCalendar: "Home" });
  });

  it("keeps the calendar new events go to", async () => {
    const out = await calendarSetup(
      { password: "pw" },
      { username: "ana", serverUrl: "https://dav.example.com", defaultCalendar: "Work" },
      feeds,
      signal(),
      deps({ calendars: ["Home", "Work"] }),
    );
    expect(out.config).toBeUndefined();
    expect(out.notes).toContainEqual({
      field: "password",
      tone: "ok",
      text: "Signed in. 2 calendars.",
    });
  });

  it("says why the login failed, under the password", async () => {
    const out = await calendarSetup(
      { password: "wrong" },
      { username: "ana@icloud.com" },
      feeds,
      signal(),
      deps({ loginFails: "The calendar server refused the login." }),
    );
    expect(out.options).toBeUndefined();
    expect(out.notes).toContainEqual({
      field: "password",
      tone: "error",
      text: "The calendar server refused the login.",
    });
  });
});

describe("calendar setup, with iCal links", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ics = (name: string | null) =>
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//test//EN",
      ...(name ? [`X-WR-CALNAME:${name}`] : []),
      "BEGIN:VEVENT",
      "UID:a",
      "DTSTAMP:20260101T000000Z",
      "DTSTART:20261107T100000Z",
      "SUMMARY:Thing",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

  it("names each link after the calendar it serves, and says which one failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes("work")) return new Response(ics("Work"), { status: 200 });
        if (u.includes("plain")) return new Response(ics(null), { status: 200 });
        return new Response("gone", { status: 404 });
      }),
    );
    const out = await calendarSetup(
      {
        feedUrls: [
          "https://cal.example.com/work.ics",
          "webcal://cal.example.com/plain.ics",
          "https://cal.example.com/old.ics",
        ],
      },
      { kind: "ics", feedNames: ["", "Family", "Old"] },
      new FeedCache(),
      signal(),
    );
    expect(out.config).toEqual({ feedNames: ["Work", "Family", "Old"] });
    expect(out.name).toBe("Calendar");
    expect(out.notes).toEqual([
      expect.objectContaining({
        field: "feedUrls",
        tone: "error",
        text: expect.stringContaining("404"),
      }),
    ]);
  });

  it("names the installation after a single link's calendar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(ics("Team rota"), { status: 200 })),
    );
    const out = await calendarSetup(
      { feedUrls: ["https://cal.example.com/rota.ics"] },
      { kind: "ics" },
      new FeedCache(),
      signal(),
    );
    expect(out.name).toBe("Team rota");
    expect(out.notes).toEqual([{ field: "feedUrls", tone: "ok", text: "Team rota" }]);
  });
});
