/**
 * The Fly Machines extension: an execution provider that runs each Sling
 * sandbox as a Fly Machine in an app of your own. It uses only the global
 * fetch, which Sling routes through its network rules.
 */
import { defineConnector, defineExtension, type TestResult } from "@sling/connector-sdk";
import { FlyApi } from "./api.ts";
import { createFlyProvider } from "./provider.ts";
import {
  CONNECTOR_ID,
  configSchema,
  credentialsSchema,
  type FlyConfig,
  type FlyCredentials,
} from "./schemas.ts";

export type { FlyConfig, FlyCredentials } from "./schemas.ts";

async function testApp(
  credentials: FlyCredentials,
  config: FlyConfig,
  signal: AbortSignal,
): Promise<TestResult> {
  const fly = new FlyApi({
    apiUrl: config.apiUrl,
    token: credentials.apiToken,
    app: config.app,
    signal,
  });
  try {
    const app = await fly.getApp();
    const org = app.organization?.slug ? ` in ${app.organization.slug}` : "";
    return {
      ok: true,
      detail: `Fly accepted the token, and the app ${app.name ?? config.app}${org} is reachable.`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function createFlyConnector(options: { now?: () => number } = {}) {
  return defineConnector<FlyCredentials, FlyConfig>({
    id: CONNECTOR_ID,
    name: "Fly Machines",
    description: "Run coding tasks in fresh Fly Machines in your own Fly app.",
    setupHelp: [
      "1. Make an empty app for sandboxes: `fly apps create`",
      "2. Make a token for it: `fly tokens create deploy --app <app>`",
      "3. Push the sandbox image where Fly can pull it, such as `registry.fly.io/<app>`",
    ].join("\n"),
    credentialsSchema,
    secretFields: ["apiToken"],
    configSchema,
    async test({ credentials, config, signal }) {
      return testApp(credentials, config, signal);
    },
    nodes: [],
    executionProvider: createFlyProvider(options),
  });
}

export const connector = createFlyConnector();

export default defineExtension({ connectors: [connector] });
