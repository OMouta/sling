import { describe, expect, it } from "vitest";
import { buildbox, devbox, sandboxRunner } from "../test/fixtures.ts";
import { codingAgents, isAgentCapability, machinesOnly, splitLabels } from "./machines.ts";

describe("machines", () => {
  it("leaves out sandbox Runners", () => {
    expect(machinesOnly([devbox, sandboxRunner, buildbox]).map((r) => r.name)).toEqual([
      "devbox",
      "buildbox",
    ]);
  });

  it("separates the machine's own labels from automatic ones", () => {
    expect(splitLabels(["ios", "os:macos", "arch:aarch64", "gpu"])).toEqual({
      own: ["ios", "gpu"],
      automatic: ["os:macos", "arch:aarch64"],
    });
  });

  it("lists every coding agent with its readiness", () => {
    expect(codingAgents(devbox)).toEqual([
      {
        harness: "codex",
        label: "Codex",
        installed: true,
        ready: true,
        version: "0.166.0",
        detail: "",
      },
      {
        harness: "claude-code",
        label: "Claude Code",
        installed: true,
        ready: false,
        version: "2.1.4",
        detail: "Not logged in. Run claude and sign in.",
      },
    ]);
    expect(codingAgents(buildbox).map((a) => [a.label, a.installed, a.ready])).toEqual([
      ["Codex", false, false],
      ["Claude Code", true, true],
    ]);
  });

  it("knows which capabilities are coding agents", () => {
    expect(isAgentCapability("coding.codex")).toBe(true);
    expect(isAgentCapability("coding.claude-code")).toBe(true);
    expect(isAgentCapability("git")).toBe(false);
  });
});
