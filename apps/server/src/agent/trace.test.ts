import type { ServerEvent } from "@sling/core";
import { describe, expect, it } from "vitest";
import { TraceRecorder } from "./trace.ts";

function recorder() {
  const events: ServerEvent[] = [];
  return { trace: new TraceRecorder("cnv_1", (ev) => events.push(ev)), events };
}

describe("reply traces", () => {
  it("keeps text written before more work as a step, and the rest as the answer", () => {
    const { trace, events } = recorder();
    trace.thinking("Need the ");
    trace.thinking("machines.");
    trace.text("I'll check ");
    trace.text("your machines.");
    trace.toolStarted("t1", "list_machines", {});
    trace.toolFinished("t1", true, [{ name: "devbox" }]);
    trace.thinking("One machine.");
    trace.text("You have **one**.");
    const { answer, trace: saved } = trace.finish("ignored");
    expect(answer).toBe("You have **one**.");
    expect(saved?.steps).toEqual([
      { kind: "thinking", text: "Need the machines." },
      { kind: "text", text: "I'll check your machines." },
      {
        kind: "tool",
        id: "t1",
        name: "list_machines",
        input: {},
        status: "done",
        output: '[{"name":"devbox"}]',
      },
      { kind: "thinking", text: "One machine." },
    ]);
    // Every piece went out live, text included.
    expect(events.map((e) => e.type)).toEqual([
      "agent.thinking",
      "agent.thinking",
      "agent.delta",
      "agent.delta",
      "agent.tool",
      "agent.tool",
      "agent.thinking",
      "agent.delta",
    ]);
  });

  it("uses the last text step when nothing follows the last tool call", () => {
    const { trace } = recorder();
    trace.text("Started the task.");
    trace.toolStarted("t1", "get_task", { taskId: "tsk_1" });
    trace.toolFinished("t1", false, "no such task");
    const { answer, trace: saved } = trace.finish("");
    expect(answer).toBe("Started the task.");
    expect(saved?.steps.map((s) => s.kind)).toEqual(["tool"]);
  });

  it("has no trace for a plain answer", () => {
    const { trace } = recorder();
    trace.text("Hi.");
    expect(trace.finish("")).toEqual({ answer: "Hi.", trace: null });
  });

  it("falls back to the CLI's own reply text when nothing streamed", () => {
    const { trace } = recorder();
    expect(trace.finish(" Done. ").answer).toBe("Done.");
  });
});

describe("tool calls that change while they run", () => {
  it("applies a change that came before the call was recorded", () => {
    const { trace, events } = recorder();
    const approval = { id: "cap_1", state: "pending" as const, machine: "devbox" };
    trace.toolUpdate("t1", { approval });
    expect(events).toEqual([]);
    trace.toolStarted("t1", "run_command", { command: "touch x" });
    trace.toolUpdate("t1", { approval: { ...approval, state: "approved" } });
    trace.toolFinished("t1", true, { exitCode: 0, output: "" });
    const steps = trace.finish("Done.").trace?.steps;
    expect(steps?.[0]).toMatchObject({
      name: "run_command",
      status: "done",
      approval: { id: "cap_1", state: "approved" },
    });
    expect(events.map((e) => (e.type === "agent.tool" ? e.step.approval?.state : null))).toEqual([
      "pending",
      "approved",
      "approved",
    ]);
  });

  it("keeps a long command result as JSON, with its output cut", () => {
    const { trace } = recorder();
    trace.toolStarted("t1", "run_command", { command: "yes | head -n 100000" });
    trace.toolFinished("t1", true, { exitCode: 0, output: "y\n".repeat(50_000) });
    const step = trace.finish("").trace?.steps[0];
    const output = step?.kind === "tool" ? (step.output ?? "") : "";
    const parsed = JSON.parse(output) as { exitCode: number; output: string };
    expect(parsed.exitCode).toBe(0);
    expect(parsed.output.length).toBeLessThan(13_000);
    expect(parsed.output.endsWith("…")).toBe(true);
  });

  it("shows the reply so far to a chat opened mid-turn", () => {
    const { trace } = recorder();
    trace.thinking("Looking.");
    trace.toolStarted("t1", "run_command", { command: "ls" });
    trace.text("Your Desk");
    const live = trace.snapshot();
    expect(live.text).toBe("Your Desk");
    expect(live.steps.map((s) => s.kind)).toEqual(["thinking", "tool"]);
    expect(live.startedAt).toBeLessThanOrEqual(Date.now());
  });
});
