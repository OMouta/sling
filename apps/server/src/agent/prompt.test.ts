import { describe, expect, it } from "vitest";
import { personalityTemplate } from "../personalities/templates.ts";
import { assistantInstructions } from "./prompt.ts";
import { allowedTools } from "./tools.ts";

const now = new Date("2026-11-06T12:00:00Z");
const sling = personalityTemplate("sling");
const finance = personalityTemplate("finance");
if (!sling || !finance) throw new Error("personality templates missing");

describe("the assistant's prompt", () => {
  it("gives a personality with every tool all of Sling's rules", () => {
    const p = assistantInstructions(sling, "auto", now, { cli: true, agents: "AGENTS" });
    expect(p.startsWith("You are Sling, the user's own assistant.")).toBe(true);
    for (const part of [
      "Commands on the user's machines (run_command):",
      "Never start a coding task for these.",
      "Coding tasks in the user's repos (delegate_coding_task):",
      "This conversation is in Auto mode",
      "list_machines, run_command, delegate_coding_task, get_task, cancel_task",
      "Today is 2026-11-06.",
      "AGENTS",
    ]) {
      expect(p).toContain(part);
    }
  });

  it("tells a personality with no tools it has none, and nothing about modes or tasks", () => {
    const p = assistantInstructions(finance, "full-access", now, { cli: true, agents: "AGENTS" });
    expect(p.startsWith("You are Finance")).toBe(true);
    expect(p).toContain("You have no tools in this chat.");
    expect(p).toContain("You can't browse the web.");
    expect(p).toContain("Today is 2026-11-06.");
    for (const absent of ["run_command", "delegate_coding_task", "mode", "MCP", "AGENTS"]) {
      expect(p).not.toContain(absent);
    }
  });

  it("names only the tools a personality has", () => {
    const p = assistantInstructions(
      { instructions: "You are Ops.", tools: ["commands"] },
      "read-only",
      now,
      { cli: true, agents: "AGENTS" },
    );
    expect(p).toContain("commands always run in the sandbox");
    expect(p).toContain('"sling": list_machines, run_command.');
    expect(p).not.toContain("delegate_coding_task");
    expect(p).not.toContain("Never start a coding task");
    expect(p).not.toContain("AGENTS");
  });

  it("maps tool groups to tool names", () => {
    expect([...allowedTools([])]).toEqual([]);
    expect([...allowedTools(["coding"])]).toEqual([
      "list_machines",
      "delegate_coding_task",
      "get_task",
      "cancel_task",
    ]);
  });
});
