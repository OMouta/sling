import type { NodeLogger } from "@sling/connector-sdk";
import {
  type ExecutionProvider,
  type ProviderContext,
  SANDBOX_LABELS,
  type SandboxSpec,
} from "@sling/connector-sdk";
import {
  type ContainerSpec,
  type DockerApi,
  DockerError,
  parseImageRef,
  type RegistryAuth,
  registryServerAddress,
} from "./engine.ts";
import { DEFAULT_IMAGE, type DockerConfig, type DockerCredentials } from "./schemas.ts";

/** When the container's lifetime ends, as an ISO timestamp. `list` removes containers past it. */
export const EXPIRES_LABEL = "sling.expires-at";

/** How long a stopping Runner gets to clean up before Docker kills it. */
export const STOP_TIMEOUT_SECONDS = 5;

/**
 * How long past its lifetime a container may run before `list` removes it.
 * The deadline counts from create, while the control plane may count the
 * lifetime from when the Runner connected, up to its 10-minute boot timeout
 * later. The control plane's sweep destroys the sandbox first and marks the
 * task interrupted; this only catches containers it lost track of.
 */
export const EXPIRY_GRACE_MS = 10 * 60_000;

/** Enough for parallel builds, low enough that a fork bomb doesn't take the host down. */
export const PIDS_LIMIT = 4096;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ProviderCtx = ProviderContext<DockerCredentials, DockerConfig>;

export interface DockerProviderOptions {
  /** Builds the Engine API client. Tests pass a fake. */
  client: (credentials: DockerCredentials) => DockerApi;
  /** Replaces the image's command. The integration tests use it to run a stock image. */
  command?: string[];
  now?: () => number;
}

export function containerName(sandboxId: string): string {
  return `sling-${sandboxId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

/** Registry login for pulls, when both halves are set. */
export function registryAuth(credentials: DockerCredentials, image: string): RegistryAuth | null {
  const username = credentials.registryUsername?.trim();
  const password = credentials.registryPassword;
  if (!username || !password) return null;
  return {
    username,
    password,
    serveraddress: registryServerAddress(parseImageRef(image).registry),
  };
}

function buildHint(image: string): string {
  return image === DEFAULT_IMAGE
    ? " Build it on the Docker host: docker build -f deploy/sandbox/Dockerfile -t sling-sandbox:latest ."
    : "";
}

/** The container create body. Pure, so tests can check every setting. */
export function buildContainerSpec(args: {
  spec: SandboxSpec;
  config: DockerConfig;
  image: string;
  expiresAt: Date;
  command?: string[];
}): ContainerSpec {
  const { spec, config } = args;
  // The boot contract wins over extra variables.
  const env = { ...config.extraEnv, ...spec.env };
  for (const name of Object.keys(env)) {
    if (!ENV_NAME.test(name))
      throw new DockerError(`"${name}" isn't a valid environment variable name.`);
  }
  const cpus = spec.cpus ?? config.cpus;
  const memoryMb = spec.memoryMb ?? config.memoryMb;
  const memoryBytes = memoryMb ? Math.round(memoryMb * 1024 * 1024) : undefined;
  return {
    Image: args.image,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Labels: {
      ...spec.labels,
      [SANDBOX_LABELS.sandbox]: spec.sandboxId,
      [SANDBOX_LABELS.workspace]: spec.workspaceId,
      [EXPIRES_LABEL]: args.expiresAt.toISOString(),
    },
    ...(args.command ? { Cmd: args.command } : {}),
    Tty: false,
    OpenStdin: false,
    AttachStdin: false,
    StopTimeout: STOP_TIMEOUT_SECONDS,
    HostConfig: {
      NetworkMode: config.network,
      ...(cpus ? { NanoCpus: Math.round(cpus * 1e9) } : {}),
      // Swap equal to memory means no swap, so the limit is real.
      ...(memoryBytes ? { Memory: memoryBytes, MemorySwap: memoryBytes } : {}),
      PidsLimit: PIDS_LIMIT,
      // An init process as PID 1 reaps the processes agents leave behind.
      Init: true,
      // git, Node, and the coding agents need no capabilities as a normal user.
      CapDrop: ["ALL"],
      CapAdd: [],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      PublishAllPorts: false,
      PortBindings: {},
      // Sling destroys the container itself, after the task's actions finish.
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
      // Lets controlPlaneUrl point at a Sling running on the Docker host, on Linux too.
      ExtraHosts: ["host.docker.internal:host-gateway"],
    },
  };
}

async function ensureImage(
  api: DockerApi,
  image: string,
  ctx: ProviderCtx,
): Promise<"present" | "pulled"> {
  const { config, credentials, signal, log } = ctx;
  if (config.pullPolicy !== "always" && (await api.imageExists(image, signal))) return "present";
  if (config.pullPolicy === "never") {
    throw new DockerError(
      `The image ${image} isn't on the Docker host, and the pull policy is never.${buildHint(image)}`,
    );
  }
  log.info("Pulling the sandbox image", { image });
  try {
    await api.pullImage(image, registryAuth(credentials, image), signal);
  } catch (error) {
    if (error instanceof DockerError && !error.unreachable) {
      throw new DockerError(`${error.message}.${buildHint(image)}`, {
        status: error.status ?? undefined,
        cause: error,
      });
    }
    throw error;
  }
  return "pulled";
}

/** Stop with a short timeout, then force-remove. A missing container counts as removed. */
export async function removeSandboxContainer(
  api: DockerApi,
  id: string,
  log: NodeLogger,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await api.stopContainer(id, STOP_TIMEOUT_SECONDS, signal);
  } catch (error) {
    // If the daemon is unreachable, removing won't work either.
    if (!(error instanceof DockerError) || error.unreachable) throw error;
    log.warn("Couldn't stop the sandbox container, removing it anyway", {
      containerId: id,
      error: error.message,
    });
  }
  await api.removeContainer(id, signal);
}

export function createDockerProvider(
  options: DockerProviderOptions,
): ExecutionProvider<DockerCredentials, DockerConfig> {
  const now = options.now ?? Date.now;

  return {
    async create(ctx, spec) {
      const api = options.client(ctx.credentials);
      const image = spec.image || ctx.config.image;
      const name = containerName(spec.sandboxId);
      const pulled = await ensureImage(api, image, ctx);
      const body = buildContainerSpec({
        spec,
        config: ctx.config,
        image,
        expiresAt: new Date(now() + spec.lifetimeSeconds * 1000),
        command: options.command,
      });

      let id: string;
      try {
        id = await api.createContainer(name, body, ctx.signal);
      } catch (error) {
        if (!(error instanceof DockerError && error.status === 409)) throw error;
        // The name is taken. If it's an earlier attempt at this sandbox, replace it.
        const existing = await api.inspectContainer(name, ctx.signal);
        if (existing && existing.Config.Labels?.[SANDBOX_LABELS.sandbox] !== spec.sandboxId) {
          throw new DockerError(
            `A container called ${name} already exists on the Docker host and isn't this sandbox's.`,
            { status: 409 },
          );
        }
        ctx.log.warn("Replacing a container left from an earlier attempt", { name });
        await api.removeContainer(name, ctx.signal);
        id = await api.createContainer(name, body, ctx.signal);
      }

      try {
        await api.startContainer(id, ctx.signal);
      } catch (error) {
        await api.removeContainer(id).catch(() => {});
        throw error;
      }
      ctx.log.info("Started the sandbox container", {
        sandboxId: spec.sandboxId,
        containerId: id.slice(0, 12),
        image,
        pulled: pulled === "pulled",
      });
      return { externalId: id, detail: `Container ${name} on ${api.endpoint}` };
    },

    async destroy(ctx, externalId) {
      const api = options.client(ctx.credentials);
      await removeSandboxContainer(api, externalId, ctx.log, ctx.signal);
    },

    async list(ctx) {
      const api = options.client(ctx.credentials);
      const containers = await api.listContainers(
        [SANDBOX_LABELS.sandbox, `${SANDBOX_LABELS.workspace}=${ctx.workspaceId}`],
        ctx.signal,
      );
      const found: { externalId: string; sandboxId: string | null }[] = [];
      for (const c of containers) {
        const sandboxId = c.Labels?.[SANDBOX_LABELS.sandbox] || null;
        const expiresAt = Date.parse(c.Labels?.[EXPIRES_LABEL] ?? "");
        if (Number.isFinite(expiresAt) && now() >= expiresAt + EXPIRY_GRACE_MS) {
          try {
            await removeSandboxContainer(api, c.Id, ctx.log, ctx.signal);
            ctx.log.warn("Removed a sandbox container that outlived its lifetime", {
              sandboxId,
              containerId: c.Id.slice(0, 12),
              expiredAt: new Date(expiresAt).toISOString(),
            });
            continue;
          } catch (error) {
            ctx.log.warn("Couldn't remove an expired sandbox container", {
              sandboxId,
              containerId: c.Id.slice(0, 12),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        found.push({ externalId: c.Id, sandboxId });
      }
      return found;
    },
  };
}
