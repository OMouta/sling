import { RailwayGraphQLError } from "railway";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeRailway, silentLog } from "./fakes.ts";
import { BAD_TOKEN, connector, createRailwayConnector } from "./index.ts";
import {
  configSchema,
  credentialsSchema,
  type RailwayConfig,
  type RailwayCredentials,
} from "./schemas.ts";

function runTest(
  railway: FakeRailway,
  config: Partial<RailwayConfig> = {},
  credentials: Partial<RailwayCredentials> = {},
) {
  return createRailwayConnector({ client: () => railway }).test({
    credentials: credentialsSchema.parse({ apiToken: "t", environmentId: "env-1", ...credentials }),
    config: configSchema.parse({
      image: "ghcr.io/acme/sling-sandbox:1",
      controlPlaneUrl: "https://sling.example.com",
      ...config,
    }),
    log: silentLog,
    signal: new AbortController().signal,
  });
}

describe("Railway connection test", () => {
  it("checks the token and environment with one list call", async () => {
    const railway = new FakeRailway();
    const result = await runTest(railway);
    expect(result).toEqual({
      ok: true,
      detail: expect.stringMatching(
        /^Railway accepted the token, and environment env-1 is reachable\./,
      ),
    });
    expect(railway.calls).toEqual(["list 1"]);
  });

  it("explains a rejected token", async () => {
    const railway = new FakeRailway();
    railway.failures.set(
      "list",
      new RailwayGraphQLError({
        message: "Not Authorized",
        status: 200,
        errors: [{ message: "Not Authorized" }],
      }),
    );
    expect(await runTest(railway)).toEqual({ ok: false, error: BAD_TOKEN });
  });

  it("explains an environment the token can't reach", async () => {
    const railway = new FakeRailway();
    railway.failures.set(
      "list",
      new RailwayGraphQLError({
        message: "x",
        status: 200,
        errors: [{ message: "Environment not found" }],
      }),
    );
    expect(await runTest(railway)).toEqual({
      ok: false,
      error: expect.stringMatching(/^Railway has no environment env-1 that this token can reach\./),
    });
  });

  it("explains a network failure", async () => {
    const railway = new FakeRailway();
    railway.failures.set(
      "list",
      Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND") }),
    );
    expect(await runTest(railway)).toEqual({
      ok: false,
      error: "Couldn't reach Railway's API: getaddrinfo ENOTFOUND.",
    });
  });

  it("with the sandbox check on, runs Docker in a small sandbox and destroys it", async () => {
    const railway = new FakeRailway();
    railway.respond = () => ({
      exitCode: 0,
      stdout: "29.1.0\nx86_64\n",
      stderr: "",
      timedOut: false,
    });
    const result = await runTest(railway, { testCreatesSandbox: true });
    expect(result).toEqual({
      ok: true,
      detail:
        "Railway accepted the token, and environment env-1 is reachable. A test sandbox on x86_64 ran Docker 29.1.0 and found ghcr.io/acme/sling-sandbox:1 on its registry.",
    });
    expect(railway.creates).toEqual([
      { idleTimeoutMinutes: 5, resources: { cpu: 1, memoryGB: 1 } },
    ]);
    expect(railway.execs[0]?.command).toContain(
      "docker manifest inspect 'ghcr.io/acme/sling-sandbox:1'",
    );
    expect([...railway.sandboxes.values()].map((s) => s.status)).toEqual(["DESTROYED"]);
  });

  it("reports an image the sandbox can't see, and still destroys the sandbox", async () => {
    const railway = new FakeRailway();
    railway.respond = () => ({
      exitCode: 1,
      stdout: "29.1.0\n",
      stderr: "no such manifest: ghcr.io/acme/sling-sandbox:1",
      timedOut: false,
    });
    const result = await runTest(railway, { testCreatesSandbox: true });
    expect(result).toEqual({
      ok: false,
      error:
        "Checking Docker and ghcr.io/acme/sling-sandbox:1 in a test sandbox failed (exit 1): no such manifest: ghcr.io/acme/sling-sandbox:1",
    });
    expect([...railway.sandboxes.values()].map((s) => s.status)).toEqual(["DESTROYED"]);
  });

  it("logs in to the registry for the check, by env", async () => {
    const railway = new FakeRailway();
    await runTest(
      railway,
      { testCreatesSandbox: true },
      { registryUsername: "bot", registryPassword: "pw-secret" },
    );
    expect(railway.execs[0]?.env).toEqual({
      SLING_REGISTRY_USERNAME: "bot",
      SLING_REGISTRY_PASSWORD: "pw-secret",
    });
    expect(railway.execs[0]?.command).not.toContain("pw-secret");
  });

  it("asks for both registry fields", async () => {
    expect(await runTest(new FakeRailway(), {}, { registryPassword: "x" })).toEqual({
      ok: false,
      error: "Give both the registry username and password, or neither.",
    });
  });
});

describe("Railway connector definition", () => {
  it("is an execution provider with no nodes or source", () => {
    expect(connector.id).toBe("railway");
    expect(connector.nodes).toEqual([]);
    expect(connector.source).toBeUndefined();
    expect(connector.executionProvider).toBeDefined();
    expect(connector.setupHelp).toMatch(/environment ID/);
  });

  it("keeps the token and registry login secret", () => {
    expect(connector.secretFields).toEqual(["apiToken", "registryUsername", "registryPassword"]);
  });

  it("needs a token, an environment, an image, and an HTTPS control plane URL", () => {
    expect(() => connector.credentialsSchema.parse({})).toThrow();
    expect(connector.credentialsSchema.parse({ apiToken: "t", environmentId: "e" })).toEqual({
      apiToken: "t",
      environmentId: "e",
      tokenType: "account",
    });
    expect(() => connector.configSchema.parse({ controlPlaneUrl: "https://s" })).toThrow();
    expect(() => connector.configSchema.parse({ image: "x" })).toThrow();
    expect(() =>
      connector.configSchema.parse({ image: "x", controlPlaneUrl: "http://sling.lan:8080" }),
    ).toThrow(/https/);
    expect(
      connector.configSchema.parse({ image: "x", controlPlaneUrl: "https://s.example" }),
    ).toEqual({
      image: "x",
      controlPlaneUrl: "https://s.example",
      idleTimeoutMinutes: 5,
      testCreatesSandbox: false,
    });
  });

  it("keeps the idle timeout within Railway's range", () => {
    const base = { image: "x", controlPlaneUrl: "https://s" };
    expect(() => connector.configSchema.parse({ ...base, idleTimeoutMinutes: 0 })).toThrow();
    expect(() => connector.configSchema.parse({ ...base, idleTimeoutMinutes: 121 })).toThrow();
    expect(connector.configSchema.parse({ ...base, idleTimeoutMinutes: 120 })).toMatchObject({
      idleTimeoutMinutes: 120,
    });
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
});
