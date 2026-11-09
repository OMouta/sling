/** Share a shutdown invocation across repeated signals and callers. */
export function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= Promise.resolve().then(action));
}

/** A deadline whose timer is always removed, including when work rejects. */
export async function within<T>(
  work: Promise<T>,
  ms: number,
  message = "Shutdown deadline exceeded",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A fixed point in time that a sequence of steps shares. */
export function deadline(ms: number) {
  const end = performance.now() + Math.max(0, ms);
  return { left: () => Math.max(0, end - performance.now()) };
}

/**
 * How long a stop may take before the process exits regardless. The default leaves room
 * inside the Compose `stop_grace_period` (75 seconds) for the forced exit below and for
 * the process to end before the container is killed.
 */
export const DEFAULT_SHUTDOWN_MS = 60_000;
/** Time after the shutdown deadline before the process exits without waiting further. */
export const FORCED_EXIT_MARGIN_MS = 5_000;

type Signal = "SIGINT" | "SIGTERM";

export interface ProcessHost {
  on(signal: Signal, listener: () => void): void;
  exit(code: number): void;
  log: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
    error(obj: object, msg: string): void;
    fatal(obj: object, msg: string): void;
  };
}

/**
 * Starts the server and stops it on the first SIGINT or SIGTERM. Later signals don't run
 * cleanup again. The process exits as soon as cleanup returns, or `forceExitMs` after the
 * first signal if a step hangs, so it never outlives the container's grace period. A
 * signal during startup aborts it, and startup stops whatever it already brought up.
 */
export async function serve(
  start: (signal: AbortSignal) => Promise<{ close(): Promise<void> }>,
  host: ProcessHost,
  forceExitMs: number,
): Promise<void> {
  const abort = new AbortController();
  let server: { close(): Promise<void> } | undefined;
  let stopping = false;
  let exited = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    clearTimeout(force);
    host.exit(code);
  };
  const finish = async (running: { close(): Promise<void> }) => {
    try {
      await running.close();
      exit(0);
    } catch (err) {
      host.log.error({ err }, "shutdown failed");
      exit(1);
    }
  };
  const stop = (signal: Signal) => {
    if (stopping) {
      host.log.warn({ signal }, "already shutting down");
      return;
    }
    stopping = true;
    host.log.info({ signal }, "shutting down");
    force = setTimeout(() => {
      host.log.fatal({ signal, ms: forceExitMs }, "shutdown deadline passed; exiting");
      exit(1);
    }, forceExitMs);
    abort.abort(new Error(`Stopped by ${signal} during startup`));
    if (server) void finish(server);
  };
  host.on("SIGINT", () => stop("SIGINT"));
  host.on("SIGTERM", () => stop("SIGTERM"));
  try {
    server = await start(abort.signal);
  } catch (err) {
    if (abort.signal.aborted) {
      host.log.info({}, "startup stopped");
      exit(0);
    } else {
      host.log.fatal({ err }, "startup failed");
      exit(1);
    }
    return;
  }
  // A signal that arrived after startup's last check found no server to close yet.
  if (stopping) await finish(server);
}
