import { lookup } from "node:dns/promises";
import { Agent, request } from "undici";
import { normalizeHost } from "../extensions/broker.ts";
import { addressRefusal } from "../sources/fetch-link.ts";

/** Internal destinations require an operator-set exact origin. Redirects re-check policy. */
export async function outboundRequest(
  raw: URL,
  opts: {
    method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers: Headers;
    body?: string;
    signal: AbortSignal;
    allowedOrigins: readonly string[];
  },
): Promise<Response> {
  let url = new URL(raw);
  let method = opts.method;
  let body = opts.body;
  const headers = new Headers(opts.headers);
  for (let hop = 0; hop <= 5; hop++) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Invalid HTTP destination");
    opts.signal.throwIfAborted();
    const addresses = await lookup(normalizeHost(url.hostname), { all: true, verbatim: true });
    opts.signal.throwIfAborted();
    if (!addresses.length) throw new Error("Destination has no addresses");
    for (const item of addresses) {
      if (
        ["169.254.169.254", "169.254.170.2", "168.63.129.16", "fd00:ec2::254"].includes(
          normalizeHost(item.address),
        )
      )
        throw new Error("Cloud metadata destination is forbidden");
      const refusal = addressRefusal(item.address);
      if (refusal && (refusal.includes("metadata") || !opts.allowedOrigins.includes(url.origin))) {
        throw new Error("Destination is outside the configured HTTP network policy");
      }
    }
    const first = addresses[0];
    if (!first) throw new Error("Destination has no addresses");
    const agent = new Agent({
      connect: {
        lookup: (_host, options, cb) => {
          if (options.all) cb(null, [first]);
          else cb(null, first.address, first.family);
        },
      },
    });
    try {
      const res = await request(url, {
        method,
        headers: Object.fromEntries(headers),
        body,
        signal: opts.signal,
        dispatcher: agent,
      });
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && location) {
        // Read and drop the body. Destroying it instead raises an error with no listener,
        // which would end the process.
        await res.body.dump();
        const next = new URL(Array.isArray(location) ? (location[0] ?? "") : location, url);
        if (next.origin !== url.origin) {
          headers.delete("authorization");
          headers.delete("cookie");
        }
        if (
          (res.statusCode === 303 && method !== "HEAD") ||
          ([301, 302].includes(res.statusCode) && method === "POST")
        ) {
          method = "GET";
          body = undefined;
          headers.delete("content-type");
          headers.delete("content-length");
        }
        url = next;
        continue;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        // Leaving the loop closes the body.
        if (size > 2 * 1024 * 1024) throw new Error("HTTP response exceeds 2 MB");
        chunks.push(chunk);
      }
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined)
          responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      return new Response(
        method === "HEAD" || [204, 205, 304].includes(res.statusCode)
          ? null
          : Buffer.concat(chunks),
        { status: res.statusCode, headers: responseHeaders },
      );
    } finally {
      await agent.destroy();
    }
  }
  throw new Error("Too many HTTP redirects");
}
