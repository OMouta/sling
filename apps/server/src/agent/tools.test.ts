import type { PermissionMode, RunnerView } from "@sling/core";
import { describe, expect, it } from "vitest";
import { commandPlan, pickCommandMachine } from "./tools.ts";

function machine(over: Partial<RunnerView> & { sandbox?: boolean; shell?: boolean | null }) {
  const { sandbox = true, shell = true, ...rest } = over;
  return {
    id: "rnr_1",
    name: "devbox",
    online: true,
    maxMode: "full-access",
    capabilities: [
      ...(shell === null ? [] : [{ name: "shell", version: "1", ready: shell, detail: "" }]),
      {
        name: "shell.sandbox",
        version: "",
        ready: sandbox,
        detail: sandbox ? "sandbox-exec" : "Install bubblewrap.",
      },
    ],
    ...rest,
  } as RunnerView;
}

const plan = (mode: PermissionMode, r: RunnerView, outside = false) =>
  commandPlan(mode, r, outside);

describe("where a command runs", () => {
  it("stays in the sandbox unless Full access, and asks before leaving it", () => {
    const m = machine({});
    expect(plan("read-only", m)).toEqual({ sandboxed: true, ask: false });
    expect(plan("supervised", m)).toEqual({ sandboxed: true, ask: false });
    expect(plan("auto", m)).toEqual({ sandboxed: true, ask: false });
    expect(plan("full-access", m)).toEqual({ sandboxed: false, ask: false });

    expect(plan("supervised", m, true)).toEqual({ sandboxed: false, ask: true });
    expect(plan("auto", m, true)).toEqual({ sandboxed: false, ask: true });
    expect(plan("full-access", m, true)).toEqual({ sandboxed: false, ask: false });
    expect(plan("read-only", m, true)).toEqual({ error: expect.stringContaining("Read-only") });
  });

  it("asks first on a machine without a sandbox, and refuses in Read-only", () => {
    const m = machine({ sandbox: false });
    expect(plan("auto", m)).toEqual({ sandboxed: false, ask: true });
    expect(plan("full-access", m)).toEqual({ sandboxed: false, ask: false });
    expect(plan("read-only", m)).toEqual({ error: expect.stringContaining("Install bubblewrap") });
  });

  it("never leaves the sandbox on a machine capped below Full access", () => {
    const m = machine({ maxMode: "auto" });
    expect(plan("full-access", m)).toEqual({ sandboxed: true, ask: false });
    expect(plan("auto", m, true)).toEqual({ error: expect.stringContaining("max mode is Auto") });
    const bare = machine({ maxMode: "supervised", sandbox: false });
    expect(plan("auto", bare)).toEqual({ error: expect.stringContaining("can't sandbox") });
  });

  it("explains a machine that turned commands off or runs an old Runner", () => {
    expect(plan("auto", machine({ shell: false }))).toEqual({
      error: expect.stringContaining("Commands are off on devbox"),
    });
    expect(plan("auto", machine({ shell: null }))).toEqual({
      error: expect.stringContaining("too old"),
    });
  });
});

describe("which machine a command runs on", () => {
  const a = machine({ id: "rnr_a", name: "Air" });
  const b = machine({ id: "rnr_b", name: "Studio" });
  const off = machine({ id: "rnr_c", name: "Old", online: false });

  it("takes the only online machine, or the one named", () => {
    expect(pickCommandMachine([a, off], undefined)).toEqual({ runner: a });
    expect(pickCommandMachine([a, b], "studio")).toEqual({ runner: b });
    expect(pickCommandMachine([a, b], "rnr_a")).toEqual({ runner: a });
  });

  it("asks for a name when several are online, and explains the rest", () => {
    expect(pickCommandMachine([a, b], undefined)).toEqual({
      error: expect.stringContaining("Air, Studio"),
    });
    expect(pickCommandMachine([off], undefined)).toEqual({
      error: expect.stringContaining("Old is offline"),
    });
    expect(pickCommandMachine([], undefined)).toEqual({
      error: "The user has no machines paired with Sling.",
    });
    expect(pickCommandMachine([a], "Old")).toEqual({
      error: expect.stringContaining("No machine"),
    });
    expect(pickCommandMachine([a, off], "old")).toEqual({ error: "Old is offline." });
  });
});
