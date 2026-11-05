/**
 * Execution providers for tests.
 *
 * - `test-fake` boots a sandbox in this process: a FakeRunner pairs with the
 *   spec's one-time code and connects like a real sandbox Runner would.
 * - `test-process` starts the real `sling-runner sandbox` as a local child
 *   process with the spec's environment, the way a container would run it.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { type AnyConnector, defineConnector, type SandboxSpec } from "@sling/connector-sdk";
import { SANDBOX_ENV } from "@sling/core";
import { z } from "zod";
import { FakeRunner } from "./fake-runner.ts";

const baseConfig = {
  image: z.string().optional(),
  controlPlaneUrl: z.string().optional(),
  cpus: z.number().optional(),
  memoryMb: z.number().optional(),
};

export interface FakeSandbox {
  sandboxId: string;
  spec: SandboxSpec;
  runner: FakeRunner | null;
  /** Set when the boot failed, for example a refused pairing code. */
  bootError: string | null;
}

export interface FakeProviderState {
  /** Every spec `create` was given, in order. */
  specs: SandboxSpec[];
  live: Map<string, FakeSandbox>;
  /** External IDs `destroy` was called with, in order. */
  destroyed: string[];
  /** Extra things `list` reports, as if the provider still ran them. */
  strays: Map<string, string | null>;
}

/**
 * Config `behavior`: `boot` pairs and connects, `no-boot` never does (for boot
 * timeouts), `fail-create` makes `create` throw an error that quotes the
 * installation's token (for scrubbing).
 */
export function createFakeProvider(): { connector: AnyConnector; state: FakeProviderState } {
  const state: FakeProviderState = {
    specs: [],
    live: new Map(),
    destroyed: [],
    strays: new Map(),
  };
  const connector = defineConnector({
    id: "test-fake",
    name: "Fake",
    description: "Sandboxes that run in the test process.",
    credentialsSchema: z.object({ token: z.string().default("") }),
    secretFields: ["token"],
    configSchema: z.object({
      ...baseConfig,
      behavior: z.enum(["boot", "no-boot", "fail-create"]).default("boot"),
    }),
    test: async () => ({ ok: true }),
    nodes: [],
    executionProvider: {
      async create(ctx, spec) {
        state.specs.push(spec);
        if (ctx.config.behavior === "fail-create") {
          throw new Error(`the fake host refused token ${ctx.credentials.token}`);
        }
        const externalId = `fake-${spec.sandboxId}`;
        const sandbox: FakeSandbox = {
          sandboxId: spec.sandboxId,
          spec,
          runner: null,
          bootError: null,
        };
        state.live.set(externalId, sandbox);
        if (ctx.config.behavior === "boot") void boot(sandbox);
        return { externalId, detail: "fake" };
      },
      async destroy(_ctx, externalId) {
        state.live.get(externalId)?.runner?.close();
        state.live.delete(externalId);
        state.strays.delete(externalId);
        state.destroyed.push(externalId);
      },
      async list() {
        return [
          ...[...state.live.entries()].map(([externalId, s]) => ({
            externalId,
            sandboxId: s.sandboxId,
          })),
          ...[...state.strays.entries()].map(([externalId, sandboxId]) => ({
            externalId,
            sandboxId,
          })),
        ];
      },
    },
  });
  return { connector, state };
}

/** What `sling-runner sandbox` does at boot, minus the cloning: pair and connect. */
async function boot(s: FakeSandbox) {
  const env = s.spec.env;
  const repos = JSON.parse(env[SANDBOX_ENV.repos] ?? "[]") as {
    name: string;
    cloneUrl: string;
    defaultBranch: string;
    network: boolean;
  }[];
  const runner = new FakeRunner({
    url: env[SANDBOX_ENV.url] ?? "",
    name: `sandbox-${s.sandboxId}`,
    repos: repos.map((r) => ({
      name: r.name,
      remoteUrl: r.cloneUrl,
      defaultBranch: r.defaultBranch,
      network: r.network,
    })),
    harnesses: (env[SANDBOX_ENV.harnesses] ?? "codex").split(","),
    labels: ["os:linux", "arch:x86_64"],
  });
  s.runner = runner;
  try {
    await runner.pair(env[SANDBOX_ENV.pairCode] ?? "");
    await runner.connect();
  } catch (err) {
    s.bootError = err instanceof Error ? err.message : String(err);
  }
}

// ---------------------------------------------------------------- process provider

/** Whether this Runner build has the `sandbox` command. */
export function hasSandboxCommand(runnerBin: string): boolean {
  try {
    const help = execFileSync(runnerBin, ["--help"], { encoding: "utf8", stdio: "pipe" });
    return /^\s+sandbox\b/m.test(help);
  } catch {
    return false;
  }
}

export interface ProcessSandbox {
  sandboxId: string;
  child: ChildProcess;
  destroyed: boolean;
  exitCode: number | null;
  exited: Promise<number | null>;
  logFile: string;
}

export function createProcessProvider(opts: {
  runnerBin: string;
  /** Each sandbox gets a directory here for its home and Runner state. */
  workDir: string;
  /** Added to the spec's environment, for example a fast fake Codex delay. */
  extraEnv?: Record<string, string>;
}): { connector: AnyConnector; sandboxes: Map<string, ProcessSandbox> } {
  /** Every sandbox it started, by external ID, destroyed ones included. */
  const sandboxes = new Map<string, ProcessSandbox>();
  const connector = defineConnector({
    id: "test-process",
    name: "Local process",
    description: "Runs sling-runner sandbox as a local child process.",
    credentialsSchema: z.object({}),
    secretFields: [],
    configSchema: z.object(baseConfig),
    test: async () => ({ ok: true }),
    nodes: [],
    executionProvider: {
      async create(_ctx, spec) {
        const dir = join(opts.workDir, spec.sandboxId);
        mkdirSync(dir, { recursive: true });
        const logFile = join(dir, "runner.log");
        const log = openSync(logFile, "a");
        const child = spawn(opts.runnerBin, ["sandbox"], {
          // A clean environment, as in a container: nothing from this process leaks in.
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: dir,
            SLING_RUNNER_HOME: join(dir, "runner"),
            GIT_CONFIG_NOSYSTEM: "1",
            SLING_RUNNER_LOG: "info",
            ...opts.extraEnv,
            ...spec.env,
          },
          stdio: ["ignore", log, log],
        });
        const externalId = `proc-${spec.sandboxId}`;
        const entry: ProcessSandbox = {
          sandboxId: spec.sandboxId,
          child,
          destroyed: false,
          exitCode: null,
          logFile,
          exited: new Promise((ok) => {
            child.once("exit", (code) => {
              entry.exitCode = code;
              ok(code);
            });
          }),
        };
        sandboxes.set(externalId, entry);
        return { externalId, detail: `pid ${child.pid}` };
      },
      async destroy(_ctx, externalId) {
        const entry = sandboxes.get(externalId);
        if (!entry) return;
        entry.destroyed = true;
        if (entry.child.exitCode !== null) return;
        entry.child.kill("SIGTERM");
        const timer = setTimeout(() => entry.child.kill("SIGKILL"), 5_000);
        await entry.exited;
        clearTimeout(timer);
      },
      async list() {
        return [...sandboxes.entries()]
          .filter(([, e]) => !e.destroyed && e.child.exitCode === null)
          .map(([externalId, e]) => ({ externalId, sandboxId: e.sandboxId }));
      },
    },
  });
  return { connector, sandboxes };
}
