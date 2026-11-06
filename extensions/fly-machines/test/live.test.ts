/**
 * Creates, lists, and destroys one real Fly Machine. It runs busybox, which
 * exits at once, so it bills for a few seconds at most. Skips unless
 * FLY_API_TOKEN and FLY_APP are set. FLY_REGION is optional.
 */
import { describe, expect, it } from "vitest";
import { connector } from "../src/index.ts";
import { configSchema } from "../src/schemas.ts";

const token = process.env.FLY_API_TOKEN;
const app = process.env.FLY_APP;
const log = { info() {}, warn() {}, error() {} };

describe.skipIf(!token || !app)("Fly Machines, live", () => {
  it("creates, lists, and destroys a Machine", async () => {
    const ctx = {
      installationId: "ins_live",
      workspaceId: `ws_live_${Date.now()}`,
      credentials: { apiToken: token as string },
      config: configSchema.parse({
        app,
        region: process.env.FLY_REGION ?? "",
        image: "registry-1.docker.io/library/busybox:1.36",
        cpus: 1,
        memoryMb: 256,
      }),
      log,
      signal: AbortSignal.timeout(120_000),
    };
    expect(
      await connector.test({
        credentials: ctx.credentials,
        config: ctx.config,
        log,
        signal: ctx.signal,
      }),
    ).toMatchObject({ ok: true });

    const provider = connector.executionProvider;
    const created = await provider?.create(ctx, {
      sandboxId: "sbx_live",
      workspaceId: ctx.workspaceId,
      image: "",
      env: { SLING_URL: "https://sling.invalid" },
      labels: { "sling.sandbox": "sbx_live", "sling.workspace": ctx.workspaceId },
      lifetimeSeconds: 300,
    });
    expect(created?.externalId).toBeTruthy();
    try {
      const listed = await provider?.list(ctx);
      // busybox may already have exited and been destroyed.
      for (const m of listed ?? []) expect(m.sandboxId).toBe("sbx_live");
    } finally {
      await provider?.destroy(ctx, created?.externalId as string);
    }
  }, 180_000);
});
