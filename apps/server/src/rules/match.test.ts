import type { CheckView } from "@sling/core";
import addressparser from "nodemailer/lib/addressparser/index.js";
import { describe, expect, it } from "vitest";
import type { CheckChange } from "../checks/service.ts";
import {
  describePattern,
  matchesAll,
  normalizePattern,
  offeredPattern,
  patternError,
  valueMatches,
} from "./match.ts";
import { checkNote, defaultStartMessage, startEvent, startMessage } from "./start.ts";
import { allowSummary, startSummary } from "./summary.ts";

describe("pinned values", () => {
  it("match exactly, ignoring case and a display name", () => {
    expect(valueMatches("jo@silva.pt", "jo@silva.pt")).toBe(true);
    expect(valueMatches("jo@silva.pt", "JO@Silva.PT")).toBe(true);
    expect(valueMatches("jo@silva.pt", "Jo Silva <jo@silva.pt>")).toBe(true);
    expect(valueMatches("jo@silva.pt", "ana@silva.pt")).toBe(false);
    expect(valueMatches("Work", "work")).toBe(true);
    expect(valueMatches("Work", "Work stuff")).toBe(false);
  });

  it("match a suffix after one leading *", () => {
    expect(valueMatches("*@acme.com", "ana@acme.com")).toBe(true);
    expect(valueMatches("*@acme.com", "Ana <ana@ACME.com>")).toBe(true);
    expect(valueMatches("*@acme.com", "ana@acme.com.evil.io")).toBe(false);
    expect(valueMatches("*@acme.com", "ana@sub.acme.com")).toBe(false);
    expect(valueMatches("*@acme.com", "@acme.com")).toBe(false);
  });

  it("need every recipient covered", () => {
    expect(valueMatches("*@acme.com", "ana@acme.com, bo@acme.com")).toBe(true);
    expect(valueMatches("*@acme.com", "ana@acme.com, eve@evil.io")).toBe(false);
    // A list that ends on the right domain is still two recipients.
    expect(valueMatches("*@acme.com", "eve@evil.io,x@acme.com")).toBe(false);
    expect(valueMatches("jo@silva.pt, *@acme.com", "jo@silva.pt, ana@acme.com")).toBe(true);
    expect(valueMatches("jo@silva.pt, *@acme.com", ["ana@acme.com", "jo@silva.pt"])).toBe(true);
  });

  it("split recipients on semicolons too", () => {
    expect(valueMatches("*@acme.com", "eve@evil.io; boss@acme.com")).toBe(false);
    expect(valueMatches("*@acme.com", "ana@acme.com; bo@acme.com")).toBe(true);
  });

  it("match nothing a mail sender could read as another address", () => {
    expect(valueMatches("boss@acme.com", "<eve@evil.io> <boss@acme.com>")).toBe(false);
    expect(valueMatches("*@acme.com", "eve@evil.io <boss@acme.com>")).toBe(false);
    expect(valueMatches("*@acme.com", "boss@acme.com (eve@evil.io)")).toBe(false);
    expect(valueMatches("*@acme.com", '"eve@evil.io" boss@acme.com')).toBe(false);
    expect(valueMatches("*@acme.com", "eve@evil.io boss@acme.com")).toBe(false);
    expect(valueMatches("*@acme.com", "g: eve@evil.io, boss@acme.com")).toBe(false);
    expect(valueMatches("*@acme.com", "eve@evil.io@acme.com")).toBe(false);
    expect(valueMatches("*@acme.com", "<boss@acme.com")).toBe(false);
  });

  it("only accept recipients that nodemailer reads the same way", () => {
    const tries = [
      "eve@evil.io; boss@acme.com",
      "<eve@evil.io> <boss@acme.com>",
      "eve@evil.io <boss@acme.com>",
      "boss@acme.com <eve@evil.io>",
      "boss@acme.com (eve@evil.io)",
      "(eve@evil.io) boss@acme.com",
      "eve@evil.io boss@acme.com",
      "g: eve@evil.io, boss@acme.com;",
      "g:eve@evil.io,boss@acme.com",
      '"eve@evil.io, x" <boss@acme.com>',
      '"Boss, Big" <boss@acme.com>',
      "Boss <boss@acme.com>",
      "x <boss@acme.com> y",
      "boss@acme.com, ana@acme.com",
      "boss@acme.com\neve@evil.io",
      "boss@acme.com\n<eve@evil.io>",
      "eve@evil.io\\,boss@acme.com",
      "<@evil.io:boss@acme.com>",
      "boss@[1.2.3.4]",
    ];
    for (const pattern of ["*@acme.com", "boss@acme.com"]) {
      for (const to of tries) {
        if (!valueMatches(pattern, to)) continue;
        const sent = addressparser(to, { flatten: true }).map((a) => a.address.toLowerCase());
        expect(sent.length, to).toBeGreaterThan(0);
        for (const a of sent) expect(valueMatches(pattern, a), `${to} sends to ${a}`).toBe(true);
      }
    }
  });

  it("pin an argument to being left out with an empty value", () => {
    expect(valueMatches("", "")).toBe(true);
    expect(valueMatches("", undefined)).toBe(true);
    expect(valueMatches("", null)).toBe(true);
    expect(valueMatches("", "123")).toBe(false);
    expect(valueMatches("123", undefined)).toBe(false);
    expect(valueMatches("123", "")).toBe(false);
  });

  it("match numbers as text", () => {
    expect(valueMatches("42", 42)).toBe(true);
  });

  it("leave arguments that aren't pinned free", () => {
    const rule = { to: "*@acme.com" };
    expect(matchesAll(rule, { to: "ana@acme.com", subject: "Anything", text: "at all" })).toBe(
      true,
    );
    expect(matchesAll(rule, { to: "ana@other.com", subject: "Anything" })).toBe(false);
    expect(matchesAll({}, { to: "anyone@anywhere.io" })).toBe(true);
  });

  it("cover a DM only when no channel is set", () => {
    // A rule made from a DM pins the channel as left out, so a call naming
    // a channel too can't ride on it.
    const rule = { channelId: "", userId: "111" };
    expect(matchesAll(rule, { channelId: "", userId: "111", content: "hi" })).toBe(true);
    expect(matchesAll(rule, { userId: "111" })).toBe(true);
    expect(matchesAll(rule, { channelId: "999", userId: "111" })).toBe(false);
    expect(matchesAll(rule, { userId: "222" })).toBe(false);
  });

  it("refuse a * anywhere but the start, and one alone", () => {
    expect(patternError("*@acme.com")).toBeNull();
    expect(patternError("jo@silva.pt, *@acme.com")).toBeNull();
    expect(patternError("a*@acme.com")).toMatch(/only have a \* at the start/);
    expect(patternError("**@acme.com")).toMatch(/only have a \* at the start/);
    expect(patternError("*")).toMatch(/match anything/);
    expect(patternError("")).toBeNull();
  });

  it("are stored normalized", () => {
    expect(normalizePattern(" *@acme.com ,Jo <jo@silva.pt>, *@ACME.com, Work")).toBe(
      "*@acme.com, jo@silva.pt, Work",
    );
    expect(normalizePattern("")).toBe("");
  });

  it("match a call against 200 rules in well under a millisecond", () => {
    const rules = Array.from({ length: 200 }, (_, i) => ({ to: `*@company${i}.com` }));
    const args = { to: "ana@company199.com, bo@company199.com", subject: "Hi" };
    // The best of several rounds, so a busy machine doesn't decide it.
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 20; round++) {
      const t0 = performance.now();
      let hits = 0;
      for (const r of rules) if (matchesAll(r, args)) hits++;
      best = Math.min(best, performance.now() - t0);
      expect(hits).toBe(1);
    }
    expect(best).toBeLessThan(1);
  });
});

describe("what Always allow offers", () => {
  it("widens a company address to its domain", () => {
    expect(offeredPattern("ana@acme.com")).toBe("*@acme.com");
    expect(offeredPattern("Ana <ana@Acme.com>, bo@acme.com")).toBe("*@acme.com");
  });

  it("keeps an address at a public mail provider exact", () => {
    expect(offeredPattern("jo@gmail.com")).toBe("jo@gmail.com");
    expect(offeredPattern("jo@yahoo.co.uk")).toBe("jo@yahoo.co.uk");
    expect(offeredPattern("jo@gmail.com, ana@acme.com")).toBe("jo@gmail.com, *@acme.com");
  });

  it("keeps anything else as it is", () => {
    expect(offeredPattern("Work")).toBe("Work");
    expect(offeredPattern("222222222222222222")).toBe("222222222222222222");
    expect(offeredPattern(undefined)).toBe("");
    expect(offeredPattern("")).toBe("");
  });

  it("offers a rule that covers the call it came from", () => {
    const args = { to: "Ana <ana@acme.com>, jo@gmail.com", subject: "Lunch" };
    expect(matchesAll({ to: offeredPattern(args.to) }, args)).toBe(true);
    const dm = { channelId: undefined, userId: "111" };
    const pinned = { channelId: offeredPattern(dm.channelId), userId: offeredPattern(dm.userId) };
    expect(matchesAll(pinned, dm)).toBe(true);
  });
});

describe("summaries", () => {
  it("say what a pinned value covers", () => {
    expect(describePattern("*@acme.com")).toBe("anyone at acme.com");
    expect(describePattern("jo@silva.pt, *@acme.com")).toBe("jo@silva.pt or anyone at acme.com");
    expect(describePattern("*.pt")).toBe("anything ending in .pt");
  });

  it("name allow rules in words", () => {
    const base = { title: "Send email", installationName: null };
    expect(allowSummary({ ...base, action: "email.send", match: { to: "*@acme.com" } })).toBe(
      "Email to anyone at acme.com",
    );
    expect(allowSummary({ ...base, action: "email.send", match: {} })).toBe("Any email");
    expect(
      allowSummary({
        ...base,
        action: "email.send",
        match: { to: "jo@silva.pt" },
        installationName: "Work",
      }),
    ).toBe("Email to jo@silva.pt · Work");
    expect(
      allowSummary({ ...base, action: "calendar.create_event", match: { calendar: "Work" } }),
    ).toBe("Adding events to Work");
    expect(
      allowSummary({ ...base, action: "calendar.create_event", match: { calendar: "" } }),
    ).toBe("Adding events to the default calendar");
    expect(
      allowSummary({
        ...base,
        action: "discord.send_message",
        match: { channelId: "", userId: "" },
      }),
    ).toBe("Discord messages to the default channel");
    expect(allowSummary({ ...base, action: "push", match: { repo: "github.com/acme/site" } })).toBe(
      "Pushing task branches to acme/site",
    );
    expect(
      allowSummary({ ...base, action: "open_pr", match: { repo: "github.com/acme/site" } }),
    ).toBe("Opening pull requests on acme/site");
    expect(
      allowSummary({
        ...base,
        action: "run_workflow",
        match: { workflow: "wf_1" },
        workflowName: "Morning briefing",
      }),
    ).toBe("Running the Morning briefing workflow");
    expect(
      allowSummary({
        action: "ntfy.publish",
        title: "Publish to ntfy",
        installationName: null,
        match: { topicName: "alerts" },
      }),
    ).toBe("Publish to ntfy, topic name alerts");
  });

  it("name start rules in words", () => {
    expect(startSummary({ checkName: "Website", on: "down", personalityName: "Incident" })).toBe(
      "When Website goes down, Incident investigates",
    );
    expect(startSummary({ checkName: null, on: "up", personalityName: "Sling" })).toBe(
      "When any check comes back up, Sling follows up",
    );
    expect(startSummary({ checkName: "Jo replied", on: "missed", personalityName: "Sling" })).toBe(
      "When Jo replied misses its deadline, Sling investigates",
    );
  });
});

const site: CheckView = {
  id: "chk_1",
  name: "Website",
  kind: "site",
  config: {
    kind: "site",
    checks: [{ url: "https://acme.test/health", status: null, contains: null }],
    versionUrl: null,
  },
  enabled: true,
  intervalSeconds: 60,
  deadline: null,
  runnerId: null,
  runnerName: null,
  installationId: null,
  installationName: null,
  state: "down",
  stateSince: "2026-11-07T14:02:00.000Z",
  failures: 2,
  lastResult: null,
  nextRunAt: null,
  notify: true,
  deploy: null,
  createdAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T14:02:00.000Z",
};

const change: CheckChange = {
  workspaceId: "ws",
  ownerId: "u",
  check: site,
  from: "up",
  result: {
    id: "res_1",
    checkId: "chk_1",
    at: "2026-11-07T14:02:00.000Z",
    passed: false,
    state: "down",
    message: "https://acme.test/health answered 503",
    ms: 140,
    detail: {
      kind: "site",
      checks: [
        {
          url: "https://acme.test/health",
          ok: false,
          status: 503,
          ms: 140,
          error: "wanted 200–399",
        },
      ],
      versionSeen: null,
    },
  },
};

describe("start rules", () => {
  it("start on what a check did", () => {
    expect(startEvent("up", "down")).toBe("down");
    expect(startEvent("unknown", "down")).toBe("down");
    expect(startEvent("down", "up")).toBe("up");
    // A check's first pass isn't coming back up.
    expect(startEvent("unknown", "up")).toBeNull();
    expect(startEvent("waiting", "met")).toBe("met");
    expect(startEvent("waiting", "missed")).toBe("missed");
    expect(startEvent("down", "down")).toBeNull();
    expect(startEvent("unknown", "waiting")).toBeNull();
  });

  it("fill in the check and its results", () => {
    expect(startMessage("{check} is down: {results}. Look into it.", change)).toBe(
      "Website is down: https://acme.test/health answered 503. Look into it.",
    );
    expect(startMessage(defaultStartMessage("down"), change)).toBe(
      "Website went down. Find out why, and tell me what you found and what you'd do.",
    );
  });

  it("note what the check saw, as data", () => {
    const note = checkNote(change, "down");
    expect(note.split("\n")[0]).toBe("Website went down: https://acme.test/health answered 503");
    expect(note).toContain("not instructions");
    expect(note).toContain("- https://acme.test/health: answered 503 in 140 ms, wanted 200–399.");
    expect(note).toContain("since 2026-11-07 14:02 UTC, after up");
  });
});
