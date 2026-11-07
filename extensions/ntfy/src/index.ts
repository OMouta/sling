/**
 * The ntfy extension: publish push notifications, and start workflows from
 * messages on the topics an installation watches. It uses only the global
 * fetch and WebSocket, which Sling routes through its network rules.
 */
import {
  defineConnector,
  defineExtension,
  type SetupResult,
  type TestResult,
} from "@sling/connector-sdk";
import { authHeaders, baseUrl, errorMessage } from "./client.ts";
import { publish } from "./publish.ts";
import {
  CONNECTOR_ID,
  configSchema,
  credentialsSchema,
  DEFAULT_SERVER,
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

/** A topic name nobody will guess: on ntfy.sh, knowing the name is all it takes to read it. */
export function randomTopic(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `sling-${Array.from(bytes, (b) => letters[b % letters.length]).join("")}`;
}

/** Suggests a topic, then links to it so the phone can subscribe. */
export function ntfySetup(config: Partial<NtfyConfig>): SetupResult<NtfyCredentials, NtfyConfig> {
  const base = (config.server?.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
  let host = "ntfy";
  try {
    host = base === DEFAULT_SERVER ? "ntfy" : new URL(base).host;
  } catch {
    // Not a URL yet: the form says so on Add.
  }
  const topic = config.defaultTopic?.trim();
  if (!topic) return { name: host, config: { defaultTopic: randomTopic() } };
  return {
    name: host,
    notes: [
      {
        field: "defaultTopic",
        tone: "info",
        text: "Subscribe to it in the ntfy app on your phone.",
        link: { label: "Open it", url: `${base}/${encodeURIComponent(topic)}` },
      },
    ],
  };
}

export function createNtfyConnector(options: NtfySourceOptions = {}) {
  return defineConnector<NtfyCredentials, NtfyConfig>({
    id: CONNECTOR_ID,
    name: "ntfy",
    description: "Push notifications to your phone through ntfy.",
    setupHelp:
      "Subscribe to the topic in the ntfy app on your phone. On ntfy.sh anyone who knows a topic's name can read it, so keep it long and random.",
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
    async setup({ config }) {
      return ntfySetup(config);
    },
    nodes: [publish, messageReceived],
    source: createNtfySource(options),
  });
}

export const connector = createNtfyConnector();

export default defineExtension({ connectors: [connector] });
