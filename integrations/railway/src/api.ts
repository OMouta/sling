/**
 * The slice of the Railway SDK the provider uses. `sdk.ts` implements it with
 * the real SDK; tests use a fake.
 */
import type { RailwayCredentials } from "./schemas.ts";

/** CREATING, RUNNING, DESTROYING, DESTROYED, or FAILED. */
export type SandboxStatus = string;

export interface SandboxSummary {
  id: string;
  status: SandboxStatus;
  createdAt: string;
}

export interface ExecOutcome {
  /** Null if the session ended without an exit code. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  /** Variables for this command only. They travel as exec parameters, never in the command line. */
  env?: Record<string, string>;
  timeoutSec?: number;
  signal?: AbortSignal;
}

export interface RailwaySandbox {
  readonly id: string;
  readonly status: SandboxStatus;
  readonly region: string;
  /** Runs a command to completion. A non-zero exit resolves; it doesn't throw. */
  exec(command: string, options?: ExecOptions): Promise<ExecOutcome>;
  /**
   * Starts a command in a durable session and disconnects, leaving it running.
   * Railway doesn't idle out a sandbox while such a command runs.
   * Resolves with the session name.
   */
  execDetached(command: string, options?: { signal?: AbortSignal }): Promise<string>;
  writeFile(path: string, content: string, mode?: number): Promise<void>;
  /** Null when the file doesn't exist. Rejects on other failures. */
  readFile(path: string): Promise<string | null>;
  destroy(): Promise<void>;
}

export interface CreateSandboxOptions {
  idleTimeoutMinutes: number;
  resources?: { cpu?: number; memoryGB?: number };
}

export interface RailwayApi {
  /** Resolves once the sandbox is RUNNING. */
  create(options: CreateSandboxOptions): Promise<RailwaySandbox>;
  /** Null when the environment has no such sandbox. */
  connect(id: string): Promise<RailwaySandbox | null>;
  /** Sandboxes in the environment, newest first, up to `first`. */
  list(first?: number): Promise<SandboxSummary[]>;
}

export type RailwayClientFactory = (credentials: RailwayCredentials) => RailwayApi;
