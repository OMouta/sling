import type { DeployCheck, DeployCheckResult } from "@sling/core";

/** Each check gets this long, redirects included. */
export const CHECK_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;
/** Only this much of a body is read, for `contains` and the version URL. */
export const MAX_BODY_BYTES = 1024 * 1024;
const USER_AGENT = "Sling health check";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Whether a status passes: exactly the one asked for, or 200 to 399 without one. */
export function statusMatches(status: number, want: number | null | undefined): boolean {
  if (want !== null && want !== undefined) return status === want;
  return status >= 200 && status <= 399;
}

/** Whether a version page shows a commit, in full or by its first 7 characters. */
export function showsCommit(body: string, sha: string): boolean {
  const full = sha.trim().toLowerCase();
  if (full.length < 7) return false;
  const text = body.toLowerCase();
  return text.includes(full) || text.includes(full.slice(0, 7));
}

/** Reads at most `max` bytes of a body as text, then lets the rest go. */
async function readStart(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.byteLength > max - size ? value.subarray(0, max - size) : value;
      chunks.push(take);
      size += take.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type Probe =
  | { ok: true; status: number; body: string; ms: number }
  | { ok: false; error: string; ms: number };

function networkError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `No answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`;
  }
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
  const message = cause?.message || (err instanceof Error ? err.message : String(err));
  return `Couldn't reach it: ${message}`;
}

/**
 * A GET the way health checks make it: no cookies, Sling's user agent, at
 * most five redirects, one timeout for the whole thing, and only the start of
 * the body. Private addresses are allowed, since only the user sets these URLs.
 */
export async function probe(
  url: string,
  opts: { readBody: boolean; timeoutMs?: number; signal?: AbortSignal },
): Promise<Probe> {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { ok: false, error: "Not a URL", ms: 0 };
  }
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      return { ok: false, error: "Only http and https URLs can be checked", ms: ms() };
    }
    let res: Response;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "*/*" },
        signal,
      });
    } catch (err) {
      return { ok: false, error: networkError(err, timeoutMs), ms: ms() };
    }
    const location = res.headers.get("location");
    if (REDIRECTS.has(res.status) && location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) {
        return { ok: false, error: `More than ${MAX_REDIRECTS} redirects`, ms: ms() };
      }
      try {
        current = new URL(location, current);
      } catch {
        return { ok: false, error: "A redirect pointed to something that isn't a URL", ms: ms() };
      }
      continue;
    }
    if (!opts.readBody) {
      await res.body?.cancel().catch(() => {});
      return { ok: true, status: res.status, body: "", ms: ms() };
    }
    try {
      const body = await readStart(res, MAX_BODY_BYTES);
      return { ok: true, status: res.status, body, ms: ms() };
    } catch (err) {
      return { ok: false, error: networkError(err, timeoutMs), ms: ms() };
    }
  }
}

function expected(want: number | null | undefined): string {
  return want !== null && want !== undefined ? String(want) : "200 to 399";
}

/** Runs one health check. */
export async function runCheck(
  check: DeployCheck,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DeployCheckResult> {
  const contains = check.contains || null;
  const p = await probe(check.url, { readBody: contains !== null, ...opts });
  if (!p.ok) return { url: check.url, ok: false, status: null, ms: p.ms, error: p.error };
  if (!statusMatches(p.status, check.status)) {
    return {
      url: check.url,
      ok: false,
      status: p.status,
      ms: p.ms,
      error: `Expected ${expected(check.status)}, got ${p.status}`,
    };
  }
  if (contains !== null && !p.body.includes(contains)) {
    return {
      url: check.url,
      ok: false,
      status: p.status,
      ms: p.ms,
      error: `The page doesn't contain "${contains.slice(0, 80)}"`,
    };
  }
  return { url: check.url, ok: true, status: p.status, ms: p.ms, error: null };
}

/** Runs every check of a target at once. */
export function runChecks(
  checks: DeployCheck[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DeployCheckResult[]> {
  return Promise.all(checks.map((c) => runCheck(c, opts)));
}

/** "https://x/health: 200", or "https://x/health: 500 (Expected 200 to 399, got 500)". */
export function describeResult(r: DeployCheckResult): string {
  const seen = r.status !== null ? String(r.status) : "no answer";
  return r.ok ? `${r.url}: ${seen}` : `${r.url}: ${seen} (${r.error ?? "failed"})`;
}

/** The short reason a target is down, for a title: "502", or the error when nothing answered. */
export function downReason(results: DeployCheckResult[]): string {
  const failed = results.find((r) => !r.ok);
  if (!failed) return "";
  if (failed.status !== null) {
    return statusMatches(failed.status, null)
      ? (failed.error ?? String(failed.status))
      : String(failed.status);
  }
  return failed.error ?? "no answer";
}
