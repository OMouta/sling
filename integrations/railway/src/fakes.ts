/** An in-memory Railway environment and the contexts the server provides. Tests only. */
import type { ProviderContext, SandboxSpec } from "@sling/connector-sdk";
import type { NodeLogger } from "@sling/workflow";
import type {
  CreateSandboxOptions,
  ExecOptions,
  ExecOutcome,
  RailwayApi,
  RailwaySandbox,
  SandboxSummary,
} from "./api.ts";
import {
  configSchema,
  credentialsSchema,
  type RailwayConfig,
  type RailwayCredentials,
} from "./schemas.ts";

export const silentLog: NodeLogger = { info() {}, warn() {}, error() {} };

export interface ExecCall {
  sandboxId: string;
  command: string;
  env: Record<string, string>;
  detached: boolean;
  timeoutSec?: number;
}

type Op =
  | "create"
  | "connect"
  | "list"
  | "exec"
  | "execDetached"
  | "writeFile"
  | "readFile"
  | "destroy";

export class FakeSandbox implements RailwaySandbox {
  status = "RUNNING";
  region = "us-west2";
  createdAt: string;
  files = new Map<string, { content: string; mode: number | undefined }>();
  readonly #env: FakeRailway;
  readonly id: string;

  constructor(env: FakeRailway, id: string, createdAt: string) {
    this.#env = env;
    this.id = id;
    this.createdAt = createdAt;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecOutcome> {
    this.#env.enter("exec", this.id);
    const call = {
      sandboxId: this.id,
      command,
      env: options.env ?? {},
      detached: false,
      timeoutSec: options.timeoutSec,
    };
    this.#env.execs.push(call);
    return this.#env.respond(call);
  }

  async execDetached(command: string): Promise<string> {
    this.#env.enter("execDetached", this.id);
    this.#env.execs.push({ sandboxId: this.id, command, env: {}, detached: true });
    return `session-${this.#env.execs.length}`;
  }

  async writeFile(path: string, content: string, mode?: number) {
    this.#env.enter("writeFile", `${this.id} ${path}`);
    this.files.set(path, { content, mode });
  }

  async readFile(path: string) {
    this.#env.enter("readFile", `${this.id} ${path}`);
    return this.files.get(path)?.content ?? null;
  }

  async destroy() {
    this.#env.enter("destroy", this.id);
    this.status = "DESTROYED";
  }
}

export class FakeRailway implements RailwayApi {
  sandboxes = new Map<string, FakeSandbox>();
  creates: CreateSandboxOptions[] = [];
  execs: ExecCall[] = [];
  calls: string[] = [];
  /** Makes the next call of that kind throw. */
  failures = new Map<Op, Error>();
  /** Answers each exec. Succeeds by default. */
  respond: (call: ExecCall) => ExecOutcome = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
  clock = Date.parse("2026-11-05T10:00:00Z");
  #next = 1;

  enter(op: Op, detail = "") {
    this.calls.push(detail ? `${op} ${detail}` : op);
    const failure = this.failures.get(op);
    if (failure) {
      this.failures.delete(op);
      throw failure;
    }
  }

  async create(options: CreateSandboxOptions) {
    this.enter("create");
    this.creates.push(options);
    const sandbox = new FakeSandbox(
      this,
      `sbx-rw-${this.#next++}`,
      new Date(this.clock).toISOString(),
    );
    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  async connect(id: string) {
    this.enter("connect", id);
    return this.sandboxes.get(id) ?? null;
  }

  async list(first = 100): Promise<SandboxSummary[]> {
    this.enter("list", String(first));
    return [...this.sandboxes.values()]
      .filter((s) => s.status !== "DESTROYED")
      .slice(0, first)
      .map((s) => ({ id: s.id, status: s.status, createdAt: s.createdAt }));
  }

  /** Adds a sandbox something else created, optionally with a marker file. */
  seed(
    id: string,
    options: { status?: string; createdAt?: string; marker?: string } = {},
  ): FakeSandbox {
    const sandbox = new FakeSandbox(
      this,
      id,
      options.createdAt ?? new Date(this.clock - 3_600_000).toISOString(),
    );
    sandbox.status = options.status ?? "RUNNING";
    if (options.marker !== undefined) {
      sandbox.files.set("/tmp/sling/sandbox.json", { content: options.marker, mode: 0o644 });
    }
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }
}

export function context(
  overrides: {
    credentials?: Partial<RailwayCredentials>;
    config?: Partial<RailwayConfig>;
    workspaceId?: string;
    log?: NodeLogger;
    signal?: AbortSignal;
  } = {},
): ProviderContext<RailwayCredentials, RailwayConfig> {
  return {
    installationId: "ins_railway",
    workspaceId: overrides.workspaceId ?? "ws_1",
    credentials: credentialsSchema.parse({
      apiToken: "rw-token-secret",
      environmentId: "env-1",
      ...overrides.credentials,
    }),
    config: configSchema.parse({
      image: "ghcr.io/acme/sling-sandbox:1",
      controlPlaneUrl: "https://sling.example.com",
      ...overrides.config,
    }),
    log: overrides.log ?? silentLog,
    signal: overrides.signal ?? new AbortController().signal,
  };
}

export const SECRETS = {
  SLING_PAIR_CODE: "pair-code-secret-123",
  OPENAI_API_KEY: "sk-openai-secret-456",
  ANTHROPIC_API_KEY: "sk-ant-secret-789",
  SLING_GIT_TOKEN: "ghp_gitsecret000",
};

export function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    sandboxId: "sbx_abc123",
    workspaceId: "ws_1",
    image: "ghcr.io/acme/sling-sandbox:1",
    env: {
      SLING_URL: "https://sling.example.com",
      SLING_SANDBOX_ID: "sbx_abc123",
      SLING_REPOS: JSON.stringify([
        {
          name: "site",
          cloneUrl: "https://github.com/a/site.git",
          defaultBranch: "main",
          network: false,
        },
      ]),
      SLING_HARNESSES: "codex,claude-code",
      SLING_MAX_MODE: "full-access",
      SLING_IDLE_EXIT_SECONDS: "900",
      ...SECRETS,
    },
    labels: { "sling.sandbox": "sbx_abc123", "sling.workspace": "ws_1" },
    lifetimeSeconds: 3600,
    ...overrides,
  };
}

/** A logger that keeps what it was told. */
export function recordingLog() {
  const lines: { level: string; message: string; data?: Record<string, unknown> }[] = [];
  const log: NodeLogger = {
    info: (message, data) => lines.push({ level: "info", message, data }),
    warn: (message, data) => lines.push({ level: "warn", message, data }),
    error: (message, data) => lines.push({ level: "error", message, data }),
  };
  return { log, lines };
}
