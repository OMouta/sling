/**
 * Sandboxes as Fly Machines. Each sandbox is one Machine running the sandbox
 * image with the spec's environment. It's created with auto_destroy and
 * restart policy "no", so it's removed as soon as its Runner exits, and its
 * metadata carries the Sling labels so `list` can find it again.
 */
import type { ExecutionProvider, ProviderContext, SandboxSpec } from "@sling/connector-sdk";
import { SANDBOX_LABELS } from "@sling/connector-sdk";
import { FlyApi, type MachineRequest } from "./api.ts";
import { type FlyConfig, type FlyCredentials, reachableFromFly } from "./schemas.ts";

export type ProviderCtx = ProviderContext<FlyCredentials, FlyConfig>;

/**
 * Fly metadata keys are plain words, so `sling.sandbox` is stored as
 * `sling_sandbox`. That keeps them usable in the list endpoint's
 * `metadata.<key>` filter.
 */
export function metadataKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

export const SANDBOX_KEY = metadataKey(SANDBOX_LABELS.sandbox);
export const WORKSPACE_KEY = metadataKey(SANDBOX_LABELS.workspace);
/** When the sandbox's lifetime ends, as an ISO time. `list` removes Machines past it. */
export const EXPIRES_KEY = "sling_expires_at";

/**
 * How long past its lifetime a Machine may run before `list` removes it.
 * The lifetime counts from create here, while the control plane may count
 * it from when the Runner connected, up to its 10-minute boot timeout later.
 * The control plane destroys the sandbox first; this catches Machines it
 * lost track of.
 */
export const EXPIRY_GRACE_MS = 10 * 60_000;

export const DEFAULT_CPUS = 2;
export const DEFAULT_MEMORY_MB = 4096;
const CPU_STEPS = [1, 2, 4, 8, 16];
const GONE = new Set(["destroying", "destroyed"]);

/** The smallest CPU count Fly offers that's at least the one asked for, and memory in 256 MB steps. */
export function guestFor(spec: Pick<SandboxSpec, "cpus" | "memoryMb">, config: FlyConfig) {
  const wantCpus = Math.ceil(spec.cpus ?? config.cpus ?? DEFAULT_CPUS);
  const max = config.cpuKind === "shared" ? 8 : 16;
  const cpus = CPU_STEPS.find((n) => n >= wantCpus && n <= max) ?? max;
  const memory = spec.memoryMb ?? config.memoryMb ?? DEFAULT_MEMORY_MB;
  return { cpu_kind: config.cpuKind, cpus, memory_mb: Math.ceil(memory / 256) * 256 };
}

/** `sling-<sandbox ID>`, in the letters Fly allows in a Machine name. */
export function machineName(sandboxId: string): string {
  return `sling-${sandboxId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 63);
}

function api(ctx: ProviderCtx): FlyApi {
  return new FlyApi({
    apiUrl: ctx.config.apiUrl,
    token: ctx.credentials.apiToken,
    app: ctx.config.app,
    signal: ctx.signal,
  });
}

export function machineRequest(spec: SandboxSpec, config: FlyConfig, now: number): MachineRequest {
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.labels)) metadata[metadataKey(k)] = v;
  metadata[SANDBOX_KEY] = spec.sandboxId;
  metadata[WORKSPACE_KEY] = spec.workspaceId;
  metadata[EXPIRES_KEY] = new Date(now + spec.lifetimeSeconds * 1000).toISOString();
  return {
    name: machineName(spec.sandboxId),
    ...(config.region ? { region: config.region } : {}),
    config: {
      image: spec.image || config.image,
      env: spec.env,
      guest: guestFor(spec, config),
      auto_destroy: true,
      restart: { policy: "no" },
      metadata,
    },
  };
}

export function createFlyProvider(
  options: { now?: () => number } = {},
): ExecutionProvider<FlyCredentials, FlyConfig> {
  const now = options.now ?? Date.now;
  return {
    async create(ctx, spec) {
      const url = spec.env.SLING_URL;
      if (!url || !reachableFromFly(url)) {
        throw new Error(
          `Fly sandboxes reach Sling over the internet, so SLING_URL must be an https:// URL${url ? `, not ${url}` : ""}. Set the provider's control plane URL to Sling's public address, or to its .internal or .flycast address if Sling runs on Fly.`,
        );
      }
      const machine = await api(ctx).createMachine(machineRequest(spec, ctx.config, now()));
      ctx.log.info("Created a Fly Machine", {
        sandboxId: spec.sandboxId,
        machineId: machine.id,
        region: machine.region,
      });
      return {
        externalId: machine.id,
        detail: `Machine ${machine.id} in ${ctx.config.app}${machine.region ? `, ${machine.region}` : ""}`,
      };
    },

    async destroy(ctx, externalId) {
      const result = await api(ctx).deleteMachine(externalId);
      if (result === "missing") ctx.log.info("The Fly Machine was already gone", { externalId });
    },

    async list(ctx) {
      const fly = api(ctx);
      const machines = await fly.listMachines({ [WORKSPACE_KEY]: ctx.workspaceId });
      const found: { externalId: string; sandboxId: string | null }[] = [];
      for (const m of machines) {
        const metadata = m.config?.metadata ?? {};
        // Filter here too, in case the API ignored the metadata filter.
        if (!(SANDBOX_KEY in metadata) || metadata[WORKSPACE_KEY] !== ctx.workspaceId) continue;
        if (GONE.has(m.state)) continue;
        const sandboxId = metadata[SANDBOX_KEY] || null;
        const expiresAt = Date.parse(metadata[EXPIRES_KEY] ?? "");
        if (Number.isFinite(expiresAt) && now() >= expiresAt + EXPIRY_GRACE_MS) {
          try {
            await fly.deleteMachine(m.id);
            ctx.log.warn("Removed a Fly Machine that outlived its lifetime", {
              sandboxId,
              machineId: m.id,
              expiredAt: new Date(expiresAt).toISOString(),
            });
            continue;
          } catch (error) {
            ctx.log.warn("Couldn't remove an expired Fly Machine", {
              sandboxId,
              machineId: m.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        found.push({ externalId: m.id, sandboxId });
      }
      return found;
    },
  };
}
