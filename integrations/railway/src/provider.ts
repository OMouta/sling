import type { ExecutionProvider, ProviderContext, SandboxSpec } from "@sling/connector-sdk";
import { SANDBOX_ENV } from "@sling/core";
import type { NodeLogger } from "@sling/workflow";
import { SandboxFailedError, SandboxFilesError, SandboxTimeoutError } from "railway";
import type { RailwayApi, RailwayClientFactory, RailwaySandbox } from "./api.ts";
import {
  describeRailwayError,
  describeScriptFailure,
  isNotFound,
  RailwayProviderError,
} from "./errors.ts";
import {
  keepaliveScript,
  launchScript,
  MARKER_PATH,
  REGISTRY_PASSWORD_ENV,
  REGISTRY_USER_ENV,
  sandboxLabels,
} from "./launch.ts";
import type { RailwayConfig, RailwayCredentials } from "./schemas.ts";

/** Long enough to pull a large image into a fresh sandbox. */
export const LAUNCH_TIMEOUT_SECONDS = 600;

/**
 * Extra time the container gets past its lifetime before the sandbox removes
 * it on its own. The lifetime counts from create, while the control plane may
 * count it from when the Runner connected, up to its 10-minute boot timeout
 * later. The control plane destroys the sandbox first and marks the task
 * interrupted; this only matters when the control plane can't.
 */
export const LIFETIME_GRACE_SECONDS = 600;

/** A sandbox younger than this with no marker may still be starting, so it isn't written off yet. */
export const PROBE_SETTLE_MS = 120_000;

/** Railway's list call returns one page. Sling's concurrency limit keeps it far below this. */
export const LIST_PAGE = 100;

const GONE = new Set(["DESTROYING", "DESTROYED"]);

interface Marker {
  kind: "sling.sandbox";
  sandboxId: string;
  workspaceId: string;
}

type Owner = Pick<Marker, "sandboxId" | "workspaceId"> | "foreign";

export type ProviderCtx = ProviderContext<RailwayCredentials, RailwayConfig>;

export interface RailwayProviderOptions {
  client: RailwayClientFactory;
  /** Replaces the image's command. Tests use it to run a stock image. */
  command?: string[];
  now?: () => number;
}

export function parseMarker(text: string): Owner | null {
  try {
    const m = JSON.parse(text) as Partial<Marker>;
    if (
      m.kind === "sling.sandbox" &&
      typeof m.sandboxId === "string" &&
      typeof m.workspaceId === "string"
    ) {
      return { sandboxId: m.sandboxId, workspaceId: m.workspaceId };
    }
  } catch {
    // Not ours.
  }
  return null;
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function withRegistryLogin(credentials: RailwayCredentials): boolean {
  return Boolean(credentials.registryUsername?.trim() && credentials.registryPassword);
}

/** Exec env for the registry login. Never copied into the container. */
export function registryEnv(credentials: RailwayCredentials): Record<string, string> {
  if (!withRegistryLogin(credentials)) return {};
  return {
    [REGISTRY_USER_ENV]: credentials.registryUsername?.trim() ?? "",
    [REGISTRY_PASSWORD_ENV]: credentials.registryPassword ?? "",
  };
}

/** Railway sizes memory in decimal GB. 1024 MB maps to 1 GB, so round numbers stay round. */
export function resourcesFor(spec: SandboxSpec, config: RailwayConfig) {
  const cpu = spec.cpus ?? config.cpus;
  const memoryMb = spec.memoryMb ?? config.memoryMb;
  if (!cpu && !memoryMb) return undefined;
  return {
    ...(cpu ? { cpu } : {}),
    ...(memoryMb ? { memoryGB: Math.round((memoryMb / 1024) * 1000) / 1000 } : {}),
  };
}

async function destroyQuietly(api: RailwayApi, id: string, log: NodeLogger) {
  try {
    const sandbox = await api.connect(id);
    if (sandbox && !GONE.has(sandbox.status)) await sandbox.destroy();
  } catch (error) {
    log.warn("Couldn't destroy a Railway sandbox that failed to start", {
      externalId: id,
      error: describeRailwayError(error),
    });
  }
}

function asProviderError(error: unknown, environmentId: string): RailwayProviderError {
  if (error instanceof RailwayProviderError) return error;
  return new RailwayProviderError(describeRailwayError(error, environmentId), { cause: error });
}

export function createRailwayProvider(
  options: RailwayProviderOptions,
): ExecutionProvider<RailwayCredentials, RailwayConfig> {
  const now = options.now ?? Date.now;
  /**
   * What each sandbox is, keyed by environment and sandbox ID, so a sweep
   * reads each marker once rather than every minute. Sandboxes this process
   * created are known without reading anything.
   */
  const owners = new Map<string, Owner>();
  const key = (environmentId: string, id: string) => `${environmentId}/${id}`;

  async function probe(api: RailwayApi, id: string, log: NodeLogger): Promise<Owner | undefined> {
    try {
      const sandbox = await api.connect(id);
      if (!sandbox) return undefined;
      const text = await sandbox.readFile(MARKER_PATH);
      return text === null ? "foreign" : (parseMarker(text) ?? "foreign");
    } catch (error) {
      // An unreadable marker isn't one Sling wrote: it writes them world-readable.
      if (error instanceof SandboxFilesError) return "foreign";
      log.warn("Couldn't check whether a Railway sandbox is Sling's", {
        externalId: id,
        error: describeRailwayError(error),
      });
      return undefined;
    }
  }

  return {
    async create(ctx, spec) {
      const { credentials, config, log, signal } = ctx;
      const environmentId = credentials.environmentId;
      const url = spec.env[SANDBOX_ENV.url];
      if (!url || !isHttps(url)) {
        throw new RailwayProviderError(
          `Railway sandboxes reach Sling over the internet, so ${SANDBOX_ENV.url} must be an https:// URL${url ? `, not ${url}` : ""}. Set the provider's control plane URL to Sling's public address.`,
        );
      }
      const image = spec.image || config.image;
      const script = launchScript({
        sandboxId: spec.sandboxId,
        image,
        envNames: Object.keys(spec.env),
        labels: sandboxLabels(
          spec.sandboxId,
          spec.workspaceId,
          spec.labels,
          new Date(now() + spec.lifetimeSeconds * 1000),
        ),
        withLogin: withRegistryLogin(credentials),
        command: options.command,
      });
      const execEnv = { ...spec.env, ...registryEnv(credentials) };
      signal.throwIfAborted();

      const api = options.client(credentials);
      let sandbox: RailwaySandbox;
      try {
        const resources = resourcesFor(spec, config);
        sandbox = await api.create({
          idleTimeoutMinutes: config.idleTimeoutMinutes,
          ...(resources ? { resources } : {}),
        });
      } catch (error) {
        // These leave a sandbox behind that would bill until its idle timeout.
        if (error instanceof SandboxFailedError || error instanceof SandboxTimeoutError) {
          await destroyQuietly(api, error.id, log);
        }
        throw asProviderError(error, environmentId);
      }

      const k = key(environmentId, sandbox.id);
      owners.set(k, { sandboxId: spec.sandboxId, workspaceId: spec.workspaceId });
      try {
        signal.throwIfAborted();
        const marker: Marker = {
          kind: "sling.sandbox",
          sandboxId: spec.sandboxId,
          workspaceId: spec.workspaceId,
        };
        await sandbox.writeFile(MARKER_PATH, `${JSON.stringify(marker)}\n`, 0o644);
        const launched = await sandbox.exec(script, {
          env: execEnv,
          timeoutSec: LAUNCH_TIMEOUT_SECONDS,
          signal,
        });
        if (launched.exitCode !== 0 || launched.timedOut) {
          throw new RailwayProviderError(
            describeScriptFailure("Starting the sandbox image", launched),
          );
        }
        await sandbox.execDetached(
          keepaliveScript(spec.sandboxId, spec.lifetimeSeconds + LIFETIME_GRACE_SECONDS),
          { signal },
        );
      } catch (error) {
        owners.delete(k);
        await sandbox.destroy().catch((e: unknown) =>
          log.warn("Couldn't destroy a Railway sandbox that failed to start", {
            externalId: sandbox.id,
            error: describeRailwayError(e),
          }),
        );
        if (signal.aborted) throw signal.reason;
        throw asProviderError(error, environmentId);
      }

      log.info("Started the sandbox image in a Railway sandbox", {
        sandboxId: spec.sandboxId,
        externalId: sandbox.id,
        region: sandbox.region,
        image,
      });
      return {
        externalId: sandbox.id,
        detail: `Railway sandbox ${sandbox.id} in ${sandbox.region}`,
      };
    },

    async destroy(ctx, externalId) {
      const { credentials } = ctx;
      const api = options.client(credentials);
      owners.delete(key(credentials.environmentId, externalId));
      let sandbox: RailwaySandbox | null;
      try {
        sandbox = await api.connect(externalId);
      } catch (error) {
        if (isNotFound(error)) return;
        throw asProviderError(error, credentials.environmentId);
      }
      if (!sandbox || GONE.has(sandbox.status)) return;
      try {
        await sandbox.destroy();
      } catch (error) {
        if (isNotFound(error)) return;
        // It may have gone away on its own in the meantime, for example by idling out.
        const again = await api.connect(externalId).catch(() => undefined);
        if (again === null || (again && GONE.has(again.status))) return;
        throw asProviderError(error, credentials.environmentId);
      }
    },

    async list(ctx) {
      const { credentials, workspaceId, log } = ctx;
      const environmentId = credentials.environmentId;
      const api = options.client(credentials);
      let sandboxes: Awaited<ReturnType<RailwayApi["list"]>>;
      try {
        sandboxes = await api.list(LIST_PAGE);
      } catch (error) {
        throw asProviderError(error, environmentId);
      }
      const seen = new Set<string>();
      const found: { externalId: string; sandboxId: string | null }[] = [];
      for (const s of sandboxes) {
        if (GONE.has(s.status)) continue;
        const k = key(environmentId, s.id);
        seen.add(k);
        let owner = owners.get(k);
        if (owner === undefined) {
          // Files can only be read from a running sandbox.
          if (s.status !== "RUNNING") continue;
          owner = await probe(api, s.id, log);
          if (owner === undefined) continue;
          if (owner === "foreign" && now() - Date.parse(s.createdAt) < PROBE_SETTLE_MS) continue;
          owners.set(k, owner);
        }
        if (owner === "foreign" || owner.workspaceId !== workspaceId) continue;
        found.push({ externalId: s.id, sandboxId: owner.sandboxId });
      }
      // Forget sandboxes that are gone, but only when the page held all of them.
      if (sandboxes.length < LIST_PAGE) {
        for (const k of owners.keys()) {
          if (k.startsWith(`${environmentId}/`) && !seen.has(k)) owners.delete(k);
        }
      }
      return found;
    },
  };
}
