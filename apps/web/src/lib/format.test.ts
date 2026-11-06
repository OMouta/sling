import { describe, expect, it } from "vitest";
import { readableLocalDate, withoutLocalLinks } from "./format.ts";

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
