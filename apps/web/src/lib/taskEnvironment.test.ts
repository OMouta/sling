import { describe, expect, it } from "vitest";
import { machineTask, sandboxTask, waitingTask } from "../test/fixtures.ts";
import { environmentSummary, sortConsidered } from "./taskEnvironment.ts";

describe("environmentSummary", () => {
  it("names the machine", () => {
    expect(environmentSummary(machineTask)).toEqual({ kind: "machine", text: "on devbox" });
  });

  it("names the sandbox's provider and state", () => {
    expect(environmentSummary(sandboxTask)).toEqual({
      kind: "sandbox",
      text: "in a sandbox on Docker host",
      state: "busy",
      sandboxId: "sbx_1",
    });
  });

  it("says what an unbound task waits for", () => {
    expect(environmentSummary(waitingTask).text).toBe("waiting for a sandbox");
    const machine = {
      ...waitingTask,
      environment: { ...waitingTask.environment, kind: "machine" as const },
    };
    expect(environmentSummary(machine).text).toBe("waiting for a machine");
  });

  it("doesn't say waiting once an unbound task has settled", () => {
    expect(environmentSummary({ ...waitingTask, state: "cancelled" })).toEqual({
      kind: "none",
      text: "no sandbox started",
    });
  });
});

describe("sortConsidered", () => {
  it("puts eligible machines first and keeps the router's order otherwise", () => {
    const sorted = sortConsidered([
      { runnerId: "a", runnerName: "a", eligible: false, reason: "" },
      { runnerId: "b", runnerName: "b", eligible: true, reason: "" },
      { runnerId: "c", runnerName: "c", eligible: false, reason: "" },
      { runnerId: "d", runnerName: "d", eligible: true, reason: "" },
    ]);
    expect(sorted.map((c) => c.runnerId)).toEqual(["b", "d", "a", "c"]);
  });
});
