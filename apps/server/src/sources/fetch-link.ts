/**
 * Fetching a link a personality reads from. The server runs on the
 * workspace's own network, so a link must never reach it: each hop's host
 * is resolved here and every address checked, and the connection goes to
 * the address that was checked, so a DNS answer that changes in between
 * can't slip through. Redirects are followed by hand for the same reason.
 */
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { SOURCE_MAX_BYTES } from "@sling/core";
import { Agent, request } from "undici";
import { classifyAddress, normalizeHost } from "../extensions/broker.ts";

/** Why a link couldn't be fetched, in words for the user. */
export class LinkError extends Error {}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface FetchedLink {
  bytes: Uint8Array;
  /** The Content-Type the server sent. */
  contentType: string;
  /** Where it ended up, after redirects. */
  url: string;
}

export interface FetchOptions {
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  /** Why an address is refused, or null when it may be reached. */
  refusal?: (address: string) => string | null;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export const LINK_TIMEOUT_MS = 20_000;
export const LINK_MAX_REDIRECTS = 5;

/** Public addresses that are still a cloud's metadata or host service. */
const METADATA = new Set(["168.63.129.16", "fd00:ec2::254"]);

const CLASS_TEXT: Record<string, string> = {
  loopback: "a loopback address",
  private: "a private address",
  "link-local": "a link-local address",
  cgnat: "a carrier-grade NAT address",
  unspecified: "an unspecified address",
  "unique-local": "a unique local address",
  multicast: "a multicast address",
  reserved: "a reserved address",
};

/** Why the server won't connect to this address, or null when it may. */
export function addressRefusal(address: string): string | null {
  const bare = normalizeHost(address);
  if (METADATA.has(bare)) return "a cloud metadata address";
  const cls = classifyAddress(bare);
  return cls === "public" ? null : (CLASS_TEXT[cls] ?? "an address Sling doesn't reach");
}

async function resolveHost(host: string): Promise<ResolvedAddress[]> {
  const all = await lookup(host, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

/** A dispatcher that connects only to `address`, whatever the name resolves to by then. */
function pinned(address: ResolvedAddress): Agent {
  const lookupFn: LookupFunction = (_host, options, cb) => {
    if (options.all) (cb as unknown as (e: null, l: ResolvedAddress[]) => void)(null, [address]);
    else cb(null, address.address, address.family);
  };
  return new Agent({ connect: { lookup: lookupFn }, allowH2: false });
}

function hostText(url: URL): string {
  return url.host || url.href;
}

/**
 * Fetches a link: HTTP or HTTPS only, at most `maxBytes`, within
 * `timeoutMs` for the whole thing, following at most `maxRedirects`.
 * Throws LinkError with the reason when it can't.
 */
export async function fetchLink(raw: string, opts: FetchOptions = {}): Promise<FetchedLink> {
  const resolve = opts.resolve ?? resolveHost;
  const refusal = opts.refusal ?? addressRefusal;
  const timeoutMs = opts.timeoutMs ?? LINK_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? SOURCE_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? LINK_MAX_REDIRECTS;
  const signal = AbortSignal.timeout(timeoutMs);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LinkError("That isn't a web address.");
  }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new LinkError("Only http and https links can be added.");
    }
    if (url.username || url.password) {
      throw new LinkError("Links with a user name or password can't be added.");
    }
    const host = normalizeHost(url.hostname);
    let addresses: ResolvedAddress[];
    if (isIP(host)) {
      addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
    } else {
      try {
        addresses = await resolve(host);
      } catch {
        throw new LinkError(`Sling couldn't find ${hostText(url)}.`);
      }
    }
    const first = addresses[0];
    if (!first) throw new LinkError(`Sling couldn't find ${hostText(url)}.`);
    for (const a of addresses) {
      const why = refusal(a.address);
      if (why) {
        throw new LinkError(
          `${hostText(url)} is ${why}. Sling only fetches pages on the public internet.`,
        );
      }
    }

    const agent = pinned(first);
    try {
      let res: Awaited<ReturnType<typeof request>>;
      try {
        res = await request(url, {
          dispatcher: agent,
          method: "GET",
          signal,
          headers: {
            "user-agent": "Mozilla/5.0 (compatible; Sling/1.0)",
            accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
          },
        });
      } catch (err) {
        if (signal.aborted) throw timedOut(timeoutMs);
        const code = (err as { code?: string })?.code;
        throw new LinkError(`Sling couldn't reach ${hostText(url)}${code ? ` (${code})` : ""}.`);
      }
      const location = header(res.headers.location);
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        await res.body.dump().catch(() => {});
        if (hop >= maxRedirects) {
          throw new LinkError(`It redirects more than ${maxRedirects} times.`);
        }
        try {
          url = new URL(location, url);
        } catch {
          throw new LinkError("It redirects to an address that isn't valid.");
        }
        continue;
      }
      if (res.statusCode >= 400) {
        await res.body.dump().catch(() => {});
        throw new LinkError(`The page answered with an error (${res.statusCode}).`);
      }
      const length = Number(header(res.headers["content-length"]) ?? "");
      const tooBig = `It's over ${Math.round(maxBytes / (1024 * 1024))} MB.`;
      if (length > maxBytes) {
        await res.body.dump().catch(() => {});
        throw new LinkError(tooBig);
      }
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > maxBytes) {
            res.body.destroy();
            throw new LinkError(tooBig);
          }
          parts.push(chunk);
        }
      } catch (err) {
        if (err instanceof LinkError) throw err;
        if (signal.aborted) throw timedOut(timeoutMs);
        throw new LinkError(`The connection to ${hostText(url)} broke off.`);
      }
      return {
        bytes: new Uint8Array(Buffer.concat(parts)),
        contentType: header(res.headers["content-type"]) ?? "",
        url: url.toString(),
      };
    } finally {
      agent.destroy().catch(() => {});
    }
  }
}

function header(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function timedOut(ms: number): LinkError {
  return new LinkError(`The page took longer than ${Math.round(ms / 1000)} seconds.`);
}
