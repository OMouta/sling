/**
 * Runs extension code in restricted Node processes, one per extension.
 *
 * A process starts on the first call and stops after a while with nothing in
 * flight and no event source running. A heartbeat kills a process that stops
 * answering. Every call has a deadline. A process that crashes is started
 * again on the next call, until it has crashed too often, which leaves the
 * extension in error until it's turned off and on again.
 *
 * Nothing a process sends is trusted: every request is checked here or by
 * the scope it names, and the network goes through the broker.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ExtensionStatus } from "@sling/core";
import {
  encodeFrame,
  FrameDecoder,
  Peer,
  RUNTIME_DIR,
  type WireError,
} from "@sling/extension-runtime";
import { NodeError, type NodeLogger } from "@sling/workflow";
import { z } from "zod";
import type { BrokerSession, NetworkBroker, RelaySocket } from "./broker.ts";
import type { ActiveExtension, ExtensionLogLine, RuntimeEvents } from "./runtime.ts";

// ------------------------------------------------------------- settings

export interface HostTimings {
  /** How often the server pings each process. */
  heartbeatMs: number;
  /** A process that hasn't answered a ping for this long is killed. */
  heartbeatTimeoutMs: number;
  /** A process with nothing in flight and no source running stops after this long. */
  idleMs: number;
  /** How long a process may take to load its bundle. */
  startTimeoutMs: number;
  /** Crashes within this window count towards the limit. */
  crashWindowMs: number;
  /** This many crashes within the window put the extension in error. */
  crashLimit: number;
}

export const DEFAULT_TIMINGS: HostTimings = {
  heartbeatMs: 5_000,
  heartbeatTimeoutMs: 10_000,
  idleMs: 5 * 60_000,
  startTimeoutMs: 10_000,
  crashWindowMs: 10 * 60_000,
  crashLimit: 5,
};

/** How long each kind of call may take. */
export const DEFAULT_DEADLINES = {
  describe: 30_000,
  test: 30_000,
  run: 10 * 60_000,
  resume: 10 * 60_000,
  match: 1_000,
  "source.start": 30_000,
  "source.stop": 30_000,
  "provider.create": 5 * 60_000,
  "provider.destroy": 5 * 60_000,
  "provider.list": 60_000,
} as const;

export type CallMethod = keyof typeof DEFAULT_DEADLINES;
export type Deadlines = Record<CallMethod, number>;

const LOG_LINES = 200;
const MAX_LOG_MESSAGE = 8_000;

export interface HostLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ------------------------------------------------------------- errors

export function disabledError(): NodeError {
  return new NodeError("The extension is disabled", { code: "extension_disabled" });
}

function unresponsiveError(): NodeError {
  return new NodeError("The extension stopped responding", { code: "extension_unresponsive" });
}

function crashedError(detail: string): NodeError {
  return new NodeError(`The extension stopped responding: ${detail}`, {
    code: "extension_crashed",
  });
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) {
    const s = Math.round(ms / 100) / 10;
    return s === 1 ? "1 second" : `${s} seconds`;
  }
  const m = Math.round(ms / 6000) / 10;
  return m === 1 ? "1 minute" : `${m} minutes`;
}

const CALL_NAMES: Record<CallMethod, string> = {
  describe: "describing itself",
  test: "the connection test",
  run: "the node",
  resume: "the node",
  match: "the trigger",
  "source.start": "starting its event source",
  "source.stop": "stopping its event source",
  "provider.create": "creating the sandbox",
  "provider.destroy": "destroying the sandbox",
  "provider.list": "listing sandboxes",
};

function timeoutError(method: CallMethod, ms: number): NodeError {
  return new NodeError(`The extension didn't finish ${CALL_NAMES[method]} within ${duration(ms)}`, {
    code: "extension_timeout",
    retryable: true,
  });
}

const CODE = /^[A-Za-z0-9_.:-]{1,100}$/;

/** Rebuilds an error the extension threw. NodeErrors keep their code and retryable flag. */
export function fromWireError(e: WireError): Error {
  const message = String(e?.message ?? "The extension failed").slice(0, 4000);
  const code = typeof e?.code === "string" && CODE.test(e.code) ? e.code : undefined;
  if (e?.name === "NodeError") {
    return new NodeError(message, { code: code ?? "node_failed", retryable: e.retryable === true });
  }
  const err = e?.name === "TypeError" ? new TypeError(message) : new Error(message);
  if (typeof e?.name === "string" && /^[A-Za-z]{1,40}$/.test(e.name)) err.name = e.name;
  if (code) (err as Error & { code?: string }).code = code;
  return err;
}

// ------------------------------------------------------------- process

export type ExitKind = "stopped" | "crashed" | "unresponsive" | "out_of_memory" | "failed_to_start";

export interface ProcessExit {
  kind: ExitKind;
  /** For people: "it ran out of memory", "it exited with code 1". */
  detail: string;
}

interface ProcessHooks {
  onRequest(
    proc: ExtensionProcess,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  onNote(proc: ExtensionProcess, method: string, params: unknown): void;
  onStderr(line: string): void;
  onExit(proc: ExtensionProcess, exit: ProcessExit): void;
}

export interface ProcessOptions {
  extensionId: string;
  /** The unpacked package. */
  dir: string;
  /** The bundle, relative to `dir`. */
  main: string;
  memoryMb: number;
  timings: HostTimings;
  hooks: ProcessHooks;
}

let runtimeDir: string | null = null;

/** Real paths, because the module loader resolves symlinks and may not read the links themselves. */
function realRuntimeDir(): string {
  runtimeDir ??= realpathSync(RUNTIME_DIR);
  return runtimeDir;
}

/** The command line that starts an extension's process. */
export function processArgs(dir: string, main: string, memoryMb: number, extensionId: string) {
  const pkg = realpathSync(dir);
  const bundle = join(pkg, main);
  const rel = relative(pkg, bundle);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`main ${main} is outside the package`);
  const runtime = realRuntimeDir();
  return [
    "--permission",
    `--allow-fs-read=${runtime}`,
    `--allow-fs-read=${pkg}`,
    `--max-old-space-size=${Math.trunc(memoryMb)}`,
    "--disallow-code-generation-from-strings",
    join(runtime, "main.mjs"),
    bundle,
    extensionId,
  ];
}

/** One running extension process and the channel to it. */
export class ExtensionProcess {
  readonly #child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly #peer: Peer;
  readonly #hooks: ProcessHooks;
  readonly #timings: HostTimings;
  readonly #exited: Promise<ProcessExit>;
  #exit: ProcessExit | null = null;
  /** Why the server is killing it, when it is. */
  #killing: { kind: ExitKind; detail: string; error: unknown } | null = null;
  #ready = false;
  #lastPong = Date.now();
  #heartbeat: NodeJS.Timeout | null = null;
  #stderrLine = "";
  /** V8 said it ran out of heap. */
  #outOfMemory = false;

  private constructor(opts: ProcessOptions, onReady: (err: Error | null) => void) {
    this.#hooks = opts.hooks;
    this.#timings = opts.timings;
    this.#child = spawn(
      process.execPath,
      processArgs(opts.dir, opts.main, opts.memoryMb, opts.extensionId),
      { env: {}, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const child = this.#child;
    this.#peer = new Peer({
      send: (frame) => {
        if (!child.stdin.writable) throw this.#gone();
        child.stdin.write(encodeFrame(frame));
      },
      onRequest: (m, p, signal) => this.#hooks.onRequest(this, m, p, signal),
      onNote: (m, p) => this.#hooks.onNote(this, m, p),
      toError: fromWireError,
    });
    child.stdin.on("error", () => {});
    const decoder = new FrameDecoder();
    let fatal: Error | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        this.kill("crashed", `it sent a bad message: ${err instanceof Error ? err.message : err}`);
        return;
      }
      for (const raw of frames) {
        const frame = raw as { t?: unknown; e?: WireError } | null;
        if (frame?.t === "pong") {
          this.#lastPong = Date.now();
          continue;
        }
        if (!this.#ready && frame?.t === "ready") {
          this.#ready = true;
          this.#lastPong = Date.now();
          this.#startHeartbeat();
          onReady(null);
          continue;
        }
        if (!this.#ready && frame?.t === "fatal") {
          fatal = fromWireError(frame.e ?? { name: "Error", message: "The bundle failed to load" });
          continue;
        }
        // Logs and requests can come while the bundle is still loading, from its top level.
        this.#peer.handle(frame);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const lines = (this.#stderrLine + chunk.toString()).split("\n");
      this.#stderrLine = lines.pop() ?? "";
      for (const line of lines) this.#stderr(line);
    });
    const startTimer = setTimeout(() => {
      this.kill(
        "failed_to_start",
        `it didn't load within ${duration(opts.timings.startTimeoutMs)}`,
      );
    }, opts.timings.startTimeoutMs);
    startTimer.unref();
    child.on("error", (err) => {
      // Spawning failed; "close" still follows.
      fatal ??= err;
    });
    this.#exited = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        clearTimeout(startTimer);
        if (this.#heartbeat) clearInterval(this.#heartbeat);
        this.#stderr(this.#stderrLine);
        const exit = this.#classify(code, signal, fatal);
        this.#exit = exit;
        this.#peer.close(this.#killing?.error ?? this.#errorFor(exit));
        if (!this.#ready)
          onReady(fatal ?? new Error(`The extension failed to start: ${exit.detail}`));
        this.#hooks.onExit(this, exit);
        resolve(exit);
      });
    });
  }

  /** Starts a process and resolves once its bundle has loaded. */
  static start(opts: ProcessOptions): Promise<ExtensionProcess> {
    return new Promise((resolve, reject) => {
      let proc: ExtensionProcess | null = null;
      let settled: Error | null | undefined;
      const onReady = (err: Error | null) => {
        if (settled !== undefined) return;
        settled = err;
        if (!proc) return;
        if (err) reject(err);
        else resolve(proc);
      };
      try {
        proc = new ExtensionProcess(opts, onReady);
      } catch (err) {
        reject(err);
        return;
      }
      if (settled === null) resolve(proc);
      else if (settled) reject(settled);
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get alive(): boolean {
    return this.#exit === null;
  }

  /** Running and not being stopped, so it can take new calls. */
  get usable(): boolean {
    return this.#exit === null && this.#killing === null;
  }

  get exited(): Promise<ProcessExit> {
    return this.#exited;
  }

  #stderr(line: string) {
    if (!line.trim()) return;
    if (/heap out of memory|Reached heap limit/.test(line)) this.#outOfMemory = true;
    // V8's native backtrace after a fatal error says nothing to an extension's author.
    if (/^\s*\d+: 0x[0-9a-f]+ /.test(line) || /^-+ Native stack trace -+$/.test(line.trim()))
      return;
    this.#hooks.onStderr(line);
  }

  #gone(): Error {
    return this.#killing ? (this.#killing.error as Error) : unresponsiveError();
  }

  #errorFor(exit: ProcessExit): unknown {
    if (exit.kind === "unresponsive") return unresponsiveError();
    if (exit.kind === "stopped") return disabledError();
    return crashedError(exit.detail);
  }

  #classify(code: number | null, signal: NodeJS.Signals | null, fatal: Error | null): ProcessExit {
    if (this.#killing) return { kind: this.#killing.kind, detail: this.#killing.detail };
    if (this.#outOfMemory) {
      return { kind: "out_of_memory", detail: "it ran out of memory" };
    }
    if (!this.#ready) {
      return {
        kind: "failed_to_start",
        detail: fatal ? `its code failed to load: ${fatal.message}` : exitText(code, signal),
      };
    }
    return { kind: "crashed", detail: exitText(code, signal) };
  }

  #startHeartbeat() {
    const t = this.#timings;
    this.#heartbeat = setInterval(() => {
      if (Date.now() - this.#lastPong > t.heartbeatTimeoutMs) {
        this.kill("unresponsive", `it didn't answer for ${duration(t.heartbeatTimeoutMs)}`);
        return;
      }
      try {
        this.#child.stdin.write(encodeFrame({ t: "ping" }));
      } catch {
        // Exiting.
      }
    }, t.heartbeatMs);
    this.#heartbeat.unref();
  }

  /** Calls into the extension. Rejects when the deadline passes or `signal` aborts. */
  call(
    method: CallMethod,
    params: Record<string, unknown>,
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#exit) return Promise.reject(this.#errorFor(this.#exit));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(timeoutError(method, deadlineMs)), deadlineMs);
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    return this.#peer.request(method, params, combined).finally(() => clearTimeout(timer));
  }

  notify(method: string, params: unknown): void {
    if (this.#exit) return;
    try {
      this.#peer.notify(method, params);
    } catch {
      // Too large to send, or the process is exiting.
    }
  }

  get inFlight(): number {
    return this.#peer.pendingCount;
  }

  /** Kills the process. Calls in flight fail with `error`, or the error for `kind`. */
  kill(kind: ExitKind, detail: string, error?: unknown): void {
    if (this.#exit || this.#killing) return;
    this.#killing = {
      kind,
      detail,
      error: error ?? (kind === "unresponsive" ? unresponsiveError() : crashedError(detail)),
    };
    this.#child.kill("SIGKILL");
  }

  /** Stops the process on purpose. Calls in flight fail with `error`. */
  async stop(error: unknown = disabledError()): Promise<void> {
    this.kill("stopped", "it was stopped", error);
    await this.#exited;
  }
}

function exitText(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `it was killed by ${signal}`;
  return `it exited with code ${code ?? "unknown"}`;
}

// ------------------------------------------------------------- scopes

/** What a node call may ask the server for. */
export interface CallScope {
  kind: "call";
  installation?(id: string): Promise<unknown>;
  log: NodeLogger;
}

/** What a running event source may ask the server for. */
export interface SourceScope {
  kind: "source";
  emit(event: { type: string; payload: unknown; dedupeKey?: string }): Promise<void>;
  stateGet(key: string): Promise<string | null>;
  stateSet(key: string, value: string): Promise<void>;
  decide(decision: unknown): Promise<{ ok: boolean; message: string }>;
  reportRefused(decision: unknown): Promise<void>;
  setStatus(status: "connecting" | "connected" | "error", detail?: string): void;
  log: NodeLogger;
}

type Scope = CallScope | SourceScope;

interface SourceEntry {
  scope: SourceScope;
  version: HostVersion;
  proc: ExtensionProcess | null;
  /** Its start call finished, so a failure is the source's to report. */
  started: boolean;
}

export interface RunningSource {
  stop(): Promise<void>;
}

// ------------------------------------------------------------- requests

const InstallationRequest = z.object({ scope: z.number(), id: z.string().min(1).max(200) });
const FetchRequest = z.object({
  url: z.string().max(8_000),
  method: z.string().regex(/^[A-Za-z!#$%&'*+.^_`|~-]{1,20}$/),
  headers: z.array(z.tuple([z.string().max(1_000), z.string().max(16_000)])).max(200),
  body: z.instanceof(Uint8Array).nullable(),
  redirect: z.enum(["follow", "manual", "error"]),
});
const SocketOpen = z.object({
  id: z.number().int(),
  url: z.string().max(8_000),
  protocols: z.array(z.string().max(200)).max(20),
});
const SocketSend = z.object({
  id: z.number().int(),
  data: z.union([z.string(), z.instanceof(Uint8Array)]),
});
const SocketClose = z.object({
  id: z.number().int(),
  code: z.number().int().optional(),
  reason: z.string().max(200).optional(),
});
const Emit = z.object({
  sid: z.number(),
  event: z.object({
    type: z.string().min(1).max(200),
    payload: z.unknown(),
    dedupeKey: z.string().max(500).optional(),
  }),
});
const StateGet = z.object({ sid: z.number(), key: z.string().min(1).max(200) });
const StateSet = z.object({
  sid: z.number(),
  key: z.string().min(1).max(200),
  value: z.string().max(64 * 1024),
});
const Decision = z.object({
  approvalId: z.string().min(1).max(200),
  approve: z.boolean(),
  actor: z.object({ via: z.string().min(1).max(100), externalUserId: z.string().min(1).max(200) }),
});
const DecisionRequest = z.object({ sid: z.number(), decision: Decision });
const RefusedRequest = z.object({
  sid: z.number(),
  decision: Decision.extend({ reason: z.string().max(1_000) }),
});
const SourceStatusNote = z.object({
  sid: z.number(),
  status: z.enum(["connecting", "connected", "error"]),
  detail: z.string().max(2_000).nullable(),
});
const LogNote = z.object({
  level: z.enum(["info", "warn", "error"]),
  message: z.string(),
  data: z.unknown().optional(),
  scope: z.unknown().optional(),
});

function badRequest(method: string): Error {
  return new Error(`Sling refused a malformed ${method} request`);
}

// ------------------------------------------------------------- host

/** One activation of an extension: its package, permissions, and process. */
export class HostVersion {
  readonly ext: ActiveExtension;
  proc: ExtensionProcess | null = null;
  starting: Promise<ExtensionProcess> | null = null;
  inflight = 0;
  sources = 0;
  idleTimer: NodeJS.Timeout | null = null;
  /** Replaced by a newer version: new calls go there. */
  retired = false;
  /** Deactivated: every call fails. */
  disabled = false;
  session: BrokerSession | null = null;

  constructor(ext: ActiveExtension) {
    this.ext = ext;
  }
}

export interface HostOptions {
  id: string;
  timings: HostTimings;
  deadlines: Deadlines;
  broker: NetworkBroker;
  log: HostLogger;
  events(): RuntimeEvents | null;
  /** Set when this server can't isolate extension code: every call fails with it. */
  unsupportedReason?: string | null;
}

/** Every process of one extension ID, its crash count, and its log. */
export class ExtensionHost {
  readonly id: string;
  readonly #opts: HostOptions;
  #current: HostVersion | null = null;
  readonly #retired = new Set<HostVersion>();
  #crashes: number[] = [];
  #state: "active" | "error" | "disabled" = "disabled";
  #errorDetail = "";
  readonly #lines: ExtensionLogLine[] = [];
  #nextScope = 1;
  readonly #scopes = new Map<number, Scope>();
  readonly #sources = new Map<number, SourceEntry>();
  /** Sockets by process, then by the child's socket ID. */
  readonly #sockets = new Map<ExtensionProcess, Map<number, RelaySocket | null>>();

  constructor(opts: HostOptions) {
    this.id = opts.id;
    this.#opts = opts;
  }

  get state(): "active" | "error" | "disabled" {
    return this.#state;
  }

  /** The current version's process, if one is running. For tests and measurements. */
  get process(): ExtensionProcess | null {
    return this.#current?.proc ?? null;
  }

  log(): ExtensionLogLine[] {
    return [...this.#lines];
  }

  #status(status: ExtensionStatus, detail: string | null) {
    this.#opts.events()?.onStatus(this.id, status, detail);
  }

  /** Adds a line to the extension's log only. */
  #pushLine(level: ExtensionLogLine["level"], message: string): string {
    const text =
      message.length > MAX_LOG_MESSAGE ? `${message.slice(0, MAX_LOG_MESSAGE)}…` : message;
    this.#lines.push({ at: new Date(), level, message: text });
    if (this.#lines.length > LOG_LINES) this.#lines.splice(0, this.#lines.length - LOG_LINES);
    return text;
  }

  /** Adds a line to the extension's log and the server log. */
  addLine(level: ExtensionLogLine["level"], message: string, data?: unknown) {
    const text = this.#pushLine(level, message);
    const obj: Record<string, unknown> = { extensionId: this.id };
    if (data !== undefined) obj.data = data;
    this.#opts.log[level](obj, text);
  }

  // ----------------------------------------------------------- lifecycle

  /** Makes `ext` the version new calls go to. A previous version stops once its calls finish. */
  activate(ext: ActiveExtension): HostVersion {
    const v = new HostVersion(ext);
    const old = this.#current;
    if (this.#state !== "active") {
      // Turning it back on clears the crash count.
      this.#crashes = [];
      this.#state = "active";
      this.#errorDetail = "";
    }
    this.#current = v;
    if (old) {
      old.retired = true;
      this.#retired.add(old);
      this.#maybeIdle(old);
    }
    const unsupported = this.#opts.unsupportedReason ?? null;
    this.#status(unsupported ? "unsupported" : "stopped", unsupported);
    return v;
  }

  /** Stops every process. Calls in flight and later calls on these versions fail with "the extension is disabled". */
  async disable(status: ExtensionStatus = "disabled"): Promise<void> {
    const versions = [...this.#retired, ...(this.#current ? [this.#current] : [])];
    this.#current = null;
    this.#retired.clear();
    this.#state = "disabled";
    for (const v of versions) v.disabled = true;
    await Promise.all(versions.map((v) => this.#shutdown(v, disabledError())));
    this.#status(status, null);
  }

  async #shutdown(v: HostVersion, error: unknown) {
    if (v.idleTimer) clearTimeout(v.idleTimer);
    v.idleTimer = null;
    const starting = v.starting;
    if (starting) await starting.catch(() => {});
    const proc = v.proc;
    if (proc) await proc.stop(error);
    await v.session?.close();
    v.session = null;
  }

  #session(v: HostVersion): BrokerSession {
    v.session ??= this.#opts.broker.session({
      extensionId: this.id,
      hosts: v.ext.granted.network.hosts,
      localNetwork: v.ext.granted.network.localNetwork,
      configHosts: () => v.ext.configHosts(),
    });
    return v.session;
  }

  /** The version a call through `v` runs on. */
  #target(v: HostVersion): HostVersion {
    if (v.disabled) throw disabledError();
    if (this.#opts.unsupportedReason) {
      throw new NodeError(this.#opts.unsupportedReason, { code: "extension_unsupported" });
    }
    if (this.#state === "error") {
      throw new NodeError(this.#errorDetail, { code: "extension_error" });
    }
    const target = v.retired ? this.#current : v;
    if (!target || target.disabled) throw disabledError();
    return target;
  }

  async #ensure(v: HostVersion): Promise<ExtensionProcess> {
    if (v.proc?.usable) return v.proc;
    if (!v.starting) {
      v.starting = this.#spawn(v).finally(() => {
        v.starting = null;
      });
    }
    return v.starting;
  }

  async #spawn(v: HostVersion): Promise<ExtensionProcess> {
    const isCurrent = () => this.#current === v;
    if (isCurrent()) this.#status("starting", null);
    let proc: ExtensionProcess | null = null;
    try {
      proc = await ExtensionProcess.start({
        extensionId: this.id,
        dir: v.ext.dir,
        main: v.ext.manifest.main ?? "extension.mjs",
        memoryMb: v.ext.manifest.memoryMb,
        timings: this.#opts.timings,
        hooks: {
          onRequest: (p, m, params, signal) => this.#onRequest(v, p, m, params, signal),
          onNote: (p, m, params) => this.#onNote(p, m, params),
          onStderr: (line) => this.addLine(line.startsWith("(node:") ? "warn" : "error", line),
          onExit: (p, exit) => this.#onExit(v, p, exit),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new NodeError(`The extension failed to start: ${message}`, {
        code: "extension_start_failed",
      });
    }
    if (v.disabled) {
      await proc.stop();
      throw disabledError();
    }
    v.proc = proc;
    if (isCurrent()) this.#status("running", null);
    this.#maybeIdle(v);
    return proc;
  }

  #onExit(v: HostVersion, proc: ExtensionProcess, exit: ProcessExit) {
    if (v.proc === proc) v.proc = null;
    this.#closeSockets(proc);
    // Sources on this process are gone: say so, so the connector runtime restarts them.
    for (const [sid, entry] of this.#sources) {
      if (entry.proc !== proc) continue;
      this.#sources.delete(sid);
      entry.version.sources--;
      if (entry.started && !v.disabled && exit.kind !== "stopped") {
        entry.scope.setStatus("error", "The extension stopped responding");
      }
    }
    if (exit.kind === "stopped") {
      if (this.#current === v) this.#status("stopped", null);
      return;
    }
    this.addLine("error", `The extension's process stopped: ${exit.detail}`);
    this.#opts.events()?.onCrash(this.id, exit.detail);
    if (v.disabled) return;
    const now = Date.now();
    const window = this.#opts.timings.crashWindowMs;
    this.#crashes = this.#crashes.filter((t) => now - t < window);
    this.#crashes.push(now);
    if (this.#crashes.length >= this.#opts.timings.crashLimit) {
      this.#state = "error";
      this.#errorDetail = `The extension crashed ${this.#crashes.length} times in ${duration(window)}. Turn it off and on again to restart it.`;
      this.#status("error", this.#errorDetail);
      return;
    }
    if (this.#current === v) this.#status("stopped", `It stopped: ${exit.detail}`);
  }

  /** Stops a version's process once nothing needs it: at once when it's been replaced, else after the idle time. */
  #maybeIdle(v: HostVersion) {
    if (v.idleTimer) {
      clearTimeout(v.idleTimer);
      v.idleTimer = null;
    }
    if (v.inflight > 0 || v.sources > 0 || v.disabled) return;
    if (v.retired) {
      if (this.#retired.delete(v)) void this.#shutdown(v, disabledError());
      return;
    }
    if (!v.proc) return;
    v.idleTimer = setTimeout(() => {
      v.idleTimer = null;
      if (v.inflight === 0 && v.sources === 0) void v.proc?.stop();
    }, this.#opts.timings.idleMs);
    v.idleTimer.unref();
  }

  // ----------------------------------------------------------- calls

  /**
   * Calls into the extension, starting its process if needed. `scope` is
   * what the extension may ask for while the call runs.
   */
  async call(
    v: HostVersion,
    method: CallMethod,
    params: Record<string, unknown>,
    opts: { signal?: AbortSignal; scope?: CallScope } = {},
  ): Promise<unknown> {
    const target = this.#target(v);
    target.inflight++;
    if (target.idleTimer) {
      clearTimeout(target.idleTimer);
      target.idleTimer = null;
    }
    const scopeId = this.#nextScope++;
    this.#scopes.set(scopeId, opts.scope ?? { kind: "call", log: this.#lineLogger() });
    try {
      const proc = await this.#ensure(target);
      return await proc.call(
        method,
        { ...params, scope: scopeId },
        this.#opts.deadlines[method],
        opts.signal,
      );
    } finally {
      this.#scopes.delete(scopeId);
      target.inflight--;
      this.#maybeIdle(target);
    }
  }

  /** Starts an event source in the extension. Its process stays up until the source stops. */
  async startSource(
    v: HostVersion,
    params: Record<string, unknown>,
    scope: SourceScope,
    signal?: AbortSignal,
  ): Promise<RunningSource> {
    const target = this.#target(v);
    target.inflight++;
    const sid = this.#nextScope++;
    const entry: SourceEntry = { scope, version: target, proc: null, started: false };
    this.#sources.set(sid, entry);
    target.sources++;
    try {
      const proc = await this.#ensure(target);
      entry.proc = proc;
      if (!proc.alive) throw unresponsiveError();
      await proc.call(
        "source.start",
        { ...params, sid },
        this.#opts.deadlines["source.start"],
        signal,
      );
      entry.started = true;
    } catch (err) {
      if (this.#sources.delete(sid)) target.sources--;
      throw err;
    } finally {
      target.inflight--;
      this.#maybeIdle(target);
    }
    return {
      stop: async () => {
        if (!this.#sources.delete(sid)) return;
        target.sources--;
        const proc = entry.proc;
        try {
          if (proc?.alive) {
            await proc.call("source.stop", { sid }, this.#opts.deadlines["source.stop"]);
          }
        } catch (err) {
          this.addLine(
            "warn",
            `The event source didn't stop cleanly: ${err instanceof Error ? err.message : err}`,
          );
        } finally {
          this.#maybeIdle(target);
        }
      },
    };
  }

  #lineLogger(): NodeLogger {
    return {
      info: (m, d) => this.addLine("info", m, d),
      warn: (m, d) => this.addLine("warn", m, d),
      error: (m, d) => this.addLine("error", m, d),
    };
  }

  // ----------------------------------------------------------- from the child

  #source(proc: ExtensionProcess, sid: number, method: string): SourceScope {
    const entry = this.#sources.get(sid);
    // A process can only act for sources it runs.
    if (!entry || entry.proc !== proc) throw badRequest(method);
    return entry.scope;
  }

  async #onRequest(
    v: HostVersion,
    proc: ExtensionProcess,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (method) {
      case "installation": {
        const p = InstallationRequest.safeParse(params);
        if (!p.success) throw badRequest(method);
        const scope = this.#scopes.get(p.data.scope);
        if (scope?.kind !== "call" || !scope.installation) {
          throw new NodeError("Only a running node can read installations", {
            code: "installation_not_allowed",
          });
        }
        return await scope.installation(p.data.id);
      }
      case "fetch": {
        const p = FetchRequest.safeParse(params);
        if (!p.success) throw badRequest(method);
        return await this.#session(v).fetch(p.data, signal);
      }
      case "ws.open":
        return await this.#openSocket(v, proc, params, signal);
      case "source.emit": {
        const p = Emit.safeParse(params);
        if (!p.success) throw badRequest(method);
        await this.#source(proc, p.data.sid, method).emit(p.data.event);
        return null;
      }
      case "source.state.get": {
        const p = StateGet.safeParse(params);
        if (!p.success) throw badRequest(method);
        return await this.#source(proc, p.data.sid, method).stateGet(p.data.key);
      }
      case "source.state.set": {
        const p = StateSet.safeParse(params);
        if (!p.success) throw badRequest(method);
        await this.#source(proc, p.data.sid, method).stateSet(p.data.key, p.data.value);
        return null;
      }
      case "source.decide": {
        const p = DecisionRequest.safeParse(params);
        if (!p.success) throw badRequest(method);
        return await this.#source(proc, p.data.sid, method).decide(p.data.decision);
      }
      case "source.refused": {
        const p = RefusedRequest.safeParse(params);
        if (!p.success) throw badRequest(method);
        await this.#source(proc, p.data.sid, method).reportRefused(p.data.decision);
        return null;
      }
      default:
        throw new Error(`Sling doesn't answer ${String(method).slice(0, 50)} requests`);
    }
  }

  #onNote(proc: ExtensionProcess, method: string, params: unknown) {
    switch (method) {
      case "log": {
        const p = LogNote.safeParse(params);
        if (!p.success) return;
        const { level, message, data, scope } = p.data;
        const s =
          typeof scope === "number"
            ? this.#scopes.get(scope)
            : typeof scope === "string" && scope.startsWith("source:")
              ? this.#sources.get(Number(scope.slice(7)))?.scope
              : undefined;
        const extra = data !== null && typeof data === "object" ? { data } : undefined;
        // A call's lines go to its own log, which reaches the server log with the run's context.
        if (s) s.log[level](this.#pushLine(level, message), extra);
        else this.addLine(level, message, extra?.data);
        return;
      }
      case "source.status": {
        const p = SourceStatusNote.safeParse(params);
        if (!p.success) return;
        const entry = this.#sources.get(p.data.sid);
        if (!entry || entry.proc !== proc) return;
        entry.scope.setStatus(p.data.status, p.data.detail ?? undefined);
        return;
      }
      case "ws.send": {
        const p = SocketSend.safeParse(params);
        if (!p.success) return;
        this.#sockets.get(proc)?.get(p.data.id)?.send(p.data.data);
        return;
      }
      case "ws.close": {
        const p = SocketClose.safeParse(params);
        if (!p.success) return;
        this.#sockets.get(proc)?.get(p.data.id)?.close(p.data.code, p.data.reason);
        return;
      }
    }
  }

  async #openSocket(
    v: HostVersion,
    proc: ExtensionProcess,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const p = SocketOpen.safeParse(params);
    if (!p.success) throw badRequest("ws.open");
    const { id, url, protocols } = p.data;
    let mine = this.#sockets.get(proc);
    if (!mine) {
      mine = new Map();
      this.#sockets.set(proc, mine);
    }
    if (mine.has(id)) throw badRequest("ws.open");
    mine.set(id, null);
    try {
      const relay = await this.#session(v).openSocket(
        url,
        protocols,
        {
          message: (data) => proc.notify("ws.message", { id, data }),
          error: (message) => proc.notify("ws.error", { id, message }),
          closed: (code, reason, wasClean) => {
            mine.delete(id);
            proc.notify("ws.closed", { id, code, reason, wasClean });
          },
        },
        signal,
      );
      if (!proc.alive || !mine.has(id)) {
        relay.close(1000, "The extension stopped");
        throw new TypeError("The extension stopped");
      }
      mine.set(id, relay);
      return { protocol: relay.protocol, extensions: relay.extensions };
    } catch (err) {
      mine.delete(id);
      throw err;
    }
  }

  #closeSockets(proc: ExtensionProcess) {
    const mine = this.#sockets.get(proc);
    this.#sockets.delete(proc);
    for (const relay of mine?.values() ?? []) relay?.close(1000, "The extension stopped");
  }
}
