import { RailwayGraphQLError, SandboxNotFoundError, SandboxTimeoutError } from "railway";
import { describe, expect, it } from "vitest";
import { context, FakeRailway, type FakeSandbox, recordingLog, SECRETS, spec } from "./fakes.ts";
import { MARKER_PATH } from "./launch.ts";
import {
  createRailwayProvider,
  LAUNCH_TIMEOUT_SECONDS,
  LIFETIME_GRACE_SECONDS,
  LIST_PAGE,
  PROBE_SETTLE_MS,
  parseMarker,
  resourcesFor,
} from "./provider.ts";
import { configSchema } from "./schemas.ts";

function setup() {
  const railway = new FakeRailway();
  const provider = createRailwayProvider({ client: () => railway, now: () => railway.clock });
  return { railway, provider };
}

const marker = (sandboxId: string, workspaceId = "ws_1") =>
  JSON.stringify({ kind: "sling.sandbox", sandboxId, workspaceId });

describe("Railway provider create", () => {
  it("creates a sandbox, marks it, starts the image, then holds it open", async () => {
    const { railway, provider } = setup();
    const result = await provider.create(context(), spec());
    const [sandbox] = [...railway.sandboxes.values()] as [FakeSandbox];

    expect(result).toEqual({
      externalId: sandbox.id,
      detail: `Railway sandbox ${sandbox.id} in us-west2`,
    });
    expect(railway.calls).toEqual([
      "create",
      `writeFile ${sandbox.id} ${MARKER_PATH}`,
      `exec ${sandbox.id}`,
      `execDetached ${sandbox.id}`,
    ]);
    expect(railway.creates).toEqual([{ idleTimeoutMinutes: 5 }]);
    expect(parseMarker(sandbox.files.get(MARKER_PATH)?.content ?? "")).toEqual({
      sandboxId: "sbx_abc123",
      workspaceId: "ws_1",
    });

    const [launch, keepalive] = railway.execs;
    expect(launch?.detached).toBe(false);
    expect(launch?.timeoutSec).toBe(LAUNCH_TIMEOUT_SECONDS);
    expect(launch?.command).toContain("docker pull --quiet 'ghcr.io/acme/sling-sandbox:1'");
    expect(launch?.command).toContain("docker run -d --name 'sling-sbx_abc123'");
    expect(keepalive).toMatchObject({
      detached: true,
      command: `timeout ${3600 + LIFETIME_GRACE_SECONDS} docker wait 'sling-sbx_abc123' >/dev/null 2>&1; docker rm -f 'sling-sbx_abc123' >/dev/null 2>&1`,
    });
  });

  it("passes secrets as exec env, never in a command line or file", async () => {
    const { railway, provider } = setup();
    const { log, lines } = recordingLog();
    await provider.create(
      context({
        log,
        credentials: { registryUsername: "bot", registryPassword: "reg-password-secret" },
      }),
      spec(),
    );
    const secrets = [...Object.values(SECRETS), "reg-password-secret", "rw-token-secret"];
    const commands = railway.execs.map((e) => e.command).join("\n");
    const files = [...railway.sandboxes.values()]
      .flatMap((s) => [...s.files.values()].map((f) => f.content))
      .join("\n");
    for (const secret of secrets) {
      expect(commands).not.toContain(secret);
      expect(files).not.toContain(secret);
      expect(JSON.stringify(lines)).not.toContain(secret);
    }

    // They travel in the launch exec's env instead, and each is copied into the container by name.
    const launch = railway.execs[0];
    expect(launch?.env).toMatchObject({
      ...SECRETS,
      SLING_REGISTRY_USERNAME: "bot",
      SLING_REGISTRY_PASSWORD: "reg-password-secret",
    });
    for (const name of Object.keys(SECRETS)) expect(launch?.command).toContain(`-e ${name}`);
    expect(launch?.command).not.toContain("-e SLING_REGISTRY");
    expect(launch?.command).toContain('"$SLING_REGISTRY_PASSWORD" | docker login');
  });

  it("labels the container and sizes the sandbox", async () => {
    const { railway, provider } = setup();
    await provider.create(
      context({ config: { cpus: 2, memoryMb: 4096 } }),
      spec({ labels: { "sling.sandbox": "sbx_abc123", "sling.task": "tsk_1" } }),
    );
    expect(railway.creates).toEqual([
      { idleTimeoutMinutes: 5, resources: { cpu: 2, memoryGB: 4 } },
    ]);
    const command = railway.execs[0]?.command ?? "";
    expect(command).toContain("--label 'sling.sandbox=sbx_abc123'");
    expect(command).toContain("--label 'sling.workspace=ws_1'");
    expect(command).toContain("--label 'sling.task=tsk_1'");
    expect(command).toContain("--label 'sling.expires-at=2026-11-05T11:00:00.000Z'");
  });

  it("uses the installation's image when the spec has none", async () => {
    const { railway, provider } = setup();
    await provider.create(
      context({ config: { image: "docker.io/acme/sb:2" } }),
      spec({ image: "" }),
    );
    expect(railway.execs[0]?.command).toContain("docker pull --quiet 'docker.io/acme/sb:2'");
  });

  it("refuses a control plane URL that isn't HTTPS, before creating anything", async () => {
    const { railway, provider } = setup();
    await expect(
      provider.create(
        context(),
        spec({ env: { ...spec().env, SLING_URL: "http://10.0.0.2:8080" } }),
      ),
    ).rejects.toThrow(/must be an https:\/\/ URL, not http:\/\/10\.0\.0\.2:8080/);
    expect(railway.calls).toEqual([]);
  });

  it("destroys the sandbox and explains when the image won't start", async () => {
    const { railway, provider } = setup();
    railway.respond = () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Error response from daemon: pull access denied for acme/private",
      timedOut: false,
    });
    await expect(provider.create(context(), spec())).rejects.toThrow(
      "Starting the sandbox image failed (exit 1): Error response from daemon: pull access denied for acme/private",
    );
    expect([...railway.sandboxes.values()].map((s) => s.status)).toEqual(["DESTROYED"]);
    expect(await provider.list(context())).toEqual([]);
  });

  it("says so when Docker is missing from the sandbox", async () => {
    const { railway, provider } = setup();
    railway.respond = () => ({ exitCode: 96, stdout: "", stderr: "", timedOut: false });
    await expect(provider.create(context(), spec())).rejects.toThrow(
      /Docker isn't installed in this Railway sandbox/,
    );
  });

  it("destroys the sandbox when the launch times out", async () => {
    const { railway, provider } = setup();
    railway.respond = () => ({ exitCode: -1, stdout: "", stderr: "", timedOut: true });
    await expect(provider.create(context(), spec())).rejects.toThrow(
      /timed out inside the sandbox/,
    );
    expect([...railway.sandboxes.values()][0]?.status).toBe("DESTROYED");
  });

  it("destroys the sandbox when it can't be held open", async () => {
    const { railway, provider } = setup();
    railway.failures.set("execDetached", new Error("no durable session"));
    await expect(provider.create(context(), spec())).rejects.toThrow("no durable session");
    expect([...railway.sandboxes.values()][0]?.status).toBe("DESTROYED");
  });

  it("cleans up a sandbox that never reached RUNNING", async () => {
    const { railway, provider } = setup();
    const stuck = railway.seed("sbx-stuck", { status: "CREATING" });
    railway.failures.set(
      "create",
      new SandboxTimeoutError({
        resource: "sandbox",
        id: "sbx-stuck",
        lastStatus: "CREATING",
        timeoutMs: 300_000,
      }),
    );
    await expect(provider.create(context(), spec())).rejects.toThrow(
      "The Railway sandbox sbx-stuck still wasn't running after 5 minutes (last status CREATING).",
    );
    expect(stuck.status).toBe("DESTROYED");
  });

  it("maps a refused token to directions", async () => {
    const { railway, provider } = setup();
    railway.failures.set(
      "create",
      new RailwayGraphQLError({
        message: "Not Authorized",
        status: 200,
        errors: [{ message: "Not Authorized" }],
      }),
    );
    await expect(provider.create(context(), spec())).rejects.toThrow(
      /Railway rejected the API token/,
    );
  });

  it("passes Railway's own reason through for a refused create", async () => {
    const { railway, provider } = setup();
    railway.failures.set(
      "create",
      new RailwayGraphQLError({
        message: "bad",
        status: 400,
        errors: [{ message: "idleTimeoutMinutes must be between 1 and 5 on this plan" }],
      }),
    );
    await expect(
      provider.create(context({ config: { idleTimeoutMinutes: 30 } }), spec()),
    ).rejects.toThrow(
      "Railway refused the request: idleTimeoutMinutes must be between 1 and 5 on this plan",
    );
  });

  it("stops and destroys the sandbox when aborted", async () => {
    const { railway, provider } = setup();
    const controller = new AbortController();
    railway.respond = () => {
      controller.abort(new Error("server stopping"));
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    railway.failures.set("execDetached", new Error("aborted"));
    await expect(provider.create(context({ signal: controller.signal }), spec())).rejects.toThrow(
      "server stopping",
    );
    expect([...railway.sandboxes.values()][0]?.status).toBe("DESTROYED");
  });
});

describe("Railway provider destroy", () => {
  it("destroys the sandbox", async () => {
    const { railway, provider } = setup();
    const { externalId } = await provider.create(context(), spec());
    await provider.destroy(context(), externalId);
    expect(railway.sandboxes.get(externalId)?.status).toBe("DESTROYED");
  });

  it("treats a missing sandbox as destroyed", async () => {
    const { railway, provider } = setup();
    await expect(provider.destroy(context(), "sbx-nope")).resolves.toBeUndefined();
    railway.failures.set(
      "connect",
      new SandboxNotFoundError({ id: "sbx-nope", environmentId: "env-1" }),
    );
    await expect(provider.destroy(context(), "sbx-nope")).resolves.toBeUndefined();
  });

  it("is idempotent", async () => {
    const { railway, provider } = setup();
    const { externalId } = await provider.create(context(), spec());
    await provider.destroy(context(), externalId);
    railway.calls = [];
    await provider.destroy(context(), externalId);
    expect(railway.calls).toEqual([`connect ${externalId}`]);
  });

  it("accepts a sandbox that went away while being destroyed", async () => {
    const { railway, provider } = setup();
    const sandbox = railway.seed("sbx-racing");
    railway.failures.set(
      "destroy",
      new RailwayGraphQLError({ message: "x", status: 200, errors: [{ message: "boom" }] }),
    );
    // It idled out between the two reads.
    const connect = railway.connect.bind(railway);
    let reads = 0;
    railway.connect = async (id) => (++reads === 1 ? connect(id) : null);
    await expect(provider.destroy(context(), sandbox.id)).resolves.toBeUndefined();
  });

  it("fails when the sandbox is still there", async () => {
    const { railway, provider } = setup();
    const sandbox = railway.seed("sbx-sticky");
    railway.failures.set(
      "destroy",
      new RailwayGraphQLError({
        message: "x",
        status: 500,
        errors: [{ message: "internal error" }],
      }),
    );
    await expect(provider.destroy(context(), sandbox.id)).rejects.toThrow(
      "Railway refused the request: internal error",
    );
  });
});

describe("Railway provider list", () => {
  it("lists sandboxes this provider created, without reading anything", async () => {
    const { railway, provider } = setup();
    const { externalId } = await provider.create(context(), spec());
    railway.calls = [];
    expect(await provider.list(context())).toEqual([{ externalId, sandboxId: "sbx_abc123" }]);
    expect(railway.calls).toEqual([`list ${LIST_PAGE}`]);
  });

  it("recognizes Sling's sandboxes by their marker after a restart", async () => {
    const { railway, provider } = setup();
    railway.seed("sbx-orphan", { marker: marker("sbx_old") });
    railway.seed("sbx-theirs");
    railway.seed("sbx-other-ws", { marker: marker("sbx_x", "ws_2") });
    railway.seed("sbx-junk", { marker: "not json" });
    expect(await provider.list(context())).toEqual([
      { externalId: "sbx-orphan", sandboxId: "sbx_old" },
    ]);
  });

  it("reads each marker once", async () => {
    const { railway, provider } = setup();
    railway.seed("sbx-orphan", { marker: marker("sbx_old") });
    railway.seed("sbx-theirs");
    await provider.list(context());
    railway.calls = [];
    await provider.list(context());
    expect(railway.calls).toEqual([`list ${LIST_PAGE}`]);
  });

  it("checks a young unmarked sandbox again later, since it may still be starting", async () => {
    const { railway, provider } = setup();
    const young = railway.seed("sbx-young", {
      createdAt: new Date(railway.clock - PROBE_SETTLE_MS / 2).toISOString(),
    });
    expect(await provider.list(context())).toEqual([]);
    young.files.set(MARKER_PATH, { content: marker("sbx_new"), mode: 0o644 });
    expect(await provider.list(context())).toEqual([
      { externalId: "sbx-young", sandboxId: "sbx_new" },
    ]);
  });

  it("skips sandboxes going away, and ones it can't read yet", async () => {
    const { railway, provider } = setup();
    railway.seed("sbx-destroying", { status: "DESTROYING", marker: marker("a") });
    railway.seed("sbx-creating", { status: "CREATING", marker: marker("b") });
    expect(await provider.list(context())).toEqual([]);
    expect(railway.calls.filter((c) => c.startsWith("readFile"))).toEqual([]);
  });

  it("tries again next time when a marker can't be read", async () => {
    const { railway, provider } = setup();
    railway.seed("sbx-orphan", { marker: marker("sbx_old") });
    railway.failures.set("readFile", new Error("socket hang up"));
    const { log, lines } = recordingLog();
    expect(await provider.list(context({ log }))).toEqual([]);
    expect(lines[0]?.message).toMatch(/Couldn't check whether a Railway sandbox is Sling's/);
    expect(await provider.list(context())).toEqual([
      { externalId: "sbx-orphan", sandboxId: "sbx_old" },
    ]);
  });

  it("stops listing a sandbox once it's destroyed", async () => {
    const { provider } = setup();
    const { externalId } = await provider.create(context(), spec());
    await provider.destroy(context(), externalId);
    expect(await provider.list(context())).toEqual([]);
  });

  it("explains a list Railway refuses", async () => {
    const { railway, provider } = setup();
    railway.failures.set("list", new RailwayGraphQLError({ message: "x", status: 401 }));
    await expect(provider.list(context())).rejects.toThrow(/Railway rejected the API token/);
  });
});

describe("helpers", () => {
  it("converts memory to Railway's GB and leaves defaults alone", () => {
    const config = configSchema.parse({ image: "x", controlPlaneUrl: "https://s" });
    expect(resourcesFor(spec(), config)).toBeUndefined();
    expect(resourcesFor(spec({ memoryMb: 1536 }), config)).toEqual({ memoryGB: 1.5 });
    expect(resourcesFor(spec({ cpus: 0.5 }), { ...config, memoryMb: 2048 })).toEqual({
      cpu: 0.5,
      memoryGB: 2,
    });
  });

  it("reads only markers Sling wrote", () => {
    expect(parseMarker(marker("sbx_1"))).toEqual({ sandboxId: "sbx_1", workspaceId: "ws_1" });
    expect(parseMarker(JSON.stringify({ sandboxId: "x", workspaceId: "y" }))).toBeNull();
    expect(parseMarker("{")).toBeNull();
  });
});
