/**
 * The ntfy extension: publish push notifications, and start workflows from
 * messages on the topics an installation watches. It uses only the global
 * fetch and WebSocket, which Sling routes through its network rules.
 */
import { defineConnector, defineExtension, type TestResult } from "@sling/connector-sdk";
import { authHeaders, baseUrl, errorMessage } from "./client.ts";
import { publish } from "./publish.ts";
import {
  CONNECTOR_ID,
  configSchema,
  credentialsSchema,
  type NtfyConfig,
  type NtfyCredentials,
} from "./schemas.ts";
import { createNtfySource, type NtfySourceOptions } from "./source.ts";
import { messageReceived } from "./trigger.ts";

export type { NtfyConfig, NtfyCredentials, NtfyMessage } from "./schemas.ts";

async function testServer(
  credentials: NtfyCredentials,
  config: NtfyConfig,
  signal: AbortSignal,
): Promise<TestResult> {
  const base = baseUrl(config);
  let res: Response;
  try {
    res = await fetch(`${base}/v1/health`, { signal });
  } catch (error) {
    return { ok: false, error: `Couldn't reach ${base}: ${errorMessage(error)}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `${base} answered ${res.status} to /v1/health. Is it an ntfy server?`,
    };
  }
  const health = (await res.json().catch(() => null)) as { healthy?: boolean } | null;
  if (health?.healthy !== true) return { ok: false, error: `${base} says it isn't healthy.` };

  let token = "";
  if (credentials.accessToken?.trim()) {
    const account = await fetch(`${base}/v1/account`, {
      headers: authHeaders(credentials),
      signal,
    });
    if (account.status === 401 || account.status === 403) {
      return { ok: false, error: `${base} rejected the access token.` };
    }
    token = " and accepted the access token";
  }
  const topics = config.topics ?? [];
  const watching = topics.length
    ? `Watching ${topics.join(", ")}.`
    : "Not watching any topics yet.";
  return { ok: true, detail: `${new URL(base).host} is up${token}. ${watching}` };
}

export function createNtfyConnector(options: NtfySourceOptions = {}) {
  return defineConnector<NtfyCredentials, NtfyConfig>({
    id: CONNECTOR_ID,
    name: "ntfy",
    description:
      "Push notifications to your phone and desktop through ntfy.sh or your own ntfy server.",
    setupHelp:
      "Install the ntfy app on your phone, or open ntfy.sh in a browser, and subscribe to a topic. On ntfy.sh anyone who knows a topic's name can read and write it, so pick a long, random name. For reserved topics or your own server, create an access token under Account and paste it here.",
    credentialsSchema,
    secretFields: ["accessToken"],
    configSchema,
    async test({ credentials, config, signal }) {
      try {
        return await testServer(credentials, config, signal);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
    nodes: [publish, messageReceived],
    source: createNtfySource(options),
  });
}

export const connector = createNtfyConnector();

export default defineExtension({ connectors: [connector] });
