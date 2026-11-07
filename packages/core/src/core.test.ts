import { describe, expect, it } from "vitest";
import {
  ACTION_CHECK_STATES,
  CHECK_INTERVAL_SECONDS,
  CHECK_KINDS,
  canTransitionTask,
  cloneUrlFor,
  isTerminalTask,
  MODE_POLICY,
  modeWithinCap,
  needsApproval,
  newId,
  PERSONALITY_TOOL_INFO,
  PERSONALITY_TOOLS,
  RULE_TASK_STEPS,
  remoteKey,
  START_RULE_MODES,
  TASK_STATES,
  taskBranch,
} from "./index.ts";

describe("permission modes", () => {
  it("gates the right actions in each mode", () => {
    expect(needsApproval("supervised", "push")).toBe(true);
    expect(needsApproval("supervised", "open_pr")).toBe(true);
    expect(needsApproval("auto", "push")).toBe(false);
    expect(needsApproval("auto", "open_pr")).toBe(false);
    expect(needsApproval("auto", "merge")).toBe(true);
    expect(needsApproval("full-access", "deploy")).toBe(false);
    expect(MODE_POLICY["read-only"].writes).toBe(false);
    expect(MODE_POLICY["full-access"].sandbox).toBe("danger-full-access");
  });

  it("compares modes against a Runner cap", () => {
    expect(modeWithinCap("auto", "auto")).toBe(true);
    expect(modeWithinCap("full-access", "auto")).toBe(false);
    expect(modeWithinCap("read-only", "supervised")).toBe(true);
  });
});

describe("task states", () => {
  it("allows the normal path", () => {
    expect(canTransitionTask("queued", "dispatched")).toBe(true);
    expect(canTransitionTask("dispatched", "running")).toBe(true);
    expect(canTransitionTask("running", "succeeded")).toBe(true);
  });

  it("never leaves a terminal state", () => {
    for (const from of TASK_STATES.filter(isTerminalTask)) {
      for (const to of TASK_STATES) {
        expect(canTransitionTask(from, to)).toBe(false);
      }
    }
  });

  it("refuses skipping straight to success", () => {
    expect(canTransitionTask("queued", "succeeded")).toBe(false);
    expect(canTransitionTask("dispatched", "succeeded")).toBe(false);
  });
});

describe("ids and branches", () => {
  it("makes sortable prefixed ids", () => {
    const a = newId("tsk", 1000);
    const b = newId("tsk", 2000);
    expect(a).toMatch(/^tsk_[0-9a-z]{26}$/);
    expect(a < b).toBe(true);
  });

  it("builds safe branch names", () => {
    expect(taskBranch("tsk_01jcabcdefk3v9qa", "Fix the footer year!")).toBe(
      "sling/k3v9qa-fix-the-footer-year",
    );
    expect(taskBranch("tsk_01jcabcdefk3v9qa", "???")).toBe("sling/k3v9qa");
  });
});

describe("remote keys", () => {
  it("normalizes the common remote forms to one key", () => {
    const want = "github.com/acme/site";
    expect(remoteKey("git@github.com:Acme/site.git")).toBe(want);
    expect(remoteKey("https://github.com/acme/site")).toBe(want);
    expect(remoteKey("https://user:tok@github.com/acme/site.git/")).toBe(want);
    expect(remoteKey("ssh://git@github.com/acme/site.git")).toBe(want);
    expect(cloneUrlFor(want)).toBe("https://github.com/acme/site.git");
  });

  it("returns null for remotes it can't read", () => {
    expect(remoteKey("")).toBeNull();
    expect(remoteKey("/srv/git/site.git")).toBeNull();
    expect(remoteKey("file:///srv/git/site.git")).toBeNull();
    expect(remoteKey("https://github.com/")).toBeNull();
  });
});

describe("rules and checks", () => {
  it("never starts a chat in Full access, and never lets a merge or deploy through", () => {
    expect(START_RULE_MODES).not.toContain("full-access");
    expect(RULE_TASK_STEPS).not.toContain("merge");
    expect(RULE_TASK_STEPS).not.toContain("deploy");
  });

  it("gives every check kind a schedule, and every tool group a label", () => {
    for (const kind of CHECK_KINDS) expect(CHECK_INTERVAL_SECONDS[kind]).toBeGreaterThan(0);
    for (const tool of PERSONALITY_TOOLS) expect(PERSONALITY_TOOL_INFO[tool].label).toBeTruthy();
    expect(ACTION_CHECK_STATES).toEqual(["passed", "failed", "waiting", "unchecked"]);
  });
});
