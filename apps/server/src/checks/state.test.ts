import type { CheckResultView } from "@sling/core";
import { describe, expect, it } from "vitest";
import { alertFor } from "./alerts.ts";
import { bucketOf, summarizeCi } from "./ci.ts";
import { answers } from "./kinds.ts";
import {
  isNotable,
  nextRunAt,
  nextState,
  type Prior,
  REPLY_GRACE_MS,
  siteMessage,
} from "./state.ts";

const now = new Date("2026-11-07T15:00:00Z");
const fresh: Prior = { state: "unknown", failures: 0, stateSince: null };
const pass = { passed: true, counted: true };
const fail = { passed: false, counted: true };
const skipped = { passed: false, counted: false };

describe("a site or command check's state", () => {
  it("is up after one pass, and down after two failures in a row", () => {
    const up = nextState("site", fresh, pass, now, null);
    expect(up).toEqual({ state: "up", failures: 0, stateSince: now, done: false });
    const once = nextState("site", up, fail, new Date(now.getTime() + 60_000), null);
    expect(once).toMatchObject({ state: "up", failures: 1, stateSince: now });
    const later = new Date(now.getTime() + 120_000);
    expect(nextState("command", once, fail, later, null)).toEqual({
      state: "down",
      failures: 2,
      stateSince: later,
      done: false,
    });
  });

  it("stays unknown on a first failure, then goes down", () => {
    const once = nextState("site", fresh, fail, now, null);
    expect(once).toMatchObject({ state: "unknown", failures: 1 });
    expect(nextState("site", once, fail, now, null).state).toBe("down");
  });

  it("doesn't count a run that couldn't happen, such as an offline machine", () => {
    const down: Prior = { state: "down", failures: 4, stateSince: now };
    expect(nextState("command", down, skipped, now, null)).toMatchObject({
      state: "down",
      failures: 4,
    });
  });

  it("comes back up from down after one pass", () => {
    const down: Prior = { state: "down", failures: 3, stateSince: now };
    expect(nextState("site", down, pass, now, null)).toMatchObject({ state: "up", failures: 0 });
  });
});

describe("a reply check's state", () => {
  const deadline = new Date(now.getTime() + 3600_000);

  it("waits until a reply comes, then is met and stops", () => {
    const waiting = nextState("reply", fresh, fail, now, deadline);
    expect(waiting).toMatchObject({ state: "waiting", done: false });
    expect(nextState("reply", waiting, pass, now, deadline)).toMatchObject({
      state: "met",
      done: true,
    });
  });

  it("is missed once the deadline passes without one", () => {
    expect(nextState("reply", fresh, fail, deadline, deadline)).toMatchObject({
      state: "missed",
      done: true,
    });
  });

  it("keeps trying for a while when the mailbox couldn't be searched at the deadline", () => {
    const waiting: Prior = { state: "waiting", failures: 0, stateSince: now };
    const retry = nextState("reply", waiting, skipped, deadline, deadline);
    expect(retry).toEqual({ state: "waiting", failures: 0, stateSince: now, done: false });
    expect(nextRunAt("reply", retry, deadline, 300, deadline)).toEqual(
      new Date(deadline.getTime() + 60_000),
    );
    const late = new Date(deadline.getTime() + 5 * 60_000);
    expect(nextState("reply", waiting, pass, late, deadline)).toMatchObject({ state: "met" });
    expect(nextState("reply", waiting, fail, late, deadline)).toMatchObject({ state: "missed" });
    const end = new Date(deadline.getTime() + REPLY_GRACE_MS);
    expect(nextState("reply", waiting, skipped, end, deadline)).toMatchObject({
      state: "missed",
      done: true,
    });
    const nearEnd = new Date(end.getTime() - 10_000);
    expect(nextRunAt("reply", retry, nearEnd, 300, deadline)).toEqual(end);
  });

  it("stays met or missed once it is", () => {
    const met: Prior = { state: "met", failures: 0, stateSince: now };
    expect(nextState("reply", met, fail, deadline, deadline)).toMatchObject({ state: "met" });
  });

  it("runs next at the deadline at the latest, and never once it stopped", () => {
    const next = nextState("reply", fresh, fail, now, deadline);
    expect(nextRunAt("reply", next, now, 7200, deadline)).toEqual(deadline);
    expect(nextRunAt("reply", { ...next, done: true }, now, 300, deadline)).toBeNull();
    expect(nextRunAt("site", next, now, 60, null)).toEqual(new Date(now.getTime() + 60_000));
  });

  it("matches a reply's thread when it names one", () => {
    const config = { kind: "reply" as const, from: null, subject: null, folder: null };
    const mail = { id: "1", from: "jo@x", subject: "Re: invoice", date: "" };
    expect(answers(mail, { ...config, inReplyTo: null })).toBe(true);
    expect(
      answers({ ...mail, inReplyTo: "<abc@sling>" }, { ...config, inReplyTo: "abc@sling" }),
    ).toBe(true);
    expect(
      answers(
        { ...mail, references: "<x@y> <abc@sling>" },
        { ...config, inReplyTo: "<abc@sling>" },
      ),
    ).toBe(true);
    expect(answers(mail, { ...config, inReplyTo: "abc@sling" })).toBe(false);
  });
});

describe("which changes are worth telling", () => {
  it("going down, coming back from down, and replies met or missed", () => {
    expect(isNotable("up", "down")).toBe(true);
    expect(isNotable("unknown", "down")).toBe(true);
    expect(isNotable("down", "up")).toBe(true);
    expect(isNotable("waiting", "met")).toBe(true);
    expect(isNotable("waiting", "missed")).toBe(true);
    expect(isNotable("unknown", "up")).toBe(false);
    expect(isNotable("unknown", "waiting")).toBe(false);
    expect(isNotable("down", "down")).toBe(false);
  });
});

describe("what a change says", () => {
  const result = (detail: CheckResultView["detail"], message = ""): CheckResultView => ({
    id: "ckr_1",
    checkId: "chk_1",
    at: now.toISOString(),
    passed: false,
    state: "down",
    message,
    ms: 10,
    detail,
  });
  const site = {
    id: "chk_1",
    name: "Website",
    kind: "site" as const,
    state: "down" as const,
    stateSince: "2026-11-07T14:58:00Z",
    deadline: null,
  };
  const down = result({
    kind: "site",
    checks: [
      {
        url: "https://x/health",
        ok: false,
        status: 503,
        ms: 9,
        error: "Expected 200 to 399, got 503",
      },
    ],
    versionSeen: null,
  });

  it("opens an Incident chat with a draft when a site goes down", () => {
    const a = alertFor(site, "up", down, { timeZone: "Europe/Lisbon", openChat: null });
    expect(a).toMatchObject({
      title: "Website is down: 503",
      body: "Failing since 14:58. Tap to start a chat about it.",
      urgency: "high",
      reason: "503",
      sinceTime: "14:58",
    });
    const url = new URL(a.url, "http://x");
    expect(url.searchParams.get("personality")).toBe("incident");
    expect(url.searchParams.get("draft")).toBe(
      "Website is down (503 since 14:58). Find out why and fix it.",
    );
  });

  it("opens the chat a start rule opened instead", () => {
    const a = alertFor(site, "up", down, { timeZone: "UTC", openChat: "cnv_1" });
    expect(a.url).toBe("/c/cnv_1");
  });

  it("says a site is back up, a command fails or passes again, and a reply came", () => {
    const up = alertFor({ ...site, state: "up" }, "down", down, {
      timeZone: "UTC",
      openChat: null,
    });
    expect(up).toMatchObject({ title: "Website is back up", url: "/checks", urgency: "normal" });
    const cmd = result(
      { kind: "command", exitCode: 1, output: "", timedOut: false, error: null },
      "Exited 1",
    );
    expect(
      alertFor({ ...site, name: "Backup", kind: "command" }, "up", cmd, {
        timeZone: "UTC",
        openChat: null,
      }).title,
    ).toBe("Backup is failing: Exited 1");
    const met = result({
      kind: "reply",
      match: { id: "1", from: "jo@silva.pt", subject: "Re: invoice", date: "" },
      error: null,
    });
    expect(
      alertFor({ ...site, name: "Jo replied", kind: "reply", state: "met" }, "waiting", met, {
        timeZone: "UTC",
        openChat: null,
      }),
    ).toMatchObject({ title: "Jo replied", body: "jo@silva.pt replied: Re: invoice" });
    const missed = alertFor(
      {
        ...site,
        name: "Jo replied",
        kind: "reply",
        state: "missed",
        deadline: "2026-11-13T17:00:00Z",
      },
      "waiting",
      result({ kind: "reply", match: null, error: null }),
      { timeZone: "UTC", openChat: null },
    );
    expect(missed.title).toBe("Jo replied: no reply by Fri 13 Nov, 17:00");
  });

  it("names the slowest answer, or the first failure, in a site's line", () => {
    expect(
      siteMessage([{ url: "https://x/", ok: true, status: 200, ms: 140, error: null }], null),
    ).toBe("Answered 200 in 140 ms");
    expect(siteMessage(down.detail.kind === "site" ? down.detail.checks : [], null)).toBe(
      "https://x/health: 503 (Expected 200 to 399, got 503)",
    );
  });
});

describe("a PR's CI", () => {
  it("fails on any failure, waits while any runs, and passes when all did", () => {
    expect(
      summarizeCi(
        [
          { name: "lint", bucket: "fail" },
          { name: "test", bucket: "pass" },
          { name: "build", bucket: "pending" },
        ],
        0,
      ),
    ).toEqual({ state: "failed", message: "CI failed: lint (1 of 3)" });
    expect(
      summarizeCi(
        [
          { name: "test", bucket: "pass" },
          { name: "build", bucket: "pending" },
        ],
        0,
      ),
    ).toMatchObject({ state: "waiting", message: "CI running: 1 of 2 checks done" });
    expect(
      summarizeCi(
        [
          { name: "test", bucket: "pass" },
          { name: "docs", bucket: "skipping" },
        ],
        0,
      ),
    ).toEqual({ state: "passed", message: "CI passed: 1 check" });
  });

  it("waits a few minutes for CI to start, then says there's none", () => {
    expect(summarizeCi([], 10_000).state).toBe("waiting");
    expect(summarizeCi([], 10 * 60_000)).toEqual({
      state: "unchecked",
      message: "No CI ran on this PR",
    });
  });

  it("reads GitHub's check runs as gh does", () => {
    expect(bucketOf("in_progress", null)).toBe("pending");
    expect(bucketOf("completed", "success")).toBe("pass");
    expect(bucketOf("completed", "skipped")).toBe("skipping");
    expect(bucketOf("completed", "timed_out")).toBe("fail");
  });
});
