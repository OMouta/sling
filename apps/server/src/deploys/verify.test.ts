import { describe, expect, it } from "vitest";
import {
  afterRound,
  deadlineOf,
  type Next,
  roundPassed,
  type VerifyTiming,
  verifyMessage,
} from "./verify.ts";

/**
 * Plays the verify loop on a fake clock: a round at the end of the settle
 * time, then one every interval, until the site passes or the deadline.
 */
function simulate(timing: VerifyTiming, upAt: number, roundMs = 30) {
  const startedAt = 1_000_000;
  let now = startedAt + timing.settleMs;
  const rounds: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const roundStartedAt = now;
    rounds.push(roundStartedAt - startedAt);
    now += roundMs;
    const passed = roundStartedAt >= startedAt + upAt;
    const next: Next = afterRound({ passed, roundStartedAt, now, startedAt, timing });
    if (next.kind !== "again") return { outcome: next.kind, rounds, endedAt: now - startedAt };
    now = next.at;
  }
  throw new Error("never ended");
}

describe("the verify loop", () => {
  const timing: VerifyTiming = { settleMs: 60_000, timeoutMs: 600_000, intervalMs: 10_000 };

  it("waits out the settle time, then checks every ten seconds", () => {
    const r = simulate(timing, 95_000);
    expect(r.outcome).toBe("passed");
    expect(r.rounds).toEqual([60_000, 70_000, 80_000, 90_000, 100_000]);
  });

  it("notices a site that comes back within one interval of it answering", () => {
    for (const upAt of [60_001, 64_000, 69_999, 123_456]) {
      const r = simulate(timing, upAt);
      expect(r.outcome).toBe("passed");
      expect(r.endedAt - upAt).toBeLessThanOrEqual(timing.intervalMs + 30);
    }
  });

  it("fails at the deadline, after a last round at the deadline itself", () => {
    const short: VerifyTiming = { settleMs: 0, timeoutMs: 25_000, intervalMs: 10_000 };
    const r = simulate(short, Number.POSITIVE_INFINITY);
    expect(r.outcome).toBe("failed");
    expect(r.rounds).toEqual([0, 10_000, 20_000, 25_000]);
    expect(deadlineOf(0, short)).toBe(25_000);
  });

  it("starts the next round right away when a round ran past the interval", () => {
    const next = afterRound({
      passed: false,
      roundStartedAt: 0,
      now: 12_000,
      startedAt: 0,
      timing: { settleMs: 0, timeoutMs: 60_000, intervalMs: 10_000 },
    });
    expect(next).toEqual({ kind: "again", at: 12_000 });
  });

  it("passes only when every check passes and the version URL shows the commit", () => {
    const ok = { url: "u", ok: true, status: 200, ms: 1, error: null };
    const bad = { url: "u", ok: false, status: 500, ms: 1, error: "Expected 200 to 399, got 500" };
    expect(roundPassed({ checks: [ok, ok], versionSeen: true })).toBe(true);
    expect(roundPassed({ checks: [ok], versionSeen: null })).toBe(true);
    expect(roundPassed({ checks: [ok], versionSeen: false })).toBe(false);
    expect(roundPassed({ checks: [ok, bad], versionSeen: true })).toBe(false);
  });
});

describe("what verify says", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const base = { startedAt: "2026-11-06T14:00:00.000Z", finishedAt: "2026-11-06T14:00:42.000Z" };

  it("says the version answered when the version URL shows the commit", () => {
    expect(
      verifyMessage(
        {
          ...base,
          attempts: 3,
          checks: [{ url: "https://x/health", ok: true, status: 200, ms: 5, error: null }],
          versionSeen: true,
        },
        true,
        sha,
      ),
    ).toBe(
      "The site passed every check after 3 attempts (42 s), and the version URL shows 0123456.",
    );
  });

  it("says plainly when it can't tell which version answered", () => {
    expect(verifyMessage({ ...base, attempts: 1, checks: [], versionSeen: null }, true, sha)).toBe(
      "The site passed every check after 1 attempt (42 s). There's no version URL, so Sling can't tell which version answered.",
    );
  });

  it("names each failing check and the version URL when it fails", () => {
    expect(
      verifyMessage(
        {
          ...base,
          attempts: 5,
          checks: [
            { url: "https://x/", ok: true, status: 200, ms: 5, error: null },
            {
              url: "https://x/health",
              ok: false,
              status: 500,
              ms: 5,
              error: "Expected 200 to 399, got 500",
            },
          ],
          versionSeen: false,
        },
        false,
        sha,
      ),
    ).toBe(
      "Verification failed after 5 attempts over 42 s: https://x/health: 500 (Expected 200 to 399, got 500); the version URL didn't show 0123456.",
    );
  });
});
