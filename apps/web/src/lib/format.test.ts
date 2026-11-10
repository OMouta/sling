import { describe, expect, it } from "vitest";
import { duration, elapsed, expiresIn, readableLocalDate, withoutLocalLinks } from "./format.ts";

describe("withoutLocalLinks", () => {
  it("turns links to paths on the agent's machine into code, and keeps web links", () => {
    expect(
      withoutLocalLinks(
        "Changed the year in [index.html](/tmp/worktrees/tsk_1/index.html:6), see [PR](https://github.com/a/b/pull/1).",
      ),
    ).toBe("Changed the year in `index.html`, see [PR](https://github.com/a/b/pull/1).");
    expect(withoutLocalLinks("[`a.ts`](file:///x/a.ts) and [b](~/b.md)")).toBe("`a.ts` and `b`");
  });
});

describe("readableLocalDate", () => {
  it("writes local dates as people do, and leaves anything else alone", () => {
    expect(readableLocalDate("2026-11-07T10:00")).toBe("Sat 7 Nov, 10:00");
    expect(readableLocalDate("2026-11-07")).toBe("Sat 7 Nov");
    expect(readableLocalDate("2026-11-07T10:00:00Z")).toBe("2026-11-07T10:00:00Z");
    expect(readableLocalDate("Call mum")).toBe("Call mum");
  });
});

describe("duration and elapsed", () => {
  it("write every length of time one way", () => {
    expect(duration(850)).toBe("850 ms");
    expect(duration(3_240)).toBe("3.2 s");
    expect(duration(45_900)).toBe("45 s");
    expect(duration(245_000)).toBe("4m 05s");
    expect(duration(3_720_000)).toBe("1h 02m");
  });

  it("counts a running timer in whole seconds, in the same style", () => {
    expect(elapsed(400)).toBe("0 s");
    expect(elapsed(3_900)).toBe("3 s");
    expect(elapsed(245_400)).toBe("4m 05s");
    expect(elapsed(-50)).toBe("0 s");
  });
});

describe("expiresIn", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  it("says how long is left, and never that something expires in the past", () => {
    expect(expiresIn("2026-11-10T12:05:00Z", now)).toBe("expires in 5 minutes");
    expect(expiresIn("2026-11-10T12:00:30Z", now)).toBe("expires in under a minute");
    expect(expiresIn("2026-11-10T11:58:00Z", now)).toBe("expired");
  });
});
