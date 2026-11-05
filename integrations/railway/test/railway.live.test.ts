/**
 * Runs the provider against Railway Sandboxes on a real account. It creates
 * small sandboxes, which bill for the minute or two they run.
 *
 *   RAILWAY_API_TOKEN=... RAILWAY_ENVIRONMENT_ID=... \
 *     pnpm --filter @sling/integration-railway test:integration
 *
 * Set RAILWAY_TOKEN_TYPE=project for a project token. Use an environment
 * with nothing else in it.
 */
import { randomUUID } from "node:crypto";
import type { ProviderContext, SandboxSpec } from "@sling/connector-sdk";
import type { NodeLogger } from "@sling/workflow";
import { Sandbox } from "railway";
import { afterAll, describe, expect, it } from "vitest";
import { containerName, createRailwayConnector } from "../src/index.ts";
import {
  configSchema,
  credentialsSchema,
  type RailwayConfig,
  type RailwayCredentials,
} from "../src/schemas.ts";
import { createSdkClient } from "../src/sdk.ts";

const TOKEN = process.env.RAILWAY_API_TOKEN?.trim();
const ENVIRONMENT = process.env.RAILWAY_ENVIRONMENT_ID?.trim();
const LIVE = Boolean(TOKEN && ENVIRONMENT);

if (!LIVE) {
  // Vitest hides console output from a file whose tests are all skipped.
  process.stderr.write(
    "Skipping the Railway live tests: set RAILWAY_API_TOKEN and RAILWAY_ENVIRONMENT_ID to run them.\n",
  );
}

const RUN = randomUUID().slice(0, 8);
const WORKSPACE = `ws_live_${RUN}`;
const COMMAND = ["sh", "-c", "env | grep SLING_; sleep 900"];
const created: string[] = [];

const log: NodeLogger = {
  info: (m, d) => console.info(m, d ?? ""),
  warn: (m, d) => console.warn(m, d ?? ""),
  error: (m, d) => console.error(m, d ?? ""),
};

function credentials(): RailwayCredentials {
  return credentialsSchema.parse({
    apiToken: TOKEN,
    environmentId: ENVIRONMENT,
    tokenType: process.env.RAILWAY_TOKEN_TYPE === "project" ? "project" : "account",
  });
}

function config(overrides: Partial<RailwayConfig> = {}): RailwayConfig {
  return configSchema.parse({
    image: process.env.RAILWAY_TEST_IMAGE ?? "alpine:3",
    controlPlaneUrl: "https://sling.invalid",
    cpus: 1,
    memoryMb: 1024,
    idleTimeoutMinutes: 5,
    ...overrides,
  });
}

function ctx(): ProviderContext<RailwayCredentials, RailwayConfig> {
  return {
    installationId: "ins_live",
    workspaceId: WORKSPACE,
    credentials: credentials(),
    config: config(),
    log,
    signal: AbortSignal.timeout(600_000),
  };
}

const SECRET = `live-secret-${RUN}`;

function spec(): SandboxSpec {
  const sandboxId = `sbx_${RUN}_${created.length + 1}`;
  return {
    sandboxId,
    workspaceId: WORKSPACE,
    image: config().image,
    env: {
      SLING_URL: "https://sling.invalid",
      SLING_SANDBOX_ID: sandboxId,
      SLING_PAIR_CODE: SECRET,
      SLING_IDLE_EXIT_SECONDS: "900",
    },
    labels: { "sling.sandbox": sandboxId, "sling.workspace": WORKSPACE },
    lifetimeSeconds: 900,
  };
}

afterAll(async () => {
  if (!LIVE) return;
  const api = createSdkClient(credentials());
  for (const id of created) {
    const sandbox = await api.connect(id).catch(() => null);
    await sandbox?.destroy().catch(() => {});
  }
});

describe.skipIf(!LIVE)("Railway provider, live", () => {
  const connector = createRailwayConnector({ command: COMMAND });
  const provider = connector.executionProvider as NonNullable<typeof connector.executionProvider>;

  it("passes the connection test", async () => {
    const result = await connector.test({
      credentials: credentials(),
      config: config(),
      log,
      signal: AbortSignal.timeout(60_000),
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("passes the connection test that starts a sandbox and runs Docker in it", async () => {
    const result = await connector.test({
      credentials: credentials(),
      config: config({ testCreatesSandbox: true }),
      log,
      signal: AbortSignal.timeout(300_000),
    });
    expect(result).toEqual({ ok: true, detail: expect.stringContaining("ran Docker") });
  });

  it("runs the image with the boot env, lists it, and destroys it", async () => {
    const sandbox = spec();
    const { externalId } = await provider.create(ctx(), sandbox);
    created.push(externalId);

    // The env reached the container.
    const api = createSdkClient(credentials());
    const inside = await api.connect(externalId);
    const logs = await inside?.exec(`docker logs ${containerName(sandbox.sandboxId)}`, {
      timeoutSec: 60,
    });
    expect(logs?.stdout).toContain(`SLING_SANDBOX_ID=${sandbox.sandboxId}`);
    expect(logs?.stdout).toContain(`SLING_PAIR_CODE=${SECRET}`);

    // No secret shows in the commands Railway recorded.
    const raw = await Sandbox.connect(externalId, {
      token: TOKEN,
      environmentId: ENVIRONMENT,
      authType: credentials().tokenType === "project" ? "project-token" : "bearer",
    });
    const sessions = (await raw.sessions()) ?? [];
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) expect(s.command).not.toContain(SECRET);
    // The keepalive is still running, which keeps Railway from idling the sandbox out.
    expect(sessions.some((s) => s.running && s.command.includes("docker wait"))).toBe(true);

    expect(await provider.list(ctx())).toContainEqual({
      externalId,
      sandboxId: sandbox.sandboxId,
    });
    // A fresh provider, as after a restart, finds it by its marker.
    const fresh = createRailwayConnector().executionProvider;
    expect(await fresh?.list(ctx())).toContainEqual({ externalId, sandboxId: sandbox.sandboxId });

    await provider.destroy(ctx(), externalId);
    await provider.destroy(ctx(), externalId);
    expect((await provider.list(ctx())).map((s) => s.externalId)).not.toContain(externalId);
  });

  it("treats destroying a sandbox that never existed as success", async () => {
    await expect(provider.destroy(ctx(), `sbx-missing-${RUN}`)).resolves.toBeUndefined();
  });
});
