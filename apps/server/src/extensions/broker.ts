/**
 * The only way an extension reaches the network. Its process has no sockets
 * of its own, so its `fetch` and `WebSocket` ask the server, and this module
 * decides and makes the request.
 *
 * Rules, checked on every request and every redirect hop:
 * - The host is in the manifest's `network.hosts` (exact, or `*.example.com`
 *   for that name and its subdomains), or is the host of a URL in a config
 *   field the manifest names in `network.configHosts`.
 * - `https:` and `wss:` always; `http:` and `ws:` only with `localNetwork`,
 *   and only to names that resolve to local addresses.
 * - The server resolves the name itself and checks every address. Without
 *   `localNetwork`, loopback, private, link-local, CGNAT, unique-local, and
 *   other non-public addresses are refused. The connection goes to an
 *   address that was checked, so a DNS answer that changes in between can't
 *   slip through.
 * - Bodies are capped at 10 MB each way, requests time out after 60 seconds,
 *   socket messages are capped at 1 MB, and an extension holds at most 16
 *   sockets.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, type Dispatcher, fetch as undiciFetch, WebSocket } from "undici";

export interface NetworkPolicy {
  extensionId: string;
  /** Manifest hosts: exact names, or `*.example.com`. */
  hosts: readonly string[];
  localNetwork: boolean;
  /** Hosts from installation config fields the manifest names. */
  configHosts(): ReadonlySet<string>;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to every address it has. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface BrokerLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface BrokerOptions {
  resolver?: Resolver;
  log?: BrokerLog;
  /** Called with each refusal, for the extension's own log. */
  onRefusal?: (policy: NetworkPolicy, message: string) => void;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  maxSockets?: number;
  maxSocketMessageBytes?: number;
  /** How long a resolved name is reused for new connections. 0 resolves every time. */
  dnsCacheMs?: number;
  /** Extra TLS options, such as a test CA. */
  tls?: { ca?: string | Buffer };
}

export interface BrokeredRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array | null;
  redirect: "follow" | "manual" | "error";
}

export interface BrokeredResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  url: string;
  redirected: boolean;
  body: Uint8Array | null;
}

export interface SocketEvents {
  message(data: string | Uint8Array): void;
  closed(code: number, reason: string, wasClean: boolean): void;
  error(message: string): void;
}

export interface RelaySocket {
  readonly protocol: string;
  readonly extensions: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** A request the network rules don't allow. Reaches the extension as a TypeError with this message. */
export class RefusedError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "TypeError";
  }
}

const MB = 1024 * 1024;

function megabytes(bytes: number): string {
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

function seconds(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return s === 1 ? "1 second" : `${s} seconds`;
}

// ------------------------------------------------------------- addresses

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "cgnat"
  | "unspecified"
  | "unique-local"
  | "multicast"
  | "reserved";

const CLASS_TEXT: Record<AddressClass, string> = {
  public: "public",
  loopback: "loopback",
  private: "private",
  "link-local": "link-local",
  cgnat: "carrier-grade NAT",
  unspecified: "unspecified",
  "unique-local": "unique local",
  multicast: "multicast",
  reserved: "reserved",
};

function classifyV4(a: number, b: number, c: number, d: number): AddressClass {
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  void d;
  return "public";
}

function parseV4(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (n.some((x) => !(x >= 0 && x <= 255))) return null;
  return n as [number, number, number, number];
}

/** Eight 16-bit groups, or null when it isn't an IPv6 address. */
function parseV6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // A trailing dotted IPv4 part becomes two groups.
  const lastColon = s.lastIndexOf(":");
  if (lastColon >= 0 && s.includes(".", lastColon)) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) =>
    h === ""
      ? []
      : h.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : -1));
  const head = parse(halves[0] as string);
  let groups = head;
  if (halves.length === 2) {
    const rest = parse(halves[1] as string);
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  }
  if (groups.length !== 8 || groups.some((g) => g < 0)) return null;
  return groups;
}

function v4FromGroups(hi: number, lo: number): AddressClass {
  return classifyV4(hi >> 8, hi & 0xff, lo >> 8, lo & 0xff);
}

/** What kind of address this is. Anything not "public" needs `localNetwork`. */
export function classifyAddress(address: string): AddressClass {
  const bare = address.startsWith("[") ? address.slice(1, -1) : address;
  const v4 = parseV4(bare);
  if (v4) return classifyV4(...v4);
  const g = parseV6(bare);
  if (!g) return "reserved";
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const zeroTo4 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroTo4 && g5 === 0 && g6 === 0 && g7 === 0) return "unspecified";
  if (zeroTo4 && g5 === 0 && g6 === 0 && g7 === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms.
  if (zeroTo4 && (g5 === 0xffff || g5 === 0)) return v4FromGroups(g6, g7);
  // IPv4-translated (::ffff:0:a.b.c.d).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return v4FromGroups(g6, g7);
  }
  // NAT64 (64:ff9b::/96 and the local-use 64:ff9b:1::/48) reaches the embedded IPv4 address.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return v4FromGroups(g6, g7);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return "reserved";
  // 6to4 (2002::/16) routes to the IPv4 address in the next 32 bits.
  if (g0 === 0x2002) return v4FromGroups(g1, g2);
  if ((g0 & 0xfe00) === 0xfc00) return "unique-local";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  // Site-local, deprecated but still routed locally by some networks.
  if ((g0 & 0xffc0) === 0xfec0) return "private";
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  // Discard-only (100::/64).
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return "reserved";
  return "public";
}

// ------------------------------------------------------------- hosts

/** Lowercase, no brackets around IPv6, no trailing dot. */
export function normalizeHost(host: string): string {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Whether the manifest's hosts or the config hosts allow this host. */
export function hostAllowed(host: string, policy: NetworkPolicy): boolean {
  const h = normalizeHost(host);
  for (const pattern of policy.hosts) {
    const p = normalizeHost(pattern);
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      if (h === base || h.endsWith(`.${base}`)) return true;
    } else if (h === p) return true;
  }
  for (const configHost of policy.configHosts()) {
    if (normalizeHost(configHost) === h) return true;
  }
  return false;
}

type Scheme = "https" | "http";

function schemeOf(protocol: string): Scheme | null {
  if (protocol === "https:" || protocol === "wss:") return "https";
  if (protocol === "http:" || protocol === "ws:") return "http";
  return null;
}

/** Why these addresses can't be used, or null when they can. */
function addressRefusal(
  host: string,
  addresses: readonly ResolvedAddress[],
  scheme: Scheme,
  policy: NetworkPolicy,
): string | null {
  for (const a of addresses) {
    const cls = classifyAddress(a.address);
    const named = host === a.address ? a.address : `${host} resolves to ${a.address}`;
    if (!policy.localNetwork && cls !== "public") {
      return `${named}, a ${CLASS_TEXT[cls]} address, and this extension can't reach the local network`;
    }
    if (scheme === "http" && cls === "public") {
      return `plain http only reaches local network addresses, and ${named}, a public address. Use https`;
    }
  }
  return null;
}

export const defaultResolver: Resolver = async (hostname) => {
  const all = await dnsLookup(hostname, { all: true, order: "verbatim" });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

// ------------------------------------------------------------- broker

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "te",
  "trailer",
  "expect",
]);

const CROSS_ORIGIN_DROPPED = new Set(["authorization", "cookie", "proxy-authorization"]);

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

interface Limits {
  timeoutMs: number;
  maxBodyBytes: number;
  maxRedirects: number;
  maxSockets: number;
  maxSocketMessageBytes: number;
  dnsCacheMs: number;
}

/** Makes network requests for extensions. One per server. */
export class NetworkBroker {
  readonly #resolver: Resolver;
  readonly #log: BrokerLog | undefined;
  readonly #onRefusal: BrokerOptions["onRefusal"];
  readonly #limits: Limits;
  readonly #tls: BrokerOptions["tls"];
  readonly #sessions = new Set<BrokerSession>();

  constructor(opts: BrokerOptions = {}) {
    this.#resolver = opts.resolver ?? defaultResolver;
    this.#log = opts.log;
    this.#onRefusal = opts.onRefusal;
    this.#tls = opts.tls;
    this.#limits = {
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxBodyBytes: opts.maxBodyBytes ?? 10 * MB,
      maxRedirects: opts.maxRedirects ?? 5,
      maxSockets: opts.maxSockets ?? 16,
      maxSocketMessageBytes: opts.maxSocketMessageBytes ?? MB,
      dnsCacheMs: opts.dnsCacheMs ?? 10_000,
    };
  }

  /** A connection pool and socket count for one extension, under its policy. */
  session(policy: NetworkPolicy): BrokerSession {
    const s = new BrokerSession(policy, {
      resolver: this.#resolver,
      limits: this.#limits,
      tls: this.#tls,
      refused: (message) => {
        this.#log?.warn(
          { extensionId: policy.extensionId, reason: message },
          "refused an extension's network request",
        );
        this.#onRefusal?.(policy, message);
      },
      closed: () => this.#sessions.delete(s),
    });
    this.#sessions.add(s);
    return s;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#sessions].map((s) => s.close()));
  }
}

interface SessionDeps {
  resolver: Resolver;
  limits: Limits;
  tls: BrokerOptions["tls"];
  refused: (message: string) => void;
  closed: () => void;
}

type ConnectFn = (opts: buildConnector.Options, cb: buildConnector.Callback) => void;

export class BrokerSession {
  readonly policy: NetworkPolicy;
  readonly #deps: SessionDeps;
  readonly #agent: Agent;
  readonly #resolved = new Map<string, { at: number; addresses: Promise<ResolvedAddress[]> }>();
  readonly #sockets = new Set<WebSocket>();
  #opening = 0;
  #closed = false;

  constructor(policy: NetworkPolicy, deps: SessionDeps) {
    this.policy = policy;
    this.#deps = deps;
    const https = buildConnector({ lookup: this.#lookupFor("https"), ...(deps.tls ?? {}) });
    const http = buildConnector({ lookup: this.#lookupFor("http") });
    const connect: ConnectFn = (opts, cb) => {
      const scheme: Scheme = opts.protocol === "https:" ? "https" : "http";
      const host = normalizeHost(opts.hostname);
      if (isIP(host)) {
        // Literal addresses skip the lookup, so they're checked here.
        const reason = addressRefusal(
          host,
          [{ address: host, family: isIP(host) === 6 ? 6 : 4 }],
          scheme,
          this.policy,
        );
        if (reason) {
          cb(new RefusedError(`Sling refused the request: ${reason}`), null);
          return;
        }
      }
      (scheme === "https" ? https : http)(opts, cb);
    };
    this.#agent = new Agent({
      connect,
      webSocket: { maxPayloadSize: deps.limits.maxSocketMessageBytes },
    });
  }

  get openSockets(): number {
    return this.#sockets.size + this.#opening;
  }

  /** Resolves through the cache, so a new connection uses the addresses the last check saw. */
  #resolve(host: string): Promise<ResolvedAddress[]> {
    const ttl = this.#deps.limits.dnsCacheMs;
    const now = Date.now();
    const hit = this.#resolved.get(host);
    if (hit && now - hit.at < ttl) return hit.addresses;
    const addresses = this.#deps.resolver(host).then((list) => {
      if (list.length === 0) throw new TypeError(`fetch failed: ${host} has no addresses`);
      return list;
    });
    if (ttl > 0) {
      this.#resolved.set(host, { at: now, addresses });
      addresses.catch(() => this.#resolved.delete(host));
    }
    return addresses;
  }

  #lookupFor(scheme: Scheme): LookupFunction {
    return (hostname, options, cb) => {
      const host = normalizeHost(hostname);
      this.#resolve(host).then(
        (all) => {
          const reason = addressRefusal(host, all, scheme, this.policy);
          if (reason) {
            cb(new RefusedError(`Sling refused the request: ${reason}`), "", 0);
            return;
          }
          const f = options.family;
          const family = f === 4 || f === "IPv4" ? 4 : f === 6 || f === "IPv6" ? 6 : 0;
          const list = family ? all.filter((a) => a.family === family) : all;
          const first = list[0];
          if (!first) {
            cb(new TypeError(`fetch failed: ${host} has no IPv${family} address`), "", 0);
            return;
          }
          if (options.all)
            (cb as unknown as (e: null, list: ResolvedAddress[]) => void)(null, list);
          else cb(null, first.address, first.family);
        },
        (err: unknown) => cb(err instanceof Error ? err : new Error(String(err)), "", 0),
      );
    };
  }

  /**
   * Checks a URL against every rule before connecting. Throws a RefusedError
   * saying why when it isn't allowed. `context` names what is refused.
   */
  async check(raw: string, context = "the request"): Promise<URL> {
    const refuse = (reason: string): never => {
      const message = `Sling refused ${context}: ${reason}`;
      this.#deps.refused(message);
      throw new RefusedError(message);
    };
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return refuse(`${raw} isn't a valid URL`);
    }
    const scheme = schemeOf(url.protocol);
    if (!scheme) return refuse(`${url.protocol} URLs aren't allowed, only https and wss`);
    if (url.username || url.password)
      return refuse("URLs with a user name or password aren't allowed");
    const host = normalizeHost(url.hostname);
    if (!hostAllowed(host, this.policy)) {
      return refuse(`${host} isn't in this extension's network permissions`);
    }
    if (scheme === "http" && !this.policy.localNetwork) {
      return refuse(`${url.origin} uses plain ${url.protocol.slice(0, -1)}. Use https`);
    }
    const family = isIP(host);
    let addresses: ResolvedAddress[];
    if (family) addresses = [{ address: host, family: family === 6 ? 6 : 4 }];
    else {
      try {
        addresses = await this.#resolve(host);
      } catch (err) {
        throw err instanceof TypeError
          ? err
          : new TypeError(`fetch failed: couldn't resolve ${host}`, { cause: err });
      }
    }
    const reason = addressRefusal(host, addresses, scheme, this.policy);
    if (reason) return refuse(reason);
    return url;
  }

  /** Makes an HTTP request for the extension, following redirects itself. */
  async fetch(req: BrokeredRequest, signal?: AbortSignal): Promise<BrokeredResponse> {
    if (this.#closed) throw new TypeError("fetch failed: the extension stopped");
    const limits = this.#deps.limits;
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (req.body && req.body.byteLength > limits.maxBodyBytes) {
      const message = `Sling refused the request: its body is over ${megabytes(limits.maxBodyBytes)}`;
      this.#deps.refused(message);
      throw new RefusedError(message);
    }
    let method = req.method.toUpperCase();
    let body: Uint8Array | null = method === "GET" || method === "HEAD" ? null : req.body;
    let headers = req.headers.filter(([k]) => !DROPPED_REQUEST_HEADERS.has(k.toLowerCase()));
    let current = await this.check(req.url);
    let redirected = false;
    try {
      for (let hop = 0; ; hop++) {
        const res = await undiciFetch(current, {
          method,
          headers,
          body,
          redirect: "manual",
          signal: combined,
          dispatcher: this.#agent as Dispatcher,
        });
        const location = res.headers.get("location");
        if (req.redirect === "manual" || !REDIRECT_STATUS.has(res.status) || location === null) {
          return {
            status: res.status,
            statusText: res.statusText,
            headers: [...res.headers],
            url: current.href,
            redirected,
            body: await this.#readBody(res.body, combined),
          };
        }
        await res.body?.cancel().catch(() => {});
        if (req.redirect === "error") {
          throw new TypeError(`fetch failed: ${current.href} redirected, and redirects are off`);
        }
        if (hop >= limits.maxRedirects) {
          const message = `Sling refused the request: more than ${limits.maxRedirects} redirects`;
          this.#deps.refused(message);
          throw new RefusedError(message);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new TypeError(`fetch failed: invalid redirect location ${location}`);
        }
        next = await this.check(next.href, `a redirect to ${next.href}`);
        if (
          res.status === 303
            ? method !== "HEAD"
            : (res.status === 301 || res.status === 302) && method === "POST"
        ) {
          method = "GET";
          body = null;
          headers = headers.filter(([k]) => !k.toLowerCase().startsWith("content-"));
        }
        if (next.origin !== current.origin) {
          headers = headers.filter(([k]) => !CROSS_ORIGIN_DROPPED.has(k.toLowerCase()));
        }
        current = next;
        redirected = true;
      }
    } catch (err) {
      throw this.#failure(err, signal, timeout);
    }
  }

  async #readBody(
    stream: ReadableStream<Uint8Array> | null,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> {
    if (!stream) return null;
    const max = this.#deps.limits.maxBodyBytes;
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        const message = `Sling stopped the response: its body is over ${megabytes(max)}`;
        this.#deps.refused(message);
        throw new RefusedError(message);
      }
      parts.push(value);
    }
    if (parts.length === 1) return parts[0] as Uint8Array;
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  }

  /** The error the extension sees for a failed request. */
  #failure(err: unknown, signal: AbortSignal | undefined, timeout: AbortSignal): unknown {
    if (signal?.aborted) return signal.reason;
    if (err instanceof RefusedError) return err;
    const cause = (err as { cause?: unknown })?.cause;
    if (cause instanceof RefusedError) {
      this.#deps.refused(cause.message);
      return cause;
    }
    if (timeout.aborted) {
      return new TypeError(
        `fetch failed: no answer within ${seconds(this.#deps.limits.timeoutMs)}`,
      );
    }
    if (err instanceof TypeError && err.message !== "fetch failed") return err;
    const detail = cause instanceof Error ? cause.message : err instanceof Error ? err.message : "";
    return new TypeError(detail ? `fetch failed: ${detail}` : "fetch failed");
  }

  /**
   * Opens a WebSocket for the extension. Resolves once it's open; rejects
   * with the reason when it's refused or fails to connect.
   */
  async openSocket(
    rawUrl: string,
    protocols: string[],
    events: SocketEvents,
    signal?: AbortSignal,
  ): Promise<RelaySocket> {
    const limits = this.#deps.limits;
    if (this.#closed) throw new TypeError("The extension stopped");
    if (this.openSockets >= limits.maxSockets) {
      const message = `Sling refused the connection: this extension already has ${limits.maxSockets} sockets open`;
      this.#deps.refused(message);
      throw new RefusedError(message);
    }
    this.#opening++;
    let url: URL;
    try {
      url = await this.check(rawUrl, "the connection");
    } catch (err) {
      this.#opening--;
      throw err;
    }
    signal?.throwIfAborted();
    return await new Promise<RelaySocket>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, { protocols, dispatcher: this.#agent as Dispatcher });
      } catch (err) {
        this.#opening--;
        reject(err instanceof Error ? new TypeError(err.message) : err);
        return;
      }
      ws.binaryType = "arraybuffer";
      let open = false;
      let lastError: string | null = null;
      const onAbort = () => ws.close();
      signal?.addEventListener("abort", onAbort, { once: true });
      ws.addEventListener("open", () => {
        open = true;
        this.#opening--;
        signal?.removeEventListener("abort", onAbort);
        if (this.#closed) {
          ws.close(1000, "The extension stopped");
          reject(new TypeError("The extension stopped"));
          return;
        }
        this.#sockets.add(ws);
        resolve({
          protocol: ws.protocol,
          extensions: ws.extensions,
          send: (data) => {
            const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
            if (size > limits.maxSocketMessageBytes) {
              const message = `Sling refused to send the message: it's over ${megabytes(limits.maxSocketMessageBytes)}`;
              this.#deps.refused(message);
              events.error(message);
              ws.close(1000, "Message too big");
              return;
            }
            if (ws.readyState === WebSocket.OPEN) ws.send(data);
          },
          close: (code, reason) => {
            // Only the codes an application may send; anything else closes without one.
            const valid = code === 1000 || (code !== undefined && code >= 3000 && code <= 4999);
            try {
              if (valid) ws.close(code, reason?.slice(0, 120));
              else ws.close();
            } catch {
              ws.close();
            }
          },
        });
      });
      ws.addEventListener("message", (ev) => {
        const data = ev.data as string | ArrayBuffer;
        events.message(typeof data === "string" ? data : new Uint8Array(data));
      });
      ws.addEventListener("error", (ev) => {
        const e = ev as Event & { message?: string; error?: unknown };
        const cause = (e.error as { cause?: unknown })?.cause ?? e.error;
        lastError =
          cause instanceof RefusedError
            ? cause.message
            : e.message ||
              (cause instanceof Error ? cause.message : "") ||
              "The connection closed unexpectedly";
        if (cause instanceof RefusedError) this.#deps.refused(cause.message);
        if (open) events.error(lastError);
      });
      ws.addEventListener("close", (ev) => {
        signal?.removeEventListener("abort", onAbort);
        if (!open) {
          this.#opening--;
          reject(
            signal?.aborted
              ? signal.reason
              : new TypeError(lastError ?? `The connection to ${url.host} failed`),
          );
          return;
        }
        this.#sockets.delete(ws);
        if (ev.code === 1009) {
          events.error(`The server sent a message over ${megabytes(limits.maxSocketMessageBytes)}`);
        }
        events.closed(ev.code, ev.reason, ev.wasClean);
      });
    });
  }

  /** Closes every socket and connection. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const ws of this.#sockets) ws.close(1000, "The extension stopped");
    this.#sockets.clear();
    this.#deps.closed();
    await this.#agent.destroy().catch(() => {});
  }
}
