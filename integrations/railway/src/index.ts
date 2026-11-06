import type { NodeLogger } from "@sling/connector-sdk";
import { type ConnectorDefinition, defineConnector, type TestResult } from "@sling/connector-sdk";
import type { RailwayClientFactory, RailwaySandbox } from "./api.ts";
import { describeRailwayError, describeScriptFailure } from "./errors.ts";
import { checkScript } from "./launch.ts";
import { createRailwayProvider, registryEnv, withRegistryLogin } from "./provider.ts";
import {
  CONNECTOR_ID,
  configSchema,
  credentialsSchema,
  type RailwayConfig,
  type RailwayCredentials,
} from "./schemas.ts";
import { createSdkClient } from "./sdk.ts";

export type {
  CreateSandboxOptions,
  ExecOptions,
  ExecOutcome,
  RailwayApi,
  RailwayClientFactory,
  RailwaySandbox,
  SandboxSummary,
} from "./api.ts";
export { BAD_TOKEN, RailwayProviderError } from "./errors.ts";
export { containerName, EXPIRES_LABEL, MARKER_PATH } from "./launch.ts";
export {
  LAUNCH_TIMEOUT_SECONDS,
  LIFETIME_GRACE_SECONDS,
  LIST_PAGE,
  PROBE_SETTLE_MS,
} from "./provider.ts";
export type { RailwayConfig, RailwayCredentials } from "./schemas.ts";
export { MAX_IDLE_TIMEOUT_MINUTES } from "./schemas.ts";
export { createSdkClient } from "./sdk.ts";

/** Small enough for every plan's limits. */
const TEST_SANDBOX = { cpu: 1, memoryGB: 1 };
const CHECK_TIMEOUT_SECONDS = 180;

export interface RailwayConnectorOptions {
  /** Builds the Railway client. Tests pass a fake. */
  client?: RailwayClientFactory;
  /** Replaces the image's command. Tests use it to run a stock image. */
  command?: string[];
  now?: () => number;
}

async function checkInSandbox(
  sandbox: RailwaySandbox,
  credentials: RailwayCredentials,
  config: RailwayConfig,
  signal: AbortSignal,
): Promise<TestResult> {
  const outcome = await sandbox.exec(checkScript(config.image, withRegistryLogin(credentials)), {
    env: registryEnv(credentials),
    timeoutSec: CHECK_TIMEOUT_SECONDS,
    signal,
  });
  if (outcome.exitCode !== 0 || outcome.timedOut) {
    return {
      ok: false,
      error: describeScriptFailure(
        `Checking Docker and ${config.image} in a test sandbox`,
        outcome,
      ),
    };
  }
  const [version = "unknown", arch = "unknown"] = outcome.stdout.trim().split("\n");
  return {
    ok: true,
    detail: `A test sandbox on ${arch} ran Docker ${version} and found ${config.image} on its registry.`,
  };
}

async function testConnection(
  client: RailwayClientFactory,
  credentials: RailwayCredentials,
  config: RailwayConfig,
  log: NodeLogger,
  signal: AbortSignal,
): Promise<TestResult> {
  if (Boolean(credentials.registryUsername?.trim()) !== Boolean(credentials.registryPassword)) {
    return { ok: false, error: "Give both the registry username and password, or neither." };
  }
  const environmentId = credentials.environmentId;
  const api = client(credentials);
  try {
    // The cheapest call that needs both a valid token and access to the environment.
    await api.list(1);
  } catch (error) {
    return { ok: false, error: describeRailwayError(error, environmentId) };
  }
  const reached = `Railway accepted the token, and environment ${environmentId} is reachable.`;
  if (!config.testCreatesSandbox) {
    return {
      ok: true,
      detail: `${reached} Turn on the sandbox check to also start a test sandbox and check Docker and the image in it.`,
    };
  }

  let sandbox: RailwaySandbox;
  try {
    sandbox = await api.create({
      idleTimeoutMinutes: config.idleTimeoutMinutes,
      resources: TEST_SANDBOX,
    });
  } catch (error) {
    return {
      ok: false,
      error: `Couldn't start a test sandbox: ${describeRailwayError(error, environmentId)}`,
    };
  }
  try {
    const checked = await checkInSandbox(sandbox, credentials, config, signal);
    return checked.ok ? { ok: true, detail: `${reached} ${checked.detail}` } : checked;
  } catch (error) {
    return { ok: false, error: describeRailwayError(error, environmentId) };
  } finally {
    await sandbox.destroy().catch((error: unknown) =>
      log.warn("Couldn't destroy the test sandbox", {
        externalId: sandbox.id,
        error: describeRailwayError(error),
      }),
    );
  }
}

export function createRailwayConnector(
  options: RailwayConnectorOptions = {},
): ConnectorDefinition<RailwayCredentials, RailwayConfig> {
  const client = options.client ?? createSdkClient;
  return defineConnector<RailwayCredentials, RailwayConfig>({
    id: CONNECTOR_ID,
    name: "Railway",
    description:
      "Runs coding tasks in fresh Railway Sandboxes on your own Railway account, when no machine can take them or you ask for a sandbox.",
    setupHelp:
      "In Railway, create a project for Sling with nothing else in it, open it, and press Cmd+K or Ctrl+K to copy its environment ID. Create a token under Account Settings > Tokens. Push the sandbox image to a registry the sandbox can pull from, such as ghcr.io, and add a registry login if it's private. The control plane URL must be Sling's public HTTPS address, since sandboxes connect back over the internet.",
    credentialsSchema,
    secretFields: ["apiToken", "registryUsername", "registryPassword"],
    configSchema,

    async test({ credentials, config, log, signal }): Promise<TestResult> {
      try {
        return await testConnection(client, credentials, config, log, signal);
      } catch (error) {
        return { ok: false, error: describeRailwayError(error, credentials.environmentId) };
      }
    },

    nodes: [],
    executionProvider: createRailwayProvider({
      client,
      command: options.command,
      now: options.now,
    }),
  });
}

export const connector = createRailwayConnector();
