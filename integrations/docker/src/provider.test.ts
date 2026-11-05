import { SANDBOX_LABELS, type SandboxSpec } from "@sling/connector-sdk";
import { describe, expect, it } from "vitest";
import { DockerError } from "./engine.ts";
import { context, FakeDocker, recordingLog } from "./fakes.ts";
import {
  buildContainerSpec,
  containerName,
  createDockerProvider,
  EXPIRES_LABEL,
  EXPIRY_GRACE_MS,
  registryAuth,
} from "./provider.ts";
import { configSchema } from "./schemas.ts";

const NOW = Date.parse("2026-11-05T10:00:00Z");

function sandbox(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sandboxId: "sbx_abc123",
    workspaceId: "ws_1",
    image: "sling-sandbox:latest",
    env: {
      SLING_URL: "http://sling:8080",
      SLING_PAIR_CODE: "pair-secret-1",
      SLING_SANDBOX_ID: "sbx_abc123",
      SLING_REPOS: JSON.stringify([
        { name: "site", cloneUrl: "https://github.com/a/site.git", defaultBranch: "main" },
      ]),
      OPENAI_API_KEY: "sk-secret",
      SLING_GIT_TOKEN: "ghp_secret",
    },
    labels: { [SANDBOX_LABELS.sandbox]: "sbx_abc123", [SANDBOX_LABELS.workspace]: "ws_1" },
    lifetimeSeconds: 3600,
    ...overrides,
  };
}

function setup(command?: string[]) {
  const docker = new FakeDocker();
  docker.images.add("sling-sandbox:latest");
  const provider = createDockerProvider({ client: () => docker, now: () => NOW, command });
  return { docker, provider };
}

describe("container create options", () => {
  const config = configSchema.parse({
    network: "sling-sandboxes",
    cpus: 2,
    memoryMb: 4096,
    extraEnv: { HTTPS_PROXY: "http://proxy:3128" },
  });
  const body = buildContainerSpec({
    spec: sandbox({ labels: { ...sandbox().labels, "sling.task": "tsk_1" } }),
    config,
    image: "sling-sandbox:latest",
    expiresAt: new Date(NOW + 3_600_000),
  });

  it("passes the boot env through, plus extra variables", () => {
    expect(body.Env).toEqual(
      expect.arrayContaining([
        "SLING_URL=http://sling:8080",
        "SLING_PAIR_CODE=pair-secret-1",
        "SLING_SANDBOX_ID=sbx_abc123",
        `SLING_REPOS=${sandbox().env.SLING_REPOS}`,
        "OPENAI_API_KEY=sk-secret",
        "SLING_GIT_TOKEN=ghp_secret",
        "HTTPS_PROXY=http://proxy:3128",
      ]),
    );
    expect(body.Env).toHaveLength(7);
  });

  it("lets the boot env win over an extra variable with the same name", () => {
    const clash = buildContainerSpec({
      spec: sandbox({ env: { HTTPS_PROXY: "http://from-spec" } }),
      config: { ...config, extraEnv: { HTTPS_PROXY: "http://from-config" } },
      image: "x",
      expiresAt: new Date(NOW),
    });
    expect(clash.Env).toEqual(["HTTPS_PROXY=http://from-spec"]);
  });

  it("labels the container for list, with the spec's labels and the deadline", () => {
    expect(body.Labels).toEqual({
      "sling.sandbox": "sbx_abc123",
      "sling.workspace": "ws_1",
      "sling.task": "tsk_1",
      [EXPIRES_LABEL]: "2026-11-05T11:00:00.000Z",
    });
  });

  it("sets CPU and memory limits with swap off", () => {
    expect(body.HostConfig.NanoCpus).toBe(2_000_000_000);
    expect(body.HostConfig.Memory).toBe(4096 * 1024 * 1024);
    expect(body.HostConfig.MemorySwap).toBe(4096 * 1024 * 1024);
  });

  it("prefers the spec's limits over the installation's", () => {
    const limited = buildContainerSpec({
      spec: sandbox({ cpus: 0.5, memoryMb: 512 }),
      config,
      image: "x",
      expiresAt: new Date(NOW),
    });
    expect(limited.HostConfig.NanoCpus).toBe(500_000_000);
    expect(limited.HostConfig.Memory).toBe(512 * 1024 * 1024);
  });

  it("leaves limits off when none are set", () => {
    const open = buildContainerSpec({
      spec: sandbox(),
      config: configSchema.parse({}),
      image: "x",
      expiresAt: new Date(NOW),
    });
    expect(open.HostConfig).not.toHaveProperty("NanoCpus");
    expect(open.HostConfig).not.toHaveProperty("Memory");
  });

  it("drops every capability and blocks privilege escalation", () => {
    expect(body.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(body.HostConfig.CapAdd).toEqual([]);
    expect(body.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(body.HostConfig.Privileged).toBe(false);
    expect(body.HostConfig.PidsLimit).toBeGreaterThan(0);
  });

  it("runs an init process so leftover agent processes are reaped", () => {
    expect(body.HostConfig.Init).toBe(true);
  });

  it("publishes no ports and doesn't remove itself", () => {
    expect(body.HostConfig.PortBindings).toEqual({});
    expect(body.HostConfig.PublishAllPorts).toBe(false);
    expect(body).not.toHaveProperty("ExposedPorts");
    expect(body.HostConfig.AutoRemove).toBe(false);
    expect(body.HostConfig.RestartPolicy).toEqual({ Name: "no" });
  });

  it("joins the configured network", () => {
    expect(body.HostConfig.NetworkMode).toBe("sling-sandboxes");
  });

  it("keeps the image's command unless a test overrides it", () => {
    expect(body).not.toHaveProperty("Cmd");
    const overridden = buildContainerSpec({
      spec: sandbox(),
      config,
      image: "alpine:3",
      expiresAt: new Date(NOW),
      command: ["sleep", "1"],
    });
    expect(overridden.Cmd).toEqual(["sleep", "1"]);
  });

  it("refuses an environment variable name Docker can't take", () => {
    expect(() =>
      buildContainerSpec({
        spec: sandbox({ env: { "BAD=NAME": "x" } }),
        config,
        image: "x",
        expiresAt: new Date(NOW),
      }),
    ).toThrow(/isn't a valid environment variable/);
  });
});

describe("Docker provider create", () => {
  it("creates and starts a named container and returns its ID", async () => {
    const { docker, provider } = setup();
    const result = await provider.create(context(), sandbox());
    const [created] = [...docker.containers.values()];
    expect(created?.name).toBe("sling-sbx_abc123");
    expect(created?.state).toBe("running");
    expect(result.externalId).toBe(created?.id);
    expect(result.detail).toContain("sling-sbx_abc123");
    expect(docker.calls).toEqual([
      "imageExists sling-sandbox:latest",
      "createContainer sling-sbx_abc123",
      `startContainer ${created?.id}`,
    ]);
  });

  it("falls back to the installation's image when the spec has none", async () => {
    const { docker, provider } = setup();
    docker.images.add("ghcr.io/acme/sandbox:2");
    await provider.create(
      context({ config: { image: "ghcr.io/acme/sandbox:2" } }),
      sandbox({ image: "" }),
    );
    expect([...docker.containers.values()][0]?.spec.Image).toBe("ghcr.io/acme/sandbox:2");
  });

  it("never logs the environment", async () => {
    const { provider } = setup();
    const { log, lines } = recordingLog();
    await provider.create(context({ log }), sandbox());
    const logged = JSON.stringify(lines);
    for (const secret of ["pair-secret-1", "sk-secret", "ghp_secret"]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("with pull policy missing, pulls only an image that isn't there", async () => {
    const { docker, provider } = setup();
    await provider.create(context(), sandbox());
    expect(docker.pulls).toEqual([]);

    await provider.create(context(), sandbox({ sandboxId: "sbx_2", image: "alpine:3" }));
    expect(docker.pulls).toEqual([{ image: "alpine:3", auth: null }]);
  });

  it("with pull policy always, pulls even when the image is there", async () => {
    const { docker, provider } = setup();
    await provider.create(context({ config: { pullPolicy: "always" } }), sandbox());
    expect(docker.pulls.map((p) => p.image)).toEqual(["sling-sandbox:latest"]);
    expect(docker.calls).not.toContain("imageExists sling-sandbox:latest");
  });

  it("with pull policy never, refuses a missing image without pulling", async () => {
    const { docker, provider } = setup();
    await expect(
      provider.create(context({ config: { pullPolicy: "never" } }), sandbox({ image: "alpine:3" })),
    ).rejects.toThrow(/isn't on the Docker host, and the pull policy is never/);
    expect(docker.pulls).toEqual([]);
    expect(docker.containers.size).toBe(0);
  });

  it("explains how to build the default image when it can't be pulled", async () => {
    const { docker, provider } = setup();
    docker.images.clear();
    docker.failures.set(
      "pullImage",
      new DockerError("Couldn't pull sling-sandbox:latest: pull access denied", { status: 404 }),
    );
    await expect(provider.create(context(), sandbox())).rejects.toThrow(
      /pull access denied\. Build it on the Docker host: docker build -f deploy\/sandbox\/Dockerfile/,
    );
  });

  it("sends registry credentials with the pull", async () => {
    const { docker, provider } = setup();
    await provider.create(
      context({
        credentials: { registryUsername: "bot", registryPassword: "reg-secret" },
        config: { pullPolicy: "always" },
      }),
      sandbox({ image: "ghcr.io/acme/sandbox:1" }),
    );
    expect(docker.pulls).toEqual([
      {
        image: "ghcr.io/acme/sandbox:1",
        auth: { username: "bot", password: "reg-secret", serveraddress: "ghcr.io" },
      },
    ]);
  });

  it("removes the container if it won't start", async () => {
    const { docker, provider } = setup();
    docker.failures.set("startContainer", new DockerError("cgroup error", { status: 500 }));
    await expect(provider.create(context(), sandbox())).rejects.toThrow("cgroup error");
    expect(docker.containers.size).toBe(0);
  });

  it("replaces a container left from an earlier attempt at the same sandbox", async () => {
    const { docker, provider } = setup();
    const old = docker.seed("sling-sbx_abc123", { "sling.sandbox": "sbx_abc123" });
    const result = await provider.create(context(), sandbox());
    expect(docker.containers.has(old)).toBe(false);
    expect(docker.containers.get(result.externalId)?.state).toBe("running");
  });

  it("won't replace a container with the same name that isn't this sandbox's", async () => {
    const { docker, provider } = setup();
    docker.seed("sling-sbx_abc123", { other: "thing" });
    await expect(provider.create(context(), sandbox())).rejects.toThrow(/isn't this sandbox's/);
    expect(docker.containers.size).toBe(1);
  });

  it("passes a command override through", async () => {
    const { docker, provider } = setup(["sh", "-c", "sleep 300"]);
    await provider.create(context(), sandbox());
    expect([...docker.containers.values()][0]?.spec.Cmd).toEqual(["sh", "-c", "sleep 300"]);
  });
});

describe("Docker provider destroy", () => {
  it("stops, then force-removes", async () => {
    const { docker, provider } = setup();
    const { externalId } = await provider.create(context(), sandbox());
    docker.calls = [];
    await provider.destroy(context(), externalId);
    expect(docker.calls).toEqual([`stopContainer ${externalId}`, `removeContainer ${externalId}`]);
    expect(docker.containers.size).toBe(0);
  });

  it("treats a missing container as destroyed, every time", async () => {
    const { provider } = setup();
    await expect(provider.destroy(context(), "deadbeef")).resolves.toBeUndefined();
    await expect(provider.destroy(context(), "deadbeef")).resolves.toBeUndefined();
  });

  it("is idempotent after a real destroy", async () => {
    const { provider } = setup();
    const { externalId } = await provider.create(context(), sandbox());
    await provider.destroy(context(), externalId);
    await expect(provider.destroy(context(), externalId)).resolves.toBeUndefined();
  });

  it("still removes the container when stopping fails", async () => {
    const { docker, provider } = setup();
    const { externalId } = await provider.create(context(), sandbox());
    docker.failures.set("stopContainer", new DockerError("stop timed out", { status: 500 }));
    await provider.destroy(context(), externalId);
    expect(docker.containers.size).toBe(0);
  });

  it("fails when the daemon can't be reached, so the caller retries", async () => {
    const { docker, provider } = setup();
    docker.failures.set(
      "stopContainer",
      new DockerError("There's no Docker socket at /var/run/docker.sock.", { code: "ENOENT" }),
    );
    await expect(provider.destroy(context(), "abc")).rejects.toThrow(/no Docker socket/);
  });
});

describe("Docker provider list", () => {
  it("returns this workspace's sandbox containers with their sandbox IDs", async () => {
    const { docker, provider } = setup();
    const { externalId } = await provider.create(context(), sandbox());
    const orphan = docker.seed("sling-sbx_old", {
      "sling.sandbox": "sbx_old",
      "sling.workspace": "ws_1",
    });
    docker.seed("other-workspace", { "sling.sandbox": "sbx_x", "sling.workspace": "ws_2" });
    docker.seed("unrelated", { "com.example": "web" });

    const listed = await provider.list(context());
    expect(listed).toEqual([
      { externalId, sandboxId: "sbx_abc123" },
      { externalId: orphan, sandboxId: "sbx_old" },
    ]);
    expect(docker.calls).toContain("listContainers sling.sandbox,sling.workspace=ws_1");
  });

  it("removes containers well past their lifetime instead of listing them", async () => {
    const docker = new FakeDocker();
    let now = NOW;
    const provider = createDockerProvider({ client: () => docker, now: () => now });
    const { log, lines } = recordingLog();
    const expired = docker.seed("sling-sbx_late", {
      "sling.sandbox": "sbx_late",
      "sling.workspace": "ws_1",
      [EXPIRES_LABEL]: new Date(NOW - 1000).toISOString(),
    });
    const current = docker.seed("sling-sbx_ok", {
      "sling.sandbox": "sbx_ok",
      "sling.workspace": "ws_1",
      [EXPIRES_LABEL]: new Date(NOW + 60_000).toISOString(),
    });

    // Within the grace period the control plane gets to destroy it first.
    expect((await provider.list(context({ log }))).map((c) => c.sandboxId)).toEqual([
      "sbx_late",
      "sbx_ok",
    ]);

    now = NOW + EXPIRY_GRACE_MS;
    expect(await provider.list(context({ log }))).toEqual([
      { externalId: current, sandboxId: "sbx_ok" },
    ]);
    expect(docker.containers.has(expired)).toBe(false);
    expect(lines.some((l) => l.level === "warn" && /outlived its lifetime/.test(l.message))).toBe(
      true,
    );
  });

  it("still lists an expired container it couldn't remove", async () => {
    const docker = new FakeDocker();
    const provider = createDockerProvider({ client: () => docker, now: () => NOW });
    const id = docker.seed("sling-sbx_late", {
      "sling.sandbox": "sbx_late",
      "sling.workspace": "ws_1",
      [EXPIRES_LABEL]: new Date(NOW - EXPIRY_GRACE_MS).toISOString(),
    });
    docker.failures.set("removeContainer", new DockerError("device busy", { status: 500 }));
    expect(await provider.list(context())).toEqual([{ externalId: id, sandboxId: "sbx_late" }]);
  });
});

describe("helpers", () => {
  it("names containers after the sandbox, in characters Docker accepts", () => {
    expect(containerName("sbx_abc123")).toBe("sling-sbx_abc123");
    expect(containerName("a/b c")).toBe("sling-a-b-c");
  });

  it("builds registry auth only when both halves are set", () => {
    const creds = { host: "unix:///var/run/docker.sock" };
    expect(registryAuth(creds, "alpine:3")).toBeNull();
    expect(registryAuth({ ...creds, registryUsername: "u" }, "alpine:3")).toBeNull();
    expect(
      registryAuth({ ...creds, registryUsername: "u", registryPassword: "p" }, "alpine:3"),
    ).toEqual({ username: "u", password: "p", serveraddress: "https://index.docker.io/v1/" });
    expect(
      registryAuth({ ...creds, registryUsername: "u", registryPassword: "p" }, "localhost:5000/x"),
    ).toMatchObject({ serveraddress: "localhost:5000" });
  });
});
