/**
 * Helpers for tests that run extensions in real restricted processes: build
 * and describe a fixture extension, fake node and source contexts, and a
 * runtime with fast timings.
 */
import type {
  ApprovalDecision,
  ExtensionPermissions,
  ExtensionPermissionsSchema,
  SourceContext,
  SourceStatus,
} from "@sling/connector-sdk";
import { ExtensionManifestSchema } from "@sling/connector-sdk";
import type { ExtensionStatus } from "@sling/core";
import { type Installation, type NodeContext, NodeError } from "@sling/workflow";
import type { z } from "zod";
import {
  ProcessRuntime,
  type ProcessRuntimeOptions,
} from "../../src/extensions/process-runtime.ts";
import type { ActiveExtension } from "../../src/extensions/runtime.ts";
import { buildExtension, type FixtureOptions, unpackFixture } from "./extensions.ts";

/** Imports every extension fixture needs. */
export const SDK = `import { defineConnector, defineExtension, defineNode, NodeError } from "@sling/connector-sdk";
import { z } from "zod";
`;

export interface TestRuntime {
  runtime: ProcessRuntime;
  statuses: { id: string; status: ExtensionStatus; detail: string | null }[];
  crashes: { id: string; reason: string }[];
  serverLog: { level: string; msg: string; obj: Record<string, unknown> }[];
}

export function testRuntime(opts: ProcessRuntimeOptions = {}): TestRuntime {
  const serverLog: TestRuntime["serverLog"] = [];
  const statuses: TestRuntime["statuses"] = [];
  const crashes: TestRuntime["crashes"] = [];
  const log = (level: string) => (obj: Record<string, unknown>, msg: string) =>
    serverLog.push({ level, msg, obj });
  const runtime = new ProcessRuntime({
    log: { info: log("info"), warn: log("warn"), error: log("error") },
    ...opts,
  });
  runtime.setEvents({
    onStatus: (id, status, detail) => statuses.push({ id, status, detail }),
    onCrash: (id, reason) => crashes.push({ id, reason }),
  });
  return { runtime, statuses, crashes, serverLog };
}

export interface FixtureExtension extends ActiveExtension {
  configHostSet: Set<string>;
}

/**
 * Builds and unpacks a package, describes it in a real process, and returns
 * it ready to activate. `granted` defaults to what the manifest asks for.
 */
export async function fixtureExtension(
  runtime: ProcessRuntime,
  opts: FixtureOptions & { granted?: z.input<typeof ExtensionPermissionsSchema> },
): Promise<FixtureExtension> {
  const built = await buildExtension(opts);
  const dir = await unpackFixture(built);
  const manifest = ExtensionManifestSchema.parse(built.pkg.manifest);
  const description = await runtime.describe({
    id: manifest.id,
    version: manifest.version,
    digest: built.digest,
    dir,
    manifest,
  });
  const configHostSet = new Set<string>();
  const granted: ExtensionPermissions = opts.granted
    ? ExtensionManifestSchema.parse({ ...built.pkg.manifest, permissions: opts.granted })
        .permissions
    : manifest.permissions;
  return {
    id: manifest.id,
    version: manifest.version,
    digest: built.digest,
    dir,
    manifest,
    description,
    granted,
    configHostSet,
    configHosts: () => configHostSet,
  };
}

export interface FakeNode {
  ctx: NodeContext;
  lines: { level: string; message: string; data?: Record<string, unknown> }[];
  secrets: Set<string>;
  abort: AbortController;
}

/** A node context like the engine's: installations are looked up in `installations`. */
export function fakeNodeContext(installations: Record<string, Installation> = {}): FakeNode {
  const lines: FakeNode["lines"] = [];
  const secrets = new Set<string>();
  const abort = new AbortController();
  const push = (level: string) => (message: string, data?: Record<string, unknown>) =>
    lines.push({ level, message, ...(data ? { data } : {}) });
  const ctx: NodeContext = {
    runId: "run_1",
    nodeId: "n1",
    nodeRunId: "nrn_1",
    workflowId: "wf_1",
    workspaceId: "ws_1",
    ownerId: "usr_1",
    iteration: 0,
    attempt: 1,
    idempotencyKey: "run_1:n1:0",
    signal: abort.signal,
    log: { info: push("info"), warn: push("warn"), error: push("error") },
    installation: async <C, Cfg>(id: string) => {
      const inst = installations[id];
      if (!inst) {
        throw new NodeError(`No installation ${id} in this workspace`, { code: "no_installation" });
      }
      for (const v of Object.values(inst.credentials)) if (typeof v === "string") secrets.add(v);
      return inst as unknown as Installation<C, Cfg>;
    },
    services: undefined,
  };
  return { ctx, lines, secrets, abort };
}

export interface FakeSource {
  ctx: SourceContext<unknown, unknown>;
  emitted: { type: string; payload: unknown; dedupeKey?: string }[];
  statuses: { status: SourceStatus; detail?: string }[];
  decided: ApprovalDecision[];
  state: Map<string, string>;
  lines: { level: string; message: string }[];
  abort: AbortController;
}

export function fakeSourceContext(
  credentials: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
): FakeSource {
  const emitted: FakeSource["emitted"] = [];
  const statuses: FakeSource["statuses"] = [];
  const decided: ApprovalDecision[] = [];
  const state = new Map<string, string>();
  const lines: FakeSource["lines"] = [];
  const abort = new AbortController();
  const push = (level: string) => (message: string) => lines.push({ level, message });
  const ctx: SourceContext<unknown, unknown> = {
    installationId: "ins_1",
    workspaceId: "ws_1",
    credentials,
    config,
    log: { info: push("info"), warn: push("warn"), error: push("error") },
    signal: abort.signal,
    emit: async (event) => {
      emitted.push(event);
    },
    state: {
      get: async (key) => state.get(key) ?? null,
      set: async (key, value) => {
        state.set(key, value);
      },
    },
    approvals: {
      decide: async (decision) => {
        decided.push(decision);
        return { ok: true, message: "Approved." };
      },
      reportRefused: async () => {},
    },
    setStatus: (status, detail) => statuses.push({ status, ...(detail ? { detail } : {}) }),
  };
  return { ctx, emitted, statuses, decided, state, lines, abort };
}

export async function waitFor(fn: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Whether a process is still running. */
export function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
