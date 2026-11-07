import { WORKFLOW_SCHEMA, type WorkflowDefinition } from "@sling/workflow";
import { describe, expect, it } from "vitest";
import { scheduleTrigger } from "./nodes/triggers.ts";
import { instantOf, localTimeText, oneTimeAt, parseLocal, passedSchedules } from "./one-time.ts";

describe("a local time", () => {
  it("reads a date and time to the minute or the second, and nothing else", () => {
    expect(parseLocal("2026-11-09T17:00")).toEqual({
      year: 2026,
      month: 11,
      day: 9,
      hour: 17,
      minute: 0,
      second: 0,
    });
    expect(parseLocal("2026-11-09T17:00:30")?.second).toBe(30);
    for (const bad of ["2026-02-30T10:00", "2026-11-09T24:00", "2026-11-09 17:00", "17:00", ""]) {
      expect(parseLocal(bad)).toBeNull();
    }
  });

  it("names an instant in its zone, across a change of the clocks", () => {
    expect(instantOf("2026-11-09T17:00", "UTC")?.toISOString()).toBe("2026-11-09T17:00:00.000Z");
    expect(instantOf("2026-07-01T09:00", "Europe/Lisbon")?.toISOString()).toBe(
      "2026-07-01T08:00:00.000Z",
    );
    expect(instantOf("2026-11-09T09:00", "America/New_York")?.toISOString()).toBe(
      "2026-11-09T14:00:00.000Z",
    );
    expect(instantOf("2026-11-09T09:00", "Asia/Kolkata")?.toISOString()).toBe(
      "2026-11-09T03:30:00.000Z",
    );
    // Lisbon skips 01:00 to 02:00 on 29 March 2026: a time in the gap lands after it.
    expect(instantOf("2026-03-29T01:30", "Europe/Lisbon")?.toISOString()).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    // And 01:30 happens twice on 25 October.
    expect(instantOf("2026-10-25T01:30", "Europe/Lisbon")?.toISOString()).toBe(
      "2026-10-25T01:30:00.000Z",
    );
    expect(instantOf("nope", "UTC")).toBeNull();
    expect(() => instantOf("2026-11-09T17:00", "Mars/Olympus")).toThrow();
  });

  it("reads as words, with the year only when it isn't this one", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    expect(localTimeText("2026-11-07T17:00", now)).toBe("Saturday 7 November at 17:00");
    expect(localTimeText("2027-01-04T08:05", now)).toBe("Monday 4 January 2027 at 08:05");
    expect(localTimeText("2026-11-07T17:00:30", now)).toBe("Saturday 7 November at 17:00:30");
  });
});

describe("a one-time schedule", () => {
  const check = (config: Record<string, unknown>) =>
    scheduleTrigger.checkConfig?.({ cron: "", at: "", timezone: "", ...config }) ?? [];

  it("takes a cron expression or a time, not both, and a real time zone", () => {
    expect(check({ cron: "0 9 * * 1" })).toEqual([]);
    expect(check({ at: "2026-11-09T17:00" })).toEqual([]);
    expect(check({ at: "2026-11-09T17:00", timezone: "Europe/Lisbon" })).toEqual([]);
    expect(check({})).toEqual([
      { field: "cron", message: "Use five cron fields, for example */5 * * * *" },
    ]);
    expect(check({ cron: "0 9 * * 1", at: "2026-11-09T17:00" })).toEqual([
      { field: "at", message: "Set a cron expression or a time, not both" },
    ]);
    expect(check({ at: "tomorrow at five" })).toEqual([
      { field: "at", message: "Use a local date and time, for example 2026-11-09T17:00" },
    ]);
    expect(check({ cron: "0 9 * * 1", timezone: "Lisbon" })).toEqual([
      { field: "timezone", message: "Lisbon isn't a time zone, such as Europe/Lisbon" },
    ]);
    expect(oneTimeAt({ at: " 2026-11-09T17:00 " })).toBe("2026-11-09T17:00");
    expect(oneTimeAt({ cron: "* * * * *", at: "" })).toBeNull();
  });

  it("is refused once its time has passed, in the node's zone or the workspace's", () => {
    const def = (config: Record<string, unknown>): WorkflowDefinition => ({
      schema: WORKFLOW_SCHEMA,
      name: "Reminder",
      description: "",
      nodes: [
        { id: "at", type: "core.schedule", version: 1, position: { x: 0, y: 0 }, config },
        { id: "push", type: "app.notify", version: 1, position: { x: 300, y: 0 }, config: {} },
      ],
      edges: [],
    });
    const now = new Date("2026-11-07T16:30:00Z");
    // 17:00 in Lisbon is 17:00 UTC in November: still to come.
    expect(passedSchedules(def({ at: "2026-11-07T17:00" }), "Europe/Lisbon", now)).toEqual([]);
    // 17:00 in Madrid was 16:00 UTC.
    expect(passedSchedules(def({ at: "2026-11-07T17:00" }), "Europe/Madrid", now)).toEqual([
      {
        code: "time_passed",
        message: "at: Saturday 7 November at 17:00 in Europe/Madrid has already passed",
        nodeId: "at",
        port: "at",
        when: "Saturday 7 November at 17:00 in Europe/Madrid",
      },
    ]);
    expect(
      passedSchedules(
        def({ at: "2026-11-07T17:00", timezone: "Europe/Madrid" }),
        "Europe/Lisbon",
        now,
      ),
    ).toHaveLength(1);
    expect(passedSchedules(def({ cron: "0 9 * * *" }), "UTC", now)).toEqual([]);
  });
});
