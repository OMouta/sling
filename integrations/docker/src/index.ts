import { type ConnectorDefinition, defineConnector, type TestResult } from "@sling/connector-sdk";
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
    description:
      "Runs coding tasks in fresh containers on a Docker host you control, when no machine can take them or you ask for a sandbox.",
    setupHelp:
      "For the Docker on Sling's own host, keep the default socket, unix:///var/run/docker.sock. If Sling runs in compose, start it with deploy/docker-compose.sandbox.yml, which mounts the socket, and set the network to sling-sandboxes and the control plane URL to http://sling:8080. Mounting the socket gives Sling root on that host; a remote host over TLS avoids that. For a remote host, use tcp://host:2376 and paste ca.pem, cert.pem, and key.pem. Build the sandbox image on the host first: docker build -f deploy/sandbox/Dockerfile -t sling-sandbox:latest .",
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

    nodes: [],
    executionProvider: createDockerProvider({
      client,
      command: options.command,
      now: options.now,
    }),
  });
}

export const connector = createDockerConnector();
