import { describe, expect, it } from "vitest";
import { deliveryPlan, reachedState } from "./plan.ts";

const shape = (steps: ReturnType<typeof deliveryPlan>) =>
  steps.map((s) => `${s.kind}:${s.state}${s.requiresApproval ? ":asks" : ""}`);

describe("delivery steps", () => {
  it("runs push, PR, merge, deploy, and verify for a deploy, in that order", () => {
    expect(shape(deliveryPlan("deploy", "auto", "command"))).toEqual([
      "push:ready",
      "open_pr:ready",
      "merge:queued:asks",
      "deploy:queued:asks",
      "verify:queued",
    ]);
    expect(shape(deliveryPlan("deploy", "auto", "hook")).map((s) => s.split(":")[0])).toEqual([
      "push",
      "open_pr",
      "merge",
      "deploy",
      "verify",
    ]);
  });

  it("has no deploy step when the host deploys on merge", () => {
    expect(shape(deliveryPlan("deploy", "full-access", "merge"))).toEqual([
      "push:ready",
      "open_pr:ready",
      "merge:queued",
      "verify:queued",
    ]);
  });

  it("asks before push and PR in Supervised, and before merge and deploy once reached", () => {
    expect(shape(deliveryPlan("deploy", "supervised", "hook"))).toEqual([
      "push:awaiting_approval:asks",
      "open_pr:awaiting_approval:asks",
      "merge:queued:asks",
      "deploy:queued:asks",
      "verify:queued",
    ]);
    expect(reachedState("supervised", "merge")).toBe("awaiting_approval");
    expect(reachedState("supervised", "deploy")).toBe("awaiting_approval");
  });

  it("asks only before merge and deploy in Auto, and never in Full access", () => {
    expect(reachedState("auto", "merge")).toBe("awaiting_approval");
    expect(reachedState("auto", "deploy")).toBe("awaiting_approval");
    expect(reachedState("full-access", "merge")).toBe("ready");
    expect(reachedState("full-access", "deploy")).toBe("ready");
    expect(shape(deliveryPlan("deploy", "full-access", "command"))).not.toContainEqual(
      expect.stringContaining("asks"),
    );
  });

  it("gives Read-only and local deliveries no steps, and keeps push and PR as they were", () => {
    expect(deliveryPlan("deploy", "read-only", "hook")).toEqual([]);
    expect(deliveryPlan("local", "auto", null)).toEqual([]);
    expect(shape(deliveryPlan("push", "auto", null))).toEqual(["push:ready"]);
    expect(shape(deliveryPlan("pr", "auto", null))).toEqual(["push:ready", "open_pr:ready"]);
  });
});
