/**
 * `fetch` for extension code. The process has no network, so each request
 * goes to the server, which checks it against the extension's permissions
 * and makes it. Refusals and network failures reject with a TypeError, as a
 * failed fetch does.
 */

/** Request and response bodies are capped at this size. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @param {number} max
 * @returns {Promise<Uint8Array>}
 */
async function readCapped(stream, max) {
  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new TypeError("Sling refused the request: its body is over 10 MB");
    }
    parts.push(value);
  }
  if (parts.length === 1) return /** @type {Uint8Array} */ (parts[0]);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * @typedef {{
 *   status: number,
 *   statusText: string,
 *   headers: [string, string][],
 *   url: string,
 *   redirected: boolean,
 *   body: Uint8Array | null,
 * }} BrokeredResponse
 */

/**
 * @param {{ request(method: string, params: unknown, signal?: AbortSignal): Promise<any> }} peer
 * @param {typeof fetch} nativeFetch Used only for `data:` and `blob:` URLs, which need no network.
 * @returns {typeof fetch}
 */
export function makeFetch(peer, nativeFetch) {
  /**
   * @param {RequestInfo | URL} input
   * @param {RequestInit} [init]
   */
  async function fetch(input, init) {
    const request = new Request(input, init);
    const signal = request.signal;
    const protocol = request.url.slice(0, request.url.indexOf(":") + 1);
    if (protocol === "data:" || protocol === "blob:") return nativeFetch(request);
    signal.throwIfAborted();
    const sent = request.body ? await readCapped(request.body, MAX_BODY_BYTES) : null;
    /** @type {BrokeredResponse} */
    let res;
    try {
      res = await peer.request(
        "fetch",
        {
          url: request.url,
          method: request.method,
          headers: [...request.headers],
          body: sent,
          redirect: request.redirect,
        },
        signal,
      );
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      if (err instanceof TypeError) throw err;
      throw new TypeError(err instanceof Error ? err.message : String(err));
    }
    const body = NULL_BODY_STATUS.has(res.status)
      ? null
      : /** @type {BodyInit | null} */ (res.body);
    const response = new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
    Object.defineProperty(response, "url", { value: res.url, enumerable: true });
    Object.defineProperty(response, "redirected", { value: res.redirected, enumerable: true });
    return response;
  }
  return /** @type {typeof globalThis.fetch} */ (fetch);
}
