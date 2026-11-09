import { describe, expect, it } from "vitest";
import { settleReasonOf } from "./deliveries.ts";

describe("where a finished task settles", () => {
  it("settles a task that didn't succeed as finished, whatever its steps", () => {
    expect(settleReasonOf("failed", [{ kind: "push", state: "queued" }])).toBe("finished");
    expect(settleReasonOf("cancelled", [])).toBe("finished");
  });

  it("settles a succeeded task with no steps as finished", () => {
    expect(settleReasonOf("succeeded", [])).toBe("finished");
  });

  it("settles when a step waits for approval, and when every step has ended", () => {
    const pr = { kind: "open_pr", state: "awaiting_approval" as const };
    expect(settleReasonOf("succeeded", [{ kind: "push", state: "succeeded" }, pr])).toBe(
      "approval_needed",
    );
    expect(
      settleReasonOf("succeeded", [
        { kind: "push", state: "succeeded" },
        { kind: "open_pr", state: "succeeded" },
      ]),
    ).toBe("delivered");
    expect(
      settleReasonOf("succeeded", [
        { kind: "push", state: "failed" },
        { kind: "open_pr", state: "queued" },
      ]),
    ).toBe("delivered");
  });

  it("doesn't settle while a step is on its way, and reads a retried step's latest try", () => {
    expect(settleReasonOf("succeeded", [{ kind: "push", state: "sent" }])).toBeNull();
    expect(
      settleReasonOf("succeeded", [
        { kind: "push", state: "failed" },
        { kind: "push", state: "awaiting_approval" },
      ]),
    ).toBe("approval_needed");
  });
});
