/**
 * Runs the provider against the real local Docker daemon.
 * `pnpm --filter @sling/integration-docker test:integration`
 *
 * With OrbStack, point it at its socket first:
 *   export DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { NodeLogger, ProviderContext, SandboxSpec } from "@sling/connector-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEngineClient } from "../src/engine.ts";
import { createDockerConnector, DEFAULT_HOST, EXPIRY_GRACE_MS } from "../src/index.ts";
import {
  configSchema,
  credentialsSchema,
  type DockerConfig,
  type DockerCredentials,
} from "../src/schemas.ts";

const HOST = process.env.DOCKER_HOST?.trim() || DEFAULT_HOST;
const IMAGE = "alpine:3";
/** Small, and not something the tests otherwise use, so it can be removed and pulled again. */
const PULL_IMAGE = "busybox:1.36.1-musl";
const RUN = randomUUID().slice(0, 8);
const WORKSPACE = `ws_it_${RUN}`;
const NETWORK = `sling-it-${RUN}`;
const COMMAND = ["sh", "-c", "env | grep SLING_ > /proc/1/fd/1; sleep 300"];

const silentLog: NodeLogger = { info() {}, warn() {}, error() {} };
const api = createEngineClient({ host: HOST });
const connector = createDockerConnector({ command: COMMAND });
const provider = connector.executionProvider as NonNullable<typeof connector.executionProvider>;

function ctx(config: Partial<DockerConfig> = {}): ProviderContext<DockerCredentials, DockerConfig> {
  return {
    installationId: "ins_it",
    workspaceId: WORKSPACE,
    credentials: credentialsSchema.parse({ host: HOST }),
    config: configSchema.parse({ image: IMAGE, ...config }),
    log: silentLog,
    signal: AbortSignal.timeout(120_000),
  };
}

let counter = 0;
function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  const sandboxId = `sbx_${RUN}_${++counter}`;
  return {
    sandboxId,
    workspaceId: WORKSPACE,
    image: IMAGE,
    env: {
      SLING_URL: "http://host.docker.internal:39999",
      SLING_PAIR_CODE: `pair-${RUN}`,
      SLING_SANDBOX_ID: sandboxId,
      SLING_REPOS: JSON.stringify([
        {
          name: "site",
          cloneUrl: "https://github.com/a/site.git",
          defaultBranch: "main",
          network: false,
        },
      ]),
      SLING_HARNESSES: "codex,claude-code",
      SLING_MAX_MODE: "full-access",
      SLING_IDLE_EXIT_SECONDS: "900",
      SLING_GIT_TOKEN: `ghp_${RUN}`,
      OPENAI_API_KEY: `sk-${RUN}`,
    },
    labels: { "sling.sandbox": sandboxId, "sling.workspace": WORKSPACE, "sling.task": "tsk_it" },
    cpus: 0.5,
    memoryMb: 256,
    lifetimeSeconds: 600,
    ...overrides,
  };
}

/** Engine API calls the provider has no use for, such as image removal. Unix sockets only. */
function raw(method: string, path: string, body?: unknown): Promise<number> {
  if (!HOST.startsWith("unix://")) throw new Error("These tests need a unix:// DOCKER_HOST");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: HOST.slice("unix://".length),
        method,
        path,
        headers: payload ? { "Content-Type": "application/json" } : {},
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function cleanup() {
  const leftovers = await api.listContainers([`sling.workspace=${WORKSPACE}`]);
  await Promise.all(leftovers.map((c) => api.removeContainer(c.Id)));
}

async function logsContaining(id: string, text: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  let logs = "";
  while (Date.now() < deadline) {
    logs = await api.containerLogs(id);
    if (logs.includes(text)) return logs;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The container never logged ${text}. Logs so far:\n${logs}`);
}

beforeAll(async () => {
  await api.ping();
  if (!(await api.imageExists(IMAGE))) await api.pullImage(IMAGE, null);
  expect(
    await raw("POST", "/networks/create", { Name: NETWORK, Labels: { "sling.it": RUN } }),
  ).toBe(201);
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await raw("DELETE", `/networks/${NETWORK}`);
  await raw("DELETE", `/images/${PULL_IMAGE}?force=true`);
});

describe("Docker provider on a real daemon", () => {
  it("starts a container with the boot env, labels, and limits, and list finds it", async () => {
    const sandbox = spec();
    const { externalId, detail } = await provider.create(ctx(), sandbox);
    expect(externalId).toMatch(/^[0-9a-f]{64}$/);
    expect(detail).toContain(`sling-${sandbox.sandboxId}`);

    const logs = await logsContaining(externalId, "SLING_SANDBOX_ID=");
    for (const [key, value] of Object.entries(sandbox.env)) {
      if (key.startsWith("SLING_")) expect(logs).toContain(`${key}=${value}`);
    }

    const info = await api.inspectContainer(externalId);
    expect(info?.Name).toBe(`/sling-${sandbox.sandboxId}`);
    expect(info?.State.Running).toBe(true);
    expect(info?.Config.Env).toContain(`OPENAI_API_KEY=sk-${RUN}`);
    expect(info?.Config.Labels).toMatchObject({
      "sling.sandbox": sandbox.sandboxId,
      "sling.workspace": WORKSPACE,
      "sling.task": "tsk_it",
      "sling.expires-at": expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(info?.HostConfig).toMatchObject({
      NanoCpus: 500_000_000,
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      PublishAllPorts: false,
      AutoRemove: false,
      NetworkMode: "bridge",
    });
    expect(Object.keys(info?.NetworkSettings.Ports ?? {})).toEqual([]);

    expect(await provider.list(ctx())).toContainEqual({ externalId, sandboxId: sandbox.sandboxId });

    await provider.destroy(ctx(), externalId);
    expect(await api.inspectContainer(externalId)).toBeNull();
    expect((await provider.list(ctx())).map((c) => c.externalId)).not.toContain(externalId);
  });

  it("joins a named network", async () => {
    const { externalId } = await provider.create(ctx({ network: NETWORK }), spec());
    const info = await api.inspectContainer(externalId);
    expect(info?.HostConfig.NetworkMode).toBe(NETWORK);
    expect(Object.keys(info?.NetworkSettings.Networks ?? {})).toEqual([NETWORK]);
  });

  it("lists only this workspace's sandboxes", async () => {
    const mine = await provider.create(ctx(), spec());
    const other = await provider.create(ctx(), spec({ workspaceId: `ws_other_${RUN}` }));
    try {
      const listed = (await provider.list(ctx())).map((c) => c.externalId);
      expect(listed).toContain(mine.externalId);
      expect(listed).not.toContain(other.externalId);
    } finally {
      await api.removeContainer(other.externalId);
    }
  });

  it("treats destroying a missing container as success", async () => {
    await expect(provider.destroy(ctx(), `sling-missing-${RUN}`)).resolves.toBeUndefined();
    const { externalId } = await provider.create(ctx(), spec());
    await provider.destroy(ctx(), externalId);
    await expect(provider.destroy(ctx(), externalId)).resolves.toBeUndefined();
  });

  it("pulls an image that isn't on the host", async () => {
    await raw("DELETE", `/images/${PULL_IMAGE}?force=true`);
    expect(await api.imageExists(PULL_IMAGE)).toBe(false);
    const { externalId } = await provider.create(
      ctx({ image: PULL_IMAGE }),
      spec({ image: PULL_IMAGE }),
    );
    expect(await api.imageExists(PULL_IMAGE)).toBe(true);
    expect((await api.inspectContainer(externalId))?.Config.Image).toBe(PULL_IMAGE);
  });

  it("fails clearly on an image that can't be pulled, and leaves nothing behind", async () => {
    const image = `sling-it-missing/nothing-${RUN}:0`;
    await expect(provider.create(ctx({ image }), spec({ image }))).rejects.toThrow(
      `Couldn't pull ${image}`,
    );
    expect(await provider.list(ctx())).toEqual([]);
  });

  it("refuses a missing image without pulling under pull policy never", async () => {
    const image = `alpine:sling-missing-${RUN}`;
    await expect(
      provider.create(ctx({ image, pullPolicy: "never" }), spec({ image })),
    ).rejects.toThrow(/isn't on the Docker host, and the pull policy is never/);
  });

  it("removes a container past its lifetime when listing", async () => {
    const { externalId } = await provider.create(ctx(), spec({ lifetimeSeconds: 1 }));
    expect((await provider.list(ctx())).map((c) => c.externalId)).toContain(externalId);

    const later = createDockerConnector({
      command: COMMAND,
      now: () => Date.now() + EXPIRY_GRACE_MS + 2_000,
    }).executionProvider;
    expect((await later?.list(ctx()))?.map((c) => c.externalId)).not.toContain(externalId);
    expect(await api.inspectContainer(externalId)).toBeNull();
  });
});

describe("Docker connection test on a real daemon", () => {
  it("reports the daemon and the image", async () => {
    const result = await connector.test({
      credentials: credentialsSchema.parse({ host: HOST }),
      config: configSchema.parse({ image: IMAGE }),
      log: silentLog,
      signal: AbortSignal.timeout(30_000),
    });
    expect(result).toEqual({
      ok: true,
      detail: expect.stringMatching(/^Docker \d+\.\d+.* alpine:3 is on the host\.$/),
    });
  });

  it("explains a socket that isn't there", async () => {
    const result = await connector.test({
      credentials: credentialsSchema.parse({ host: `unix:///tmp/sling-missing-${RUN}.sock` }),
      config: configSchema.parse({}),
      log: silentLog,
      signal: AbortSignal.timeout(30_000),
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/^There's no Docker socket/),
    });
  });
});
