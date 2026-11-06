import type { DeployLastCheck } from "@sling/db";
import { describe, expect, it } from "vitest";
import type { CheckOutcome } from "../../deploys/service.ts";
import { changesOf, isDown } from "./deploys.ts";

const ok = { url: "https://site/health", ok: true, status: 200, ms: 3, error: null };
const bad = {
  url: "https://site/health",
  ok: false,
  status: 502,
  ms: 3,
  error: "Expected 200 to 399, got 502",
};

function check(up: boolean, failures: number, since = "2026-11-06T14:02:00.000Z"): DeployLastCheck {
  return { at: "2026-11-06T14:03:00.000Z", up, failures, results: [up ? ok : bad], since };
}

function outcome(before: DeployLastCheck | null, after: DeployLastCheck): CheckOutcome {
  return {
    target: { name: "Website" } as CheckOutcome["target"],
    before,
    after,
  };
}

describe("deploys.check changes", () => {
  it("goes down after two failures in a row, not one", () => {
    expect(changesOf([outcome(null, check(false, 1))], "UTC")).toEqual([]);
    expect(changesOf([outcome(check(false, 1), check(false, 2))], "UTC")).toEqual([
      {
        target: "Website",
        up: false,
        wasUp: true,
        results: [bad],
        since: "2026-11-06T14:02:00.000Z",
        reason: "502",
        sinceTime: "14:02",
      },
    ]);
    // Still down: no change to report.
    expect(changesOf([outcome(check(false, 2), check(false, 3))], "UTC")).toEqual([]);
  });

  it("comes back up after one pass", () => {
    const [change] = changesOf(
      [outcome(check(false, 4), check(true, 0, "2026-11-06T14:09:00.000Z"))],
      "Europe/Lisbon",
    );
    expect(change).toMatchObject({ target: "Website", up: true, wasUp: false, reason: "" });
    // A single failure that clears never counted as down.
    expect(changesOf([outcome(check(false, 1), check(true, 0))], "UTC")).toEqual([]);
  });

  it("shows the time in the workspace's time zone", () => {
    const [change] = changesOf([outcome(check(false, 1), check(false, 2))], "Asia/Tokyo");
    expect(change?.sinceTime).toBe("23:02");
    expect(isDown(null)).toBe(false);
  });
});
