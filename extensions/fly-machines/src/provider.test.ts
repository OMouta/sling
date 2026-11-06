import type { ProviderContext, SandboxSpec } from "@sling/connector-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type FakeMachinesApi, startFakeMachinesApi } from "../test/fake-api.ts";
import extension, { createFlyConnector } from "./index.ts";
import { EXPIRY_GRACE_MS, guestFor, machineName } from "./provider.ts";
import { configSchema, type FlyConfig, type FlyCredentials } from "./schemas.ts";

let fly: FakeMachinesApi;
let clock = Date.parse("2026-11-06T10:00:00Z");
const connector = createFlyConnector({ now: () => clock });
const provider = connector.executionProvider as NonNullable<typeof connector.executionProvider>;
const lines: { level: string; message: string }[] = [];
const log = {
  info: (message: string) => lines.push({ level: "info", message }),
  warn: (message: string) => lines.push({ level: "warn", message }),
  error: (message: string) => lines.push({ level: "error", message }),
};

beforeAll(async () => {
  fly = await startFakeMachinesApi({ token: "FlyV1 fm2_test", apps: ["sling-sandboxes", "other"] });
});

afterAll(() => fly.close());

beforeEach(() => {
  fly.machines.clear();
  fly.requests = [];
  fly.pageSize = 50;
  lines.length = 0;
  clock = Date.parse("2026-11-06T10:00:00Z");
});

function ctx(
  config: Partial<FlyConfig> = {},
  overrides: { workspaceId?: string; token?: string } = {},
): ProviderContext<FlyCredentials, FlyConfig> {
  return {
    installationId: "ins_fly",
    workspaceId: overrides.workspaceId ?? "ws_1",
    credentials: { apiToken: overrides.token ?? "FlyV1 fm2_test" },
    config: configSchema.parse({
      app: "sling-sandboxes",
      image: "registry.fly.io/sling-sandboxes:sandbox",
      apiUrl: fly.url,
      ...config,
    }),
    log,
    signal: AbortSignal.timeout(5000),
  };
}

const SECRETS = {
  SLING_PAIR_CODE: "pair-code-secret",
  OPENAI_API_KEY: "sk-openai-secret",
  SLING_GIT_TOKEN: "ghp_secret",
};

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sandboxId: "sbx_Abc123",
    workspaceId: "ws_1",
    image: "",
    env: {
      SLING_URL: "https://sling.example.com",
      SLING_SANDBOX_ID: "sbx_Abc123",
      SLING_REPOS: "[]",
      ...SECRETS,
    },
    labels: { "sling.sandbox": "sbx_Abc123", "sling.workspace": "ws_1" },
    lifetimeSeconds: 3600,
    ...over,
  };
}

describe("create", () => {
  it("posts a Machine that runs the image with the spec's environment, and destroys itself", async () => {
    const created = await provider.create(
      ctx({ region: "fra" }),
      spec({ cpus: 3, memoryMb: 3000 }),
    );
    const req = fly.requests.find((r) => r.method === "POST");
    expect(req?.path).toBe("/v1/apps/sling-sandboxes/machines");
    expect(req?.authorization).toBe("Bearer FlyV1 fm2_test");
    expect(req?.body).toEqual({
      name: "sling-sbx-abc123",
      region: "fra",
      config: {
        image: "registry.fly.io/sling-sandboxes:sandbox",
        env: spec().env,
        guest: { cpu_kind: "shared", cpus: 4, memory_mb: 3072 },
        auto_destroy: true,
        restart: { policy: "no" },
        metadata: {
          sling_sandbox: "sbx_Abc123",
          sling_workspace: "ws_1",
          sling_expires_at: "2026-11-06T11:00:00.000Z",
        },
      },
    });
    expect(created.externalId).toMatch(/^[0-9a-f]{14}$/);
    expect(created.detail).toBe(`Machine ${created.externalId} in sling-sandboxes, fra`);
  });

  it("uses the spec's image when it has one, and defaults to 2 CPUs and 4 GB", async () => {
    await provider.create(ctx(), spec({ image: "ghcr.io/acme/sandbox:1" }));
    const body = fly.requests.find((r) => r.method === "POST")?.body as {
      region?: string;
      config: { image: string; guest: unknown };
    };
    expect(body.region).toBeUndefined();
    expect(body.config.image).toBe("ghcr.io/acme/sandbox:1");
    expect(body.config.guest).toEqual({ cpu_kind: "shared", cpus: 2, memory_mb: 4096 });
  });

  it("never logs the sandbox's secrets", async () => {
    await provider.create(ctx(), spec());
    const logged = JSON.stringify(lines);
    for (const secret of Object.values(SECRETS)) expect(logged).not.toContain(secret);
  });

  it("refuses a control plane URL a Fly Machine can't reach", async () => {
    await expect(
      provider.create(ctx(), spec({ env: { SLING_URL: "http://localhost:8080" } })),
    ).rejects.toThrow(/must be an https:\/\/ URL, not http:\/\/localhost:8080/);
    await provider.create(ctx(), spec({ env: { SLING_URL: "http://sling.internal:8080" } }));
    expect(fly.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("explains a bad token, a missing app, and Fly's own refusals", async () => {
    await expect(provider.create(ctx({}, { token: "wrong" }), spec())).rejects.toThrow(
      /Fly rejected the API token/,
    );
    await expect(provider.create(ctx({ app: "nope" }), spec())).rejects.toThrow(
      /Fly has no app called nope/,
    );
    fly.failNext = { status: 422, error: "invalid guest: memory too large for shared-cpu-2x" };
    await expect(provider.create(ctx(), spec())).rejects.toThrow(
      "Fly refused the request (422): invalid guest: memory too large for shared-cpu-2x",
    );
  });
});

describe("list and destroy", () => {
  it("lists this workspace's Sling Machines, page by page", async () => {
    fly.pageSize = 2;
    for (const id of ["a", "b", "c"]) {
      await provider.create(
        ctx(),
        spec({
          sandboxId: `sbx_${id}`,
          labels: { "sling.sandbox": `sbx_${id}`, "sling.workspace": "ws_1" },
        }),
      );
    }
    await provider.create(
      ctx({}, { workspaceId: "ws_2" }),
      spec({
        sandboxId: "sbx_other",
        workspaceId: "ws_2",
        labels: { "sling.sandbox": "sbx_other", "sling.workspace": "ws_2" },
      }),
    );
    const listed = await provider.list(ctx());
    expect(listed.map((m) => m.sandboxId).sort()).toEqual(["sbx_a", "sbx_b", "sbx_c"]);
    const lists = fly.requests.filter((r) => r.method === "GET");
    expect(lists.map((r) => r.query)).toEqual([
      { include_deleted: "false", "metadata.sling_workspace": "ws_1" },
      { include_deleted: "false", "metadata.sling_workspace": "ws_1", cursor: "2" },
    ]);
  });

  it("force-deletes a Machine, and counts a missing one as destroyed", async () => {
    const { externalId } = await provider.create(ctx(), spec());
    await provider.destroy(ctx(), externalId);
    const del = fly.requests.find((r) => r.method === "DELETE");
    expect(del?.path).toBe(`/v1/apps/sling-sandboxes/machines/${externalId}`);
    expect(del?.query).toEqual({ force: "true" });
    expect(fly.machines.get(externalId)?.state).toBe("destroyed");
    expect(await provider.list(ctx())).toEqual([]);
    await expect(provider.destroy(ctx(), "0123456789abcd")).resolves.toBeUndefined();
  });

  it("removes Machines past their lifetime and grace, and keeps the rest", async () => {
    const old = await provider.create(ctx(), spec({ sandboxId: "sbx_old", lifetimeSeconds: 60 }));
    clock += 60_000 + EXPIRY_GRACE_MS;
    const fresh = await provider.create(ctx(), spec({ sandboxId: "sbx_new" }));
    const listed = await provider.list(ctx());
    expect(listed.map((m) => m.externalId)).toEqual([fresh.externalId]);
    expect(fly.machines.get(old.externalId)?.state).toBe("destroyed");
    expect(
      lines.some((l) => l.message === "Removed a Fly Machine that outlived its lifetime"),
    ).toBe(true);
  });

  it("ignores Machines in the app that aren't Sling's", async () => {
    fly.machines.set("foreign", {
      app: "sling-sandboxes",
      id: "foreign",
      name: "web",
      state: "started",
      region: "iad",
      created_at: "",
      config: {
        image: "nginx",
        env: {},
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
        metadata: { sling_workspace: "ws_1" },
      },
    });
    expect(await provider.list(ctx())).toEqual([]);
  });
});

describe("guest sizes", () => {
  const config = configSchema.parse({ app: "a", image: "i" });
  it("rounds CPUs up to what Fly offers, and memory up to 256 MB steps", () => {
    expect(guestFor({ cpus: 1.5, memoryMb: 1000 }, config)).toEqual({
      cpu_kind: "shared",
      cpus: 2,
      memory_mb: 1024,
    });
    expect(guestFor({ cpus: 12 }, config).cpus).toBe(8);
    expect(guestFor({ cpus: 12 }, { ...config, cpuKind: "performance" }).cpus).toBe(16);
  });

  it("names Machines after the sandbox", () => {
    expect(machineName("sbx_AB.c")).toBe("sling-sbx-ab-c");
  });
});

describe("connection test", () => {
  const test = (c: Partial<FlyConfig> = {}, token = "FlyV1 fm2_test") => {
    const x = ctx(c, { token });
    return connector.test({ credentials: x.credentials, config: x.config, log, signal: x.signal });
  };

  it("checks the token can reach the app", async () => {
    expect(await test()).toEqual({
      ok: true,
      detail: "Fly accepted the token, and the app sling-sandboxes in personal is reachable.",
    });
    expect(await test({}, "bad")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/rejected the API token/),
    });
    expect(await test({ app: "missing" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no app called missing/),
    });
    expect(await test({ apiUrl: "http://127.0.0.1:1" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Couldn't reach the Fly Machines API/),
    });
  });
});

describe("the extension", () => {
  it("describes one sandbox provider with an apiUrl config field", () => {
    const [c] = extension.describe().connectors;
    expect(c?.id).toBe("fly-machines");
    expect(c?.isExecutionProvider).toBe(true);
    expect(c?.nodes).toEqual([]);
    expect(Object.keys(c?.configSchema.properties as object)).toContain("apiUrl");
  });
});
