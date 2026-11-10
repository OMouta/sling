import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "./context.ts";
import { DeployService } from "./deploys/service.ts";
import { sweep } from "./jobs.ts";

vi.mock("./deliveries.ts", () => ({
  pruneDeliveries: vi.fn(async () => {}),
  reconcileSettlements: vi.fn(async () => {}),
}));

function fakeContext(automationPaused: boolean) {
  return {
    config: { automationPaused },
    tasks: { sweep: vi.fn(async () => {}) },
    sandboxes: { sweep: vi.fn(async () => {}) },
    deploys: { sweep: vi.fn(async () => {}) },
    engine: { reconcile: vi.fn(async () => {}) },
  };
}

describe("with automation paused", () => {
  it("the sweep leaves sandboxes and deploy steps alone", async () => {
    const paused = fakeContext(true);
    await sweep(paused as unknown as AppContext);
    expect(paused.tasks.sweep).toHaveBeenCalledOnce();
    expect(paused.sandboxes.sweep).not.toHaveBeenCalled();
    expect(paused.deploys.sweep).not.toHaveBeenCalled();

    const running = fakeContext(false);
    await sweep(running as unknown as AppContext);
    expect(running.sandboxes.sweep).toHaveBeenCalledOnce();
    expect(running.deploys.sweep).toHaveBeenCalledOnce();
  });

  it("a start leaves merges and deploys in flight, and a machine connecting starts none", async () => {
    for (const automationPaused of [true, false]) {
      const deploys = new DeployService({ config: { automationPaused } } as unknown as AppContext);
      vi.spyOn(deploys.verifier, "start").mockResolvedValue();
      const recover = vi.spyOn(deploys.steps, "recover").mockResolvedValue();
      const connected = vi.spyOn(deploys.steps, "machineConnected").mockResolvedValue();
      await deploys.start({} as never);
      await deploys.machineConnected("rnr_1");
      expect(recover).toHaveBeenCalledTimes(automationPaused ? 0 : 1);
      expect(connected).toHaveBeenCalledTimes(automationPaused ? 0 : 1);
    }
  });
});
