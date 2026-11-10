import { describe, expect, it } from "vitest";
import { toEvent } from "./format.ts";
import {
  collectOccurrences,
  countEvents,
  type Occurrence,
  parseCalendars,
  sortOccurrences,
  type Window,
} from "./ical.ts";
import { addDays, startOfDate } from "./zone.ts";

const LISBON_TZ = `BEGIN:VTIMEZONE
TZID:Europe/Lisbon
BEGIN:STANDARD
DTSTART:19701025T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T010000
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
END:VTIMEZONE`;

/** Outlook names zones the Windows way and always sends the VTIMEZONE. */
const WINDOWS_TZ = `BEGIN:VTIMEZONE
TZID:GMT Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T010000
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE`;

const cal = (...parts: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sling tests//EN", ...parts, "END:VCALENDAR"].join(
    "\r\n",
  );

function read(ics: string, from: string, days: number, zone = "Europe/Lisbon"): Occurrence[] {
  const win: Window = {
    start: startOfDate(from, zone),
    end: startOfDate(addDays(from, days), zone),
    timeZone: zone,
  };
  const out: Occurrence[] = [];
  for (const c of parseCalendars(ics)) collectOccurrences(c, win, "Work", out);
  return sortOccurrences(out);
}

const utc = (list: Occurrence[]) => list.map((o) => new Date(o.startMs).toISOString());

describe("recurring events", () => {
  const standup = cal(
    LISBON_TZ,
    "BEGIN:VEVENT",
    "UID:standup",
    "DTSTART;TZID=Europe/Lisbon:20260105T093000",
    "DTEND;TZID=Europe/Lisbon:20260105T094500",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    "EXDATE;TZID=Europe/Lisbon:20261023T093000",
    "SUMMARY:Standup",
    "END:VEVENT",
  );

  it("keeps the local time across a daylight saving change", () => {
    // Summer time ends on Sunday 25 October 2026.
    const list = read(standup, "2026-10-22", 6);
    expect(utc(list)).toEqual([
      "2026-10-22T08:30:00.000Z",
      // Friday the 23rd is excluded.
      "2026-10-26T09:30:00.000Z",
      "2026-10-27T09:30:00.000Z",
    ]);
    expect(toEvent(list[0] as Occurrence, "Europe/Lisbon")).toEqual({
      title: "Standup",
      start: "2026-10-22T09:30:00+01:00",
      end: "2026-10-22T09:45:00+01:00",
      allDay: false,
      location: "",
      description: "",
      calendar: "Work",
    });
    expect(toEvent(list[1] as Occurrence, "Europe/Lisbon").start).toBe("2026-10-26T09:30:00+00:00");
  });

  it("shows the same instants in another zone", () => {
    const list = read(standup, "2026-10-26", 1, "America/New_York");
    expect(list.map((o) => toEvent(o, "America/New_York").start)).toEqual([
      "2026-10-26T05:30:00-04:00",
    ]);
  });

  it("applies moved, changed, and cancelled instances", () => {
    const ics = cal(
      LISBON_TZ,
      "BEGIN:VEVENT",
      "UID:review",
      "DTSTART;TZID=Europe/Lisbon:20261102T140000",
      "DTEND;TZID=Europe/Lisbon:20261102T150000",
      "RRULE:FREQ=DAILY;COUNT=10",
      "SUMMARY:Review",
      "LOCATION:Room 1",
      "END:VEVENT",
      // Tuesday's moves to Friday morning.
      "BEGIN:VEVENT",
      "UID:review",
      "RECURRENCE-ID;TZID=Europe/Lisbon:20261103T140000",
      "DTSTART;TZID=Europe/Lisbon:20261106T080000",
      "DTEND;TZID=Europe/Lisbon:20261106T083000",
      "SUMMARY:Review (moved)",
      "END:VEVENT",
      // Friday's own instance is cancelled.
      "BEGIN:VEVENT",
      "UID:review",
      "RECURRENCE-ID:20261106T140000Z",
      "DTSTART;TZID=Europe/Lisbon:20261106T140000",
      "STATUS:CANCELLED",
      "SUMMARY:Review",
      "END:VEVENT",
      // Thursday's changes room but keeps its time and length.
      "BEGIN:VEVENT",
      "UID:review",
      "RECURRENCE-ID;TZID=Europe/Lisbon:20261105T140000",
      "DTSTART;TZID=Europe/Lisbon:20261105T140000",
      "SUMMARY:Review",
      "LOCATION:Room 9",
      "END:VEVENT",
    );
    const tuesday = read(ics, "2026-11-03", 1);
    expect(tuesday).toEqual([]);
    const thursday = read(ics, "2026-11-05", 1);
    expect(thursday.map((o) => [o.location, o.endMs - o.startMs])).toEqual([["Room 9", 3_600_000]]);
    const friday = read(ics, "2026-11-06", 1);
    expect(friday.map((o) => [o.title, toEvent(o, "Europe/Lisbon").start])).toEqual([
      ["Review (moved)", "2026-11-06T08:00:00+00:00"],
    ]);
    // COUNT=10 ends the series on 11 November.
    expect(read(ics, "2026-11-11", 3).map((o) => o.title)).toEqual(["Review"]);
  });

  it("drops a series that was cancelled", () => {
    const ics = cal(
      "BEGIN:VEVENT",
      "UID:gone",
      "DTSTART:20261101T100000Z",
      "RRULE:FREQ=DAILY",
      "STATUS:CANCELLED",
      "SUMMARY:Gone",
      "END:VEVENT",
    );
    expect(read(ics, "2026-11-06", 1)).toEqual([]);
  });

  it("matches stepping from the start, when it skips years of a daily or weekly series", () => {
    const old = cal(
      "BEGIN:VEVENT",
      "UID:gym",
      "DTSTART;TZID=Europe/Lisbon:20110103T070000",
      "DTEND;TZID=Europe/Lisbon:20110103T080000",
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH",
      "SUMMARY:Gym",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:pills",
      "DTSTART:20120101T200000Z",
      "RRULE:FREQ=DAILY;INTERVAL=3",
      "SUMMARY:Pills",
      "END:VEVENT",
    );
    // Same rules but with COUNT large enough not to end, which can't skip ahead.
    const counted = old
      .replace(";BYDAY=MO,TH", ";BYDAY=MO,TH;COUNT=100000")
      .replace("INTERVAL=3", "INTERVAL=3;COUNT=100000");
    const fast = read(old, "2026-10-19", 21);
    const slow = read(counted, "2026-10-19", 21);
    expect(utc(fast)).toEqual(utc(slow));
    // Every other week on Monday and Thursday: two of the three weeks.
    expect(fast.filter((o) => o.title === "Gym")).toHaveLength(4);
    expect(fast.filter((o) => o.title === "Pills")).toHaveLength(7);
  });
});

describe("one-off events and time zones", () => {
  it("reads a TZID with no VTIMEZONE as that zone, and a floating time as the workspace's", () => {
    const ics = cal(
      "BEGIN:VEVENT",
      "UID:ny",
      "DTSTART;TZID=America/New_York:20261106T090000",
      "DTEND;TZID=America/New_York:20261106T100000",
      "SUMMARY:New York call",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:float",
      "DTSTART:20261106T120000",
      "DTEND:20261106T130000",
      "SUMMARY:Lunch",
      "END:VEVENT",
    );
    const list = read(ics, "2026-11-06", 1);
    expect(list.map((o) => [o.title, new Date(o.startMs).toISOString()])).toEqual([
      ["Lunch", "2026-11-06T12:00:00.000Z"],
      ["New York call", "2026-11-06T14:00:00.000Z"],
    ]);
    // In Tokyo the floating lunch moves, and the New York call is late that evening.
    const tokyo = read(ics, "2026-11-06", 1, "Asia/Tokyo");
    expect(tokyo.map((o) => [o.title, toEvent(o, "Asia/Tokyo").start])).toEqual([
      ["Lunch", "2026-11-06T12:00:00+09:00"],
      ["New York call", "2026-11-06T23:00:00+09:00"],
    ]);
  });

  it("reads a recurring event's TZID with no VTIMEZONE as that zone", () => {
    const ics = cal(
      "BEGIN:VEVENT",
      "UID:ny-weekly",
      "DTSTART;TZID=America/New_York:20261023T090000",
      "DTEND;TZID=America/New_York:20261023T100000",
      "RRULE:FREQ=WEEKLY",
      "EXDATE;TZID=America/New_York:20261030T090000",
      "SUMMARY:New York sync",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ny-weekly",
      "RECURRENCE-ID;TZID=America/New_York:20261113T090000",
      "DTSTART;TZID=America/New_York:20261113T110000",
      "DTEND;TZID=America/New_York:20261113T120000",
      "SUMMARY:New York sync, moved",
      "END:VEVENT",
    );
    // New York leaves daylight saving on November 1st.
    expect(utc(read(ics, "2026-10-23", 28))).toEqual([
      "2026-10-23T13:00:00.000Z",
      "2026-11-06T14:00:00.000Z",
      "2026-11-13T16:00:00.000Z",
    ]);
  });

  it("uses an Outlook VTIMEZONE's rules", () => {
    const ics = cal(
      WINDOWS_TZ,
      "BEGIN:VEVENT",
      "UID:outlook",
      "DTSTART;TZID=GMT Standard Time:20260715T100000",
      "DTEND;TZID=GMT Standard Time:20260715T110000",
      "SUMMARY:Summer meeting",
      "END:VEVENT",
    );
    expect(utc(read(ics, "2026-07-15", 1, "Europe/London"))).toEqual(["2026-07-15T09:00:00.000Z"]);
  });

  it("covers all-day events across the days they span, and cuts long descriptions", () => {
    const ics = cal(
      "BEGIN:VEVENT",
      "UID:trip",
      "DTSTART;VALUE=DATE:20261105",
      "DTEND;VALUE=DATE:20261108",
      "SUMMARY:Porto trip",
      `DESCRIPTION:${"x".repeat(700)}`,
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:holiday",
      "DTSTART;VALUE=DATE:20261108",
      "SUMMARY:Holiday",
      "END:VEVENT",
    );
    const friday = read(ics, "2026-11-06", 1);
    expect(friday.map((o) => o.title)).toEqual(["Porto trip"]);
    const trip = toEvent(friday[0] as Occurrence, "Europe/Lisbon");
    expect(trip).toMatchObject({ start: "2026-11-05", end: "2026-11-07", allDay: true });
    expect(trip.description).toHaveLength(500);
    expect(read(ics, "2026-11-08", 1).map((o) => toEvent(o, "UTC"))).toMatchObject([
      { title: "Holiday", start: "2026-11-08", end: "2026-11-08" },
    ]);
  });

  it("counts series once, and reads several calendars back to back", () => {
    const one = cal("BEGIN:VEVENT", "UID:a", "DTSTART:20261106T100000Z", "SUMMARY:A", "END:VEVENT");
    const two = cal("BEGIN:VEVENT", "UID:b", "DTSTART:20261106T110000Z", "SUMMARY:B", "END:VEVENT");
    const both = parseCalendars(`${one}\r\n${two}`);
    expect(both).toHaveLength(2);
    expect(countEvents(both)).toBe(2);
    expect(() => parseCalendars("not a calendar")).toThrow(/iCalendar/);
  });
});
