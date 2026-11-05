export interface Backoff {
  initialMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 2_000, maxMs: 2 * 60_000 };

/** Exponential delay for the nth consecutive failure (1-based), with ±20% jitter. */
export function backoffDelay(failures: number, backoff: Backoff): number {
  const base = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** Resolves after `ms`, or as soon as the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
