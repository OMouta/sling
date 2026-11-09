import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, request } from "undici";
import { normalizeHost, parseV6, reachedV4 } from "../extensions/broker.ts";
import { addressRefusal } from "../sources/fetch-link.ts";

/** A destination the network policy refuses. Trying again won't change the answer. */
export class OutboundPolicyError extends Error {}

/** Cloud metadata and host services outside the link-local ranges, which are refused whole. */
const METADATA_V4 = new Set([
  "168.63.129.16", // Azure's host service
  "100.100.100.200", // Alibaba Cloud
]);
const METADATA_V6 = ["fd00:ec2::254", "fd00:ec2::23", "fd20:ce::254"].map(
  (a) => parseV6(a)?.join(":") ?? a,
);

/**
 * Whether an address is never reachable, allowed origin or not: link-local
 * (169.254.0.0/16 and fe80::/10, where most clouds keep their metadata
 * services) and the other known metadata addresses. An IPv6 form that
 * carries an IPv4 address is judged by that address.
 */
export function metadataAddress(address: string): boolean {
  const v4 = reachedV4(address);
  if (v4) return (v4[0] === 169 && v4[1] === 254) || METADATA_V4.has(v4.join("."));
  const groups = parseV6(normalizeHost(address));
  if (!groups) return false;
  if (((groups[0] ?? 0) & 0xffc0) === 0xfe80) return true;
  return METADATA_V6.includes(groups.join(":"));
}

/**
 * Internal destinations require an operator-set exact origin. Metadata and
 * link-local addresses are refused even then. Each hop's name is resolved
 * once and the connection is made to the address that was checked, so an
 * answer that changes in between can't redirect it. Redirects re-check policy.
 */
export async function outboundRequest(
  raw: URL,
  opts: {
    method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers: Headers;
    body?: string;
    signal: AbortSignal;
    allowedOrigins: readonly string[];
    /** Resolves a host name. Tests use it in place of DNS. */
    resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  },
): Promise<Response> {
  const resolve = opts.resolve ?? ((host: string) => lookup(host, { all: true, verbatim: true }));
  let url = new URL(raw);
  let method = opts.method;
  let body = opts.body;
  const headers = new Headers(opts.headers);
  for (let hop = 0; hop <= 5; hop++) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new OutboundPolicyError("Invalid HTTP destination");
    opts.signal.throwIfAborted();
    const host = normalizeHost(url.hostname);
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
    opts.signal.throwIfAborted();
    if (!addresses.length) throw new Error("Destination has no addresses");
    for (const item of addresses) {
      if (metadataAddress(item.address)) {
        throw new OutboundPolicyError("Cloud metadata and link-local destinations are forbidden");
      }
      if (addressRefusal(item.address) && !opts.allowedOrigins.includes(url.origin)) {
        throw new OutboundPolicyError(
          `${url.origin} is outside the configured HTTP network policy`,
        );
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
