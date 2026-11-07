import {
  type ConnectorDefinition,
  defineConnector,
  type SetupNote,
  type SetupResult,
  type TestResult,
} from "@sling/connector-sdk";
import { createEngineClient, type DockerApi } from "./engine.ts";
import { createDockerProvider } from "./provider.ts";
import {
  CONNECTOR_ID,
  configSchema,
  credentialsSchema,
  DEFAULT_IMAGE,
  type DockerConfig,
  type DockerCredentials,
} from "./schemas.ts";

export type {
  ContainerInfo,
  ContainerSpec,
  ContainerSummary,
  DockerApi,
  DockerVersion,
  RegistryAuth,
} from "./engine.ts";
export { createEngineClient, DockerError } from "./engine.ts";
export {
  buildContainerSpec,
  containerName,
  EXPIRES_LABEL,
  EXPIRY_GRACE_MS,
  STOP_TIMEOUT_SECONDS,
} from "./provider.ts";
export type { DockerConfig, DockerCredentials } from "./schemas.ts";
export { DEFAULT_HOST, DEFAULT_IMAGE } from "./schemas.ts";

export const PLAINTEXT_WARNING =
  "This connection isn't encrypted, so anyone on the network path can read sandbox secrets and control the Docker host. Use TLS unless the network is private to you.";

/** What the setup form says about the host as soon as it opens: is Docker there, and is the image. */
async function dockerSetup(
  client: (credentials: DockerCredentials) => DockerApi,
  typed: Partial<DockerCredentials>,
  config: Partial<DockerConfig>,
  signal: AbortSignal,
): Promise<SetupResult<DockerCredentials, DockerConfig>> {
  const parsed = credentialsSchema.safeParse(typed);
  if (!parsed.success) return {};
  const credentials = parsed.data;
  const image = config.image?.trim() || DEFAULT_IMAGE;
  let api: DockerApi;
  let version: Awaited<ReturnType<DockerApi["version"]>>;
  try {
    api = client(credentials);
    await api.ping(signal);
    version = await api.version(signal);
  } catch (error) {
    return { notes: [{ field: "host", tone: "error", text: errorMessage(error) }] };
  }
  const notes: SetupNote[] = [
    { field: "host", tone: "ok", text: `Docker ${version.Version} at ${api.endpoint}` },
  ];
  if (api.plaintextTcp) notes.push({ field: "host", tone: "warn", text: PLAINTEXT_WARNING });
  try {
    if (!(await api.imageExists(image, signal))) {
      notes.push({
        tone: image === DEFAULT_IMAGE ? "warn" : "info",
        text:
          image === DEFAULT_IMAGE
            ? `${image} isn't on this host yet. Build it there: docker build -f deploy/sandbox/Dockerfile -t ${image} .`
            : `${image} isn't on this host yet. It's pulled the first time a sandbox starts.`,
      });
    }
  } catch {
    // The connection check on Add says it again, with the reason.
  }
  return { name: api.endpoint === "unix:///var/run/docker.sock" ? "Docker" : api.endpoint, notes };
}

export interface DockerConnectorOptions {
  /** Builds the Engine API client. Tests pass a fake. */
  client?: (credentials: DockerCredentials) => DockerApi;
  /** Replaces the image's command. The integration tests use it to run a stock image. */
  command?: string[];
  now?: () => number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function testConnection(
  client: (credentials: DockerCredentials) => DockerApi,
  credentials: DockerCredentials,
  config: DockerConfig,
  signal: AbortSignal,
): Promise<TestResult> {
  if (Boolean(credentials.registryUsername?.trim()) !== Boolean(credentials.registryPassword)) {
    return { ok: false, error: "Give both the registry username and password, or neither." };
  }
  const api = client(credentials);
  await api.ping(signal);
  const version = await api.version(signal);
  const notes = [
    `Docker ${version.Version} (API ${version.ApiVersion}, ${version.Os}/${version.Arch}) at ${api.endpoint}.`,
  ];
  if (!(await api.networkExists(config.network, signal))) {
    return {
      ok: false,
      error: `There's no Docker network called "${config.network}" on that host. Compose prefixes network names with the project, unless the network sets name:. docker network ls lists them.`,
    };
  }
  const present = await api.imageExists(config.image, signal);
  if (present) {
    notes.push(`${config.image} is on the host.`);
  } else if (config.pullPolicy === "never") {
    return {
      ok: false,
      error: `${config.image} isn't on the Docker host, and the pull policy is never, so sandboxes can't start.`,
    };
  } else if (config.image === DEFAULT_IMAGE) {
    notes.push(
      `${config.image} isn't on the host yet, and it isn't on a public registry. Build it there with docker build -f deploy/sandbox/Dockerfile -t sling-sandbox:latest . from a Sling checkout.`,
    );
  } else {
    notes.push(`${config.image} isn't on the host yet. It will be pulled on first use.`);
  }
  if (api.plaintextTcp) notes.push(PLAINTEXT_WARNING);
  return { ok: true, detail: notes.join(" ") };
}

export function createDockerConnector(
  options: DockerConnectorOptions = {},
): ConnectorDefinition<DockerCredentials, DockerConfig> {
  const client = options.client ?? createEngineClient;
  return defineConnector<DockerCredentials, DockerConfig>({
    id: CONNECTOR_ID,
    name: "Docker",
    description: "Run coding tasks in fresh containers on a Docker host.",
    setupHelp:
      "Keep the default socket for the Docker on Sling's own host. For a remote host, use tcp://host:2376 with its ca.pem, cert.pem, and key.pem. Build the image there first: docker build -f deploy/sandbox/Dockerfile -t sling-sandbox:latest .",
    credentialsSchema,
    secretFields: ["tlsKey", "registryUsername", "registryPassword"],
    configSchema,

    async test({ credentials, config, signal }): Promise<TestResult> {
      try {
        return await testConnection(client, credentials, config, signal);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    async setup({ credentials, config, signal }) {
      return dockerSetup(client, credentials, config, signal);
    },

    nodes: [],
    executionProvider: createDockerProvider({
      client,
      command: options.command,
      now: options.now,
    }),
  });
}

export const connector = createDockerConnector();
