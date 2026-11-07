import type { ServerEvent } from "@sling/core";
import { describe, expect, it } from "vitest";
import { FOLLOW_UPS_RULE, liveText, splitFollowUps, withoutFollowUps } from "./follow-ups.ts";
import { assistantInstructions, dateLine } from "./prompt.ts";
import { TraceRecorder } from "./trace.ts";

const reply =
  'Pasta with a tomato sauce works.\n\n<follow-ups>\nWhat if I have no tomatoes?\n- Make it vegan\n\n"How long does it keep?"\n4. Something else\n</follow-ups>';

describe("the follow-ups rule", () => {
  it("comes last in the fixed prompt, before the date", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    const prompt = assistantInstructions({ instructions: "You are Chef.", tools: [] }, "auto", now);
    expect(prompt.endsWith(`${FOLLOW_UPS_RULE}\n\n${dateLine(now, "UTC")}`)).toBe(true);
  });
});

describe("follow-ups in a finished reply", () => {
  it("takes the block out and keeps three clean lines", () => {
    expect(splitFollowUps(reply)).toEqual({
      text: "Pasta with a tomato sauce works.",
      followUps: ["What if I have no tomatoes?", "Make it vegan", "How long does it keep?"],
    });
  });

  it("leaves a reply without a block as it is", () => {
    expect(splitFollowUps("Just this.")).toEqual({ text: "Just this.", followUps: [] });
  });

  it("drops lines too long to tap, and reads a block that never closed", () => {
    const long = "x".repeat(121);
    expect(splitFollowUps(`Done.\n<follow-ups>\n${long}\nShorter one`)).toEqual({
      text: "Done.",
      followUps: ["Shorter one"],
    });
  });

  it("takes only the last block", () => {
    const text = "Use `<follow-ups>` tags.\n<follow-ups>\nMore\n</follow-ups>";
    expect(splitFollowUps(text)).toEqual({ text: "Use `<follow-ups>` tags.", followUps: ["More"] });
  });

  it("strips the block from a stored model step's last text part", () => {
    const step = withoutFollowUps({
      role: "assistant",
      content: [
        { type: "reasoning", text: "Think." },
        { type: "text", text: "Answer.\n<follow-ups>\nNext\n</follow-ups>" },
      ],
    });
    expect(step.content).toEqual([
      { type: "reasoning", text: "Think." },
      { type: "text", text: "Answer." },
    ]);
  });
});

describe("follow-ups while a reply streams", () => {
  it("hides everything from the tag on", () => {
    expect(liveText("Answer.\n\n<follow-ups>\nNext")).toBe("Answer.\n\n");
    expect(liveText("Answer.\n<follow-ups")).toBe("Answer.\n");
  });

  it("holds back a tag cut off at the end until it can tell", () => {
    expect(liveText("Answer.\n<follow-")).toBe("Answer.\n");
    expect(liveText("Answer.\n<")).toBe("Answer.\n");
    expect(liveText("a <b")).toBe("a <b");
    expect(liveText("x < 3")).toBe("x < 3");
  });

  it("never sends the block live, and saves its lines on the trace", () => {
    const events: ServerEvent[] = [];
    const trace = new TraceRecorder("cnv_1", (ev) => events.push(ev));
    for (const piece of [
      "Pasta works",
      ".\n\n<follow-",
      "ups>\nMake it vegan\n",
      "</follow-ups>",
    ]) {
      trace.text(piece);
    }
    expect(trace.snapshot().text).toBe("Pasta works.\n\n");
    const sent = events.flatMap((e) => (e.type === "agent.delta" ? [e.text] : [])).join("");
    expect(sent).toBe("Pasta works.\n\n");
    const { answer, trace: saved } = trace.finish("");
    expect(answer).toBe("Pasta works.");
    expect(saved).toMatchObject({ steps: [], followUps: ["Make it vegan"] });
  });

  it("sends a held-back piece once it turns out not to be the tag", () => {
    const events: ServerEvent[] = [];
    const trace = new TraceRecorder("cnv_1", (ev) => events.push(ev));
    trace.text("if a <");
    trace.text(" b");
    const sent = events.flatMap((e) => (e.type === "agent.delta" ? [e.text] : []));
    expect(sent).toEqual(["if a ", "< b"]);
    expect(trace.finish("").trace).toBeNull();
  });
});
