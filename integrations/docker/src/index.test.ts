import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DockerError, describeTransportError, parseHost } from "./engine.ts";
import { FakeDocker, silentLog } from "./fakes.ts";
import { connector, createDockerConnector, PLAINTEXT_WARNING } from "./index.ts";
import { configSchema, credentialsSchema, type DockerConfig } from "./schemas.ts";

function runTest(docker: FakeDocker, config: Partial<DockerConfig> = {}, credentials = {}) {
  return createDockerConnector({ client: () => docker }).test({
    credentials: credentialsSchema.parse(credentials),
    config: configSchema.parse(config),
    log: silentLog,
    signal: new AbortController().signal,
  });
}

describe("Docker connection test", () => {
  it("reports the Docker version and that the image is there", async () => {
    const docker = new FakeDocker();
    docker.images.add("sling-sandbox:latest");
    expect(await runTest(docker)).toEqual({
      ok: true,
      detail:
        "Docker 29.4.0 (API 1.54, linux/arm64) at unix:///var/run/docker.sock. sling-sandbox:latest is on the host.",
    });
  });

  it("passes when the image is missing, and says it will be pulled", async () => {
    const result = await runTest(new FakeDocker(), { image: "ghcr.io/acme/sandbox:1" });
    expect(result).toMatchObject({
      ok: true,
      detail: expect.stringContaining(
        "ghcr.io/acme/sandbox:1 isn't on the host yet. It will be pulled on first use.",
      ),
    });
  });

  it("says how to build the default image when it's missing", async () => {
    const result = await runTest(new FakeDocker());
    expect(result).toMatchObject({
      ok: true,
      detail: expect.stringContaining("docker build -f deploy/sandbox/Dockerfile"),
    });
  });

  it("fails when the image is missing and the pull policy is never", async () => {
    const result = await runTest(new FakeDocker(), { pullPolicy: "never" });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("the pull policy is never"),
    });
  });

  it("fails when the network doesn't exist", async () => {
    const result = await runTest(new FakeDocker(), { network: "deploy_default" });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(`There's no Docker network called "deploy_default"`),
    });
  });

  it("warns about a plain TCP connection", async () => {
    const docker = new FakeDocker();
    docker.plaintextTcp = true;
    const result = await runTest(docker);
    expect(result).toMatchObject({ ok: true, detail: expect.stringContaining(PLAINTEXT_WARNING) });
  });

  it("explains a missing socket", async () => {
    const docker = new FakeDocker();
    const endpoint = parseHost({ host: "unix:///var/run/docker.sock" });
    docker.failures.set(
      "ping",
      describeTransportError(
        Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }),
        endpoint,
      ),
    );
    const result = await runTest(docker);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("There's no Docker socket at /var/run/docker.sock."),
    });
  });

  it("explains a socket it may not use", async () => {
    const docker = new FakeDocker();
    const endpoint = parseHost({ host: "unix:///var/run/docker.sock" });
    docker.failures.set(
      "ping",
      describeTransportError(
        Object.assign(new Error("connect EACCES"), { code: "EACCES" }),
        endpoint,
      ),
    );
    const result = await runTest(docker);
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/^Permission denied on the Docker socket.*DOCKER_GID/),
    });
  });

  it("asks for both registry fields", async () => {
    const result = await runTest(new FakeDocker(), {}, { registryUsername: "bot" });
    expect(result).toEqual({
      ok: false,
      error: "Give both the registry username and password, or neither.",
    });
  });

  it("reports a daemon error", async () => {
    const docker = new FakeDocker();
    docker.failures.set("version", new DockerError("Couldn't read the Docker version: boom"));
    expect(await runTest(docker)).toEqual({
      ok: false,
      error: "Couldn't read the Docker version: boom",
    });
  });
});

describe("Docker connector definition", () => {
  it("is an execution provider with no nodes or source", () => {
    expect(connector.id).toBe("docker");
    expect(connector.nodes).toEqual([]);
    expect(connector.source).toBeUndefined();
    expect(connector.executionProvider).toBeDefined();
    expect(connector.setupHelp).toMatch(/docker-compose\.sandbox\.yml/);
  });

  it("keeps the key and registry login secret", () => {
    expect(connector.secretFields).toEqual(["tlsKey", "registryUsername", "registryPassword"]);
  });

  it("defaults to the local socket and the bundled image", () => {
    expect(connector.credentialsSchema.parse({})).toEqual({ host: "unix:///var/run/docker.sock" });
    expect(connector.configSchema.parse({})).toEqual({
      image: "sling-sandbox:latest",
      network: "bridge",
      pullPolicy: "missing",
      extraEnv: {},
    });
  });

  it("accepts a TLS host and an empty optional field", () => {
    expect(
      connector.credentialsSchema.parse({ host: "tcp://docker.lan:2376", tlsCa: "" }),
    ).toMatchObject({ host: "tcp://docker.lan:2376" });
    expect(connector.configSchema.parse({ controlPlaneUrl: "" })).toMatchObject({
      controlPlaneUrl: "",
    });
  });

  it("rejects hosts and settings it can't use", () => {
    expect(() => connector.credentialsSchema.parse({ host: "docker.lan" })).toThrow();
    expect(() => connector.credentialsSchema.parse({ host: "tcp://docker.lan" })).toThrow();
    expect(() => connector.credentialsSchema.parse({ tlsCa: "not a cert" })).toThrow(/PEM/);
    expect(() => connector.configSchema.parse({ network: "host" })).toThrow();
    expect(() => connector.configSchema.parse({ network: "container:sling" })).toThrow();
    expect(() => connector.configSchema.parse({ pullPolicy: "sometimes" })).toThrow();
    expect(() => connector.configSchema.parse({ controlPlaneUrl: "ftp://x" })).toThrow();
    expect(() => connector.configSchema.parse({ extraEnv: { SLING_URL: "x" } })).toThrow();
    expect(() => connector.configSchema.parse({ extraEnv: { OPENAI_API_KEY: "x" } })).toThrow();
    expect(() => connector.configSchema.parse({ extraEnv: { "1BAD": "x" } })).toThrow();
  });

  it("describes every field, for the form", () => {
    for (const schema of [connector.credentialsSchema, connector.configSchema]) {
      const json = z.toJSONSchema(schema, { io: "input" }) as {
        properties: Record<string, { description?: string }>;
      };
      for (const [key, prop] of Object.entries(json.properties)) {
        expect(prop.description, key).toBeTruthy();
      }
    }
  });

  it("includes the config keys the control plane reads", () => {
    const json = z.toJSONSchema(connector.configSchema, { io: "input" }) as {
      properties: Record<string, unknown>;
    };
    for (const key of ["image", "controlPlaneUrl", "cpus", "memoryMb"]) {
      expect(json.properties).toHaveProperty(key);
    }
  });
});
