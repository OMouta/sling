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
