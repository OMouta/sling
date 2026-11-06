import { describe, expect, it } from "vitest";
import { addDays, dateIn, isoIn, isZone, longDate, startOfDate, wallToInstant } from "./zone.ts";

const wall = (y: number, mo: number, d: number, h = 0, mi = 0) => ({
  year: y,
  month: mo,
  day: d,
  hour: h,
  minute: mi,
  second: 0,
});

describe("wall clock times in a zone", () => {
  it("knows each side of a daylight saving change", () => {
    // Lisbon leaves summer time at 02:00 on 25 October 2026.
    expect(new Date(wallToInstant(wall(2026, 10, 24, 9), "Europe/Lisbon")).toISOString()).toBe(
      "2026-10-24T08:00:00.000Z",
    );
    expect(new Date(wallToInstant(wall(2026, 10, 26, 9), "Europe/Lisbon")).toISOString()).toBe(
      "2026-10-26T09:00:00.000Z",
    );
  });

  it("takes the first of a repeated hour, and moves a skipped one past the gap", () => {
    // 01:30 happens twice on 25 October in Lisbon: at +01:00, then at +00:00.
    expect(new Date(wallToInstant(wall(2026, 10, 25, 1, 30), "Europe/Lisbon")).toISOString()).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    // 01:30 doesn't exist on 29 March 2026 in Lisbon.
    expect(new Date(wallToInstant(wall(2026, 3, 29, 1, 30), "Europe/Lisbon")).toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });

  it("finds midnight, dates, and offsets", () => {
    expect(new Date(startOfDate("2026-11-06", "America/New_York")).toISOString()).toBe(
      "2026-11-06T05:00:00.000Z",
    );
    expect(dateIn(Date.parse("2026-11-06T23:30:00Z"), "Asia/Tokyo")).toBe("2026-11-07");
    expect(isoIn(Date.parse("2026-07-01T08:00:00Z"), "Europe/Lisbon")).toBe(
      "2026-07-01T09:00:00+01:00",
    );
    expect(isoIn(Date.parse("2026-07-01T08:00:00Z"), "Asia/Kolkata")).toBe(
      "2026-07-01T13:30:00+05:30",
    );
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(longDate("2026-11-06")).toBe("Friday, 6 November 2026");
    expect(isZone("Europe/Lisbon")).toBe(true);
    expect(isZone("Mars/Olympus")).toBe(false);
  });
});
