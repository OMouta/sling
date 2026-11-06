import { NodeError } from "@sling/connector-sdk";

/** Longest a single request to a calendar server may take. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Largest body read from a calendar server: a feed, or a CalDAV answer. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface HttpAnswer {
  status: number;
  headers: Headers;
  body: string;
  url: string;
}

export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && !err.message.includes(cause.message)) {
    return `${err.message}: ${cause.message}`;
  }
  return err.message;
}

/** A fetch with the timeout and size limit, and errors worded for the user. */
export async function request(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  what: string,
): Promise<HttpAnswer> {
  const signal = AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal, redirect: "follow" });
  } catch (err) {
    if (init.signal.aborted) throw err;
    if (signal.aborted) {
      throw new NodeError(`${what} didn't answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`, {
        code: "calendar_timeout",
        retryable: true,
      });
    }
    throw new NodeError(`Couldn't reach ${what}: ${errorMessage(err)}`, {
      code: "calendar_unreachable",
      retryable: true,
      cause: err,
    });
  }
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) {
    await res.body?.cancel();
    throw tooLarge(what);
  }
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw tooLarge(what);
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof NodeError) throw err;
      throw new NodeError(`${what} stopped answering: ${errorMessage(err)}`, {
        code: "calendar_unreachable",
        retryable: true,
        cause: err,
      });
    }
  }
  const body = Buffer.concat(chunks, size).toString("utf8");
  return { status: res.status, headers: res.headers, body, url: res.url || url };
}

function tooLarge(what: string): NodeError {
  return new NodeError(`${what} sent more than ${MAX_BODY_BYTES / 1024 / 1024} MB.`, {
    code: "calendar_too_large",
  });
}
