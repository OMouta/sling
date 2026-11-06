import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createSecureServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  type BrokerSession,
  classifyAddress,
  hostAllowed,
  NetworkBroker,
  type NetworkPolicy,
  RefusedError,
  type ResolvedAddress,
  type Resolver,
} from "./broker.ts";

function policy(p: Partial<NetworkPolicy> = {}): NetworkPolicy {
  const configHosts = new Set<string>();
  return {
    extensionId: "acme",
    hosts: [],
    localNetwork: false,
    configHosts: () => configHosts,
    ...p,
  };
}

/** Resolves names from a table; anything else fails like an unknown name. */
function table(entries: Record<string, string | string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (host: string): Promise<ResolvedAddress[]> => {
    calls.push(host);
    const v = entries[host];
    if (!v) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return (Array.isArray(v) ? v : [v]).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  };
  return Object.assign(fn, { calls });
}

describe("address classes", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["93.184.216.34", "public"],
    ["2606:4700:4700::1111", "public"],
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["::1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link-local"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["100.64.0.1", "cgnat"],
    ["100.127.255.255", "cgnat"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["224.0.0.1", "multicast"],
    ["ff02::1", "multicast"],
    ["255.255.255.255", "reserved"],
    // IPv4-mapped and other IPv6 forms that carry an IPv4 address.
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:a00:1", "private"],
    ["::ffff:169.254.169.254", "link-local"],
    ["::ffff:100.64.0.1", "cgnat"],
    ["::ffff:0.0.0.0", "unspecified"],
    ["::ffff:192.168.0.1", "private"],
    ["::ffff:8.8.8.8", "public"],
    ["0:0:0:0:0:ffff:127.0.0.1", "loopback"],
    ["::127.0.0.1", "loopback"],
    ["::ffff:0:127.0.0.1", "loopback"],
    ["64:ff9b::10.0.0.1", "private"],
    ["64:ff9b::8.8.8.8", "public"],
    ["2002:7f00:1::1", "loopback"],
    ["2002:0a00:0001::", "private"],
    ["[::1]", "loopback"],
    ["fe80::1%en0", "link-local"],
  ])("%s is %s", (address, cls) => {
    expect(classifyAddress(address)).toBe(cls);
  });

  it("treats something that isn't an address as reserved", () => {
    expect(classifyAddress("not-an-ip")).toBe("reserved");
    expect(classifyAddress("1.2.3")).toBe("reserved");
    expect(classifyAddress("1::2::3")).toBe("reserved");
  });
});

describe("host rules", () => {
  it("matches exact hosts, wildcards with their apex, and config hosts", () => {
    const cfg = new Set(["ntfy.example.org"]);
    const p = policy({ hosts: ["api.acme.test", "*.cdn.test"], configHosts: () => cfg });
    expect(hostAllowed("api.acme.test", p)).toBe(true);
    expect(hostAllowed("API.ACME.TEST.", p)).toBe(true);
    expect(hostAllowed("www.api.acme.test", p)).toBe(false);
    expect(hostAllowed("cdn.test", p)).toBe(true);
    expect(hostAllowed("a.b.cdn.test", p)).toBe(true);
    expect(hostAllowed("evilcdn.test", p)).toBe(false);
    expect(hostAllowed("ntfy.example.org", p)).toBe(true);
    expect(hostAllowed("example.org", p)).toBe(false);
  });
});

// ----------------------------------------------------------------- live

let server: Server;
let port: number;
let connections = 0;
const requests: { url: string; host: string; headers: IncomingMessage["headers"] }[] = [];

function handle(req: IncomingMessage, res: ServerResponse) {
  requests.push({ url: req.url ?? "", host: req.headers.host ?? "", headers: req.headers });
  const url = new URL(req.url ?? "/", "http://x");
  const to = url.searchParams.get("to");
  if (url.pathname === "/redirect" && to) {
    res.writeHead(Number(url.searchParams.get("status") ?? 302), { location: to });
    res.end();
    return;
  }
  if (url.pathname === "/loop") {
    res.writeHead(302, { location: "/loop" });
    res.end();
    return;
  }
  if (url.pathname === "/big") {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.alloc(10 * 1024 * 1024 + 1, 1));
    return;
  }
  if (url.pathname === "/hang") return;
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] });
    res.end(
      JSON.stringify({
        method: req.method,
        path: req.url,
        host: req.headers.host,
        auth: req.headers.authorization ?? null,
        body: Buffer.concat(chunks).toString(),
      }),
    );
  });
}

let wss: WebSocketServer;

beforeAll(async () => {
  server = createServer(handle);
  server.on("connection", () => connections++);
  wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });
  wss.on("connection", (socket, req) => {
    socket.on("message", (data, isBinary) => {
      const text = isBinary ? null : data.toString();
      if (text === "big") socket.send(Buffer.alloc(1024 * 1024 + 1));
      else if (text === "close") socket.close(4000, "bye");
      else socket.send(data, { binary: isBinary });
    });
    socket.send(`hello ${req.headers["sec-websocket-protocol"] ?? ""}`.trim());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const c of wss.clients) c.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const LOCAL = {
  "api.acme.test": "127.0.0.1",
  "x.cdn.test": "127.0.0.1",
  "cfg.example.test": "127.0.0.1",
  "api.evil.test": "127.0.0.1",
  "public.acme.test": "93.184.216.34",
  "private.acme.test": "10.0.0.5",
  "mixed.acme.test": ["93.184.216.34", "10.0.0.5"],
  "mapped.acme.test": "::ffff:127.0.0.1",
};

function brokerWith(resolver: Resolver, opts: { dnsCacheMs?: number; timeoutMs?: number } = {}) {
  const refusals: string[] = [];
  const broker = new NetworkBroker({
    resolver,
    onRefusal: (_p, m) => refusals.push(m),
    ...opts,
  });
  return { broker, refusals };
}

async function get(
  s: BrokerSession,
  url: string,
  init: Partial<Parameters<BrokerSession["fetch"]>[0]> = {},
  signal?: AbortSignal,
) {
  return s.fetch(
    { url, method: "GET", headers: [], body: null, redirect: "follow", ...init },
    signal,
  );
}

function json(body: Uint8Array | null) {
  return JSON.parse(Buffer.from(body ?? new Uint8Array()).toString());
}

describe("brokered fetch", () => {
  const local = policy({ hosts: ["api.acme.test", "*.cdn.test"], localNetwork: true });

  it("reaches an allowed host, at the address it checked, with the original Host header", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(local);
    const res = await get(s, `http://api.acme.test:${port}/hello`, {
      headers: [
        ["x-test", "1"],
        ["host", "other.test"],
      ],
    });
    expect(res.status).toBe(200);
    expect(json(res.body)).toMatchObject({ path: "/hello", host: `api.acme.test:${port}` });
    expect(res.headers.filter(([k]) => k === "set-cookie")).toEqual([
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
    ]);
    expect(res.redirected).toBe(false);
    await s.close();
  });

  it("allows wildcard hosts and hosts from installation config", async () => {
    const cfg = new Set(["cfg.example.test"]);
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session({ ...local, configHosts: () => cfg });
    expect((await get(s, `http://x.cdn.test:${port}/w`)).status).toBe(200);
    expect((await get(s, `http://cfg.example.test:${port}/c`)).status).toBe(200);
    await s.close();
  });

  it("refuses a host the extension didn't declare, and says why", async () => {
    const { broker, refusals } = brokerWith(table(LOCAL));
    const s = broker.session(local);
    await expect(get(s, `http://api.evil.test:${port}/`)).rejects.toThrow(
      new RefusedError(
        "Sling refused the request: api.evil.test isn't in this extension's network permissions",
      ),
    );
    expect(refusals).toHaveLength(1);
    await s.close();
  });

  it("refuses plain http to a public name", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const strict = broker.session(policy({ hosts: ["public.acme.test"] }));
    await expect(get(strict, "http://public.acme.test/")).rejects.toThrow(
      "Sling refused the request: http://public.acme.test uses plain http. Use https",
    );
    const withLocal = broker.session(policy({ hosts: ["public.acme.test"], localNetwork: true }));
    await expect(get(withLocal, "http://public.acme.test/")).rejects.toThrow(
      "Sling refused the request: plain http only reaches local network addresses, and public.acme.test resolves to 93.184.216.34, a public address. Use https",
    );
    await strict.close();
    await withLocal.close();
  });

  it("refuses a declared name that resolves to a private address without localNetwork", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(
      policy({
        hosts: ["private.acme.test", "mixed.acme.test", "mapped.acme.test", "api.acme.test"],
      }),
    );
    await expect(get(s, "https://private.acme.test/")).rejects.toThrow(
      "Sling refused the request: private.acme.test resolves to 10.0.0.5, a private address, and this extension can't reach the local network",
    );
    await expect(get(s, "https://mixed.acme.test/")).rejects.toThrow("resolves to 10.0.0.5");
    await expect(get(s, "https://mapped.acme.test/")).rejects.toThrow(
      "resolves to ::ffff:127.0.0.1, a loopback address",
    );
    await expect(get(s, `https://api.acme.test:${port}/`)).rejects.toThrow(
      "resolves to 127.0.0.1, a loopback address",
    );
    await s.close();
  });

  it("refuses literal private addresses without localNetwork", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(policy({ hosts: ["127.0.0.1", "169.254.169.254"] }));
    await expect(get(s, `https://127.0.0.1:${port}/`)).rejects.toThrow(
      "Sling refused the request: 127.0.0.1, a loopback address",
    );
    await expect(get(s, "https://169.254.169.254/latest/meta-data")).rejects.toThrow("link-local");
    await expect(get(s, "https://[::ffff:7f00:1]/")).rejects.toThrow(
      "isn't in this extension's network permissions",
    );
    await s.close();
  });

  it("follows redirects between allowed hosts and checks every hop", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(local);
    const to = encodeURIComponent(`http://x.cdn.test:${port}/landed`);
    const res = await get(s, `http://api.acme.test:${port}/redirect?to=${to}`, {
      headers: [["authorization", "Bearer secret"]],
    });
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    expect(res.url).toBe(`http://x.cdn.test:${port}/landed`);
    // Credentials don't follow a redirect to another origin.
    expect(json(res.body)).toMatchObject({ path: "/landed", auth: null });

    const manual = await get(s, `http://api.acme.test:${port}/redirect?to=${to}`, {
      redirect: "manual",
    });
    expect(manual.status).toBe(302);
    expect(manual.headers).toContainEqual(["location", `http://x.cdn.test:${port}/landed`]);
    await s.close();
  });

  it("refuses a redirect to an undeclared host", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(local);
    const before = requests.length;
    const to = encodeURIComponent(`http://api.evil.test:${port}/steal`);
    await expect(get(s, `http://api.acme.test:${port}/redirect?to=${to}`)).rejects.toThrow(
      `Sling refused a redirect to http://api.evil.test:${port}/steal: api.evil.test isn't in this extension's network permissions`,
    );
    expect(requests.slice(before).map((r) => r.url)).not.toContain("/steal");
    await s.close();
  });

  it("refuses a redirect to a private address and stops after five redirects", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(local);
    await expect(get(s, `http://api.acme.test:${port}/loop`)).rejects.toThrow(
      "Sling refused the request: more than 5 redirects",
    );
    await s.close();
  });

  it("connects to the address it checked when the name's answer changes", async () => {
    let n = 0;
    const flipping: Resolver = async () => {
      n++;
      // A public answer for the check, then loopback for anyone who asks again.
      return [{ address: n === 1 ? "192.0.2.10" : "127.0.0.1", family: 4 }];
    };
    const before = connections;

    const cached = brokerWith(flipping).broker.session(policy({ hosts: ["rebind.acme.test"] }));
    await expect(
      get(cached, `https://rebind.acme.test:${port}/`, {}, AbortSignal.timeout(300)),
    ).rejects.toThrow();
    expect(n).toBe(1);
    await cached.close();

    n = 0;
    const fresh = brokerWith(flipping, { dnsCacheMs: 0 }).broker.session(
      policy({ hosts: ["rebind.acme.test"] }),
    );
    await expect(get(fresh, `https://rebind.acme.test:${port}/`)).rejects.toThrow(
      "Sling refused the request: rebind.acme.test resolves to 127.0.0.1, a loopback address",
    );
    expect(n).toBe(2);
    await fresh.close();
    expect(connections).toBe(before);
  });

  it("caps request and response bodies at 10 MB", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(local);
    await expect(
      get(s, `http://api.acme.test:${port}/echo`, {
        method: "POST",
        body: new Uint8Array(10 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow("Sling refused the request: its body is over 10 MB");
    await expect(get(s, `http://api.acme.test:${port}/big`)).rejects.toThrow(
      "Sling stopped the response: its body is over 10 MB",
    );
    const ok = await get(s, `http://api.acme.test:${port}/echo`, {
      method: "POST",
      body: new TextEncoder().encode("hi"),
    });
    expect(json(ok.body)).toMatchObject({ method: "POST", body: "hi" });
    await s.close();
  });

  it("times out, and honors the extension's own signal", async () => {
    const { broker } = brokerWith(table(LOCAL), { timeoutMs: 200 });
    const s = broker.session(local);
    await expect(get(s, `http://api.acme.test:${port}/hang`)).rejects.toThrow(
      "fetch failed: no answer within 0.2 seconds",
    );
    const abort = new AbortController();
    const pending = get(s, `http://api.acme.test:${port}/hang`, {}, abort.signal);
    setTimeout(() => abort.abort(new Error("stop")), 20);
    await expect(pending).rejects.toThrow("stop");
    await s.close();
  });

  it("reports a name that doesn't resolve as a failed fetch", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(policy({ hosts: ["nowhere.acme.test"] }));
    await expect(get(s, "https://nowhere.acme.test/")).rejects.toThrow(TypeError);
    await s.close();
  });
});

describe("brokered WebSocket", () => {
  const local = policy({ hosts: ["api.acme.test"], localNetwork: true });

  function collect() {
    const got: (string | number[])[] = [];
    const closed: [number, string][] = [];
    const errors: string[] = [];
    return {
      got,
      closed,
      errors,
      events: {
        message: (d: string | Uint8Array) => got.push(typeof d === "string" ? d : [...d]),
        closed: (code: number, reason: string) => closed.push([code, reason]),
        error: (m: string) => errors.push(m),
      },
    };
  }

  async function until(fn: () => boolean) {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  }

  it("relays text and binary messages both ways", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(local);
    const c = collect();
    const ws = await s.openSocket(`ws://api.acme.test:${port}/`, ["chat"], c.events);
    expect(ws.protocol).toBe("chat");
    ws.send("ping");
    ws.send(new Uint8Array([1, 2, 3]));
    await until(() => c.got.length >= 3);
    expect(c.got).toEqual(["hello chat", "ping", [1, 2, 3]]);
    ws.send("close");
    await until(() => c.closed.length > 0);
    expect(c.closed).toEqual([[4000, "bye"]]);
    expect(s.openSockets).toBe(0);
    await s.close();
  });

  it("opens wss sockets over HTTP/1.1 on servers that also speak HTTP/2", async () => {
    // Like ntfy.sh: HTTP/2 is offered, but WebSocket upgrades work only over HTTP/1.1.
    const dir = mkdtempSync(join(tmpdir(), "broker-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=api.acme.test",
        "-addext",
        "subjectAltName=DNS:api.acme.test",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    const cert = readFileSync(join(dir, "cert.pem"));
    const tlsServer = createSecureServer({
      key: readFileSync(join(dir, "key.pem")),
      cert,
      allowHTTP1: true,
    });
    tlsServer.on("request", (_req, res) => res.end("ok"));
    const tlsWss = new WebSocketServer({ noServer: true });
    tlsServer.on("upgrade", (req, socket, head) => {
      tlsWss.handleUpgrade(req, socket, head, (ws) => ws.send("over tls"));
    });
    await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
    const tlsPort = (tlsServer.address() as AddressInfo).port;
    try {
      const broker = new NetworkBroker({ resolver: table(LOCAL), tls: { ca: cert } });
      const s = broker.session(local);
      const c = collect();
      const ws = await s.openSocket(`wss://api.acme.test:${tlsPort}/`, [], c.events);
      await until(() => c.got.length > 0);
      expect(c.got).toEqual(["over tls"]);
      ws.close(1000);
      // fetch keeps HTTP/2 on the same server.
      const res = await get(s, `https://api.acme.test:${tlsPort}/`);
      expect(res.status).toBe(200);
      await s.close();
    } finally {
      for (const client of tlsWss.clients) client.terminate();
      tlsWss.close();
      await new Promise((r) => tlsServer.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses sockets to undeclared hosts and plain ws without localNetwork", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(policy({ hosts: ["api.acme.test"] }));
    await expect(
      s.openSocket(`wss://api.evil.test:${port}/`, [], collect().events),
    ).rejects.toThrow(
      "Sling refused the connection: api.evil.test isn't in this extension's network permissions",
    );
    await expect(s.openSocket(`ws://api.acme.test:${port}/`, [], collect().events)).rejects.toThrow(
      "uses plain ws. Use https",
    );
    await expect(
      s.openSocket(`wss://api.acme.test:${port}/`, [], collect().events),
    ).rejects.toThrow("a loopback address");
    expect(s.openSockets).toBe(0);
    await s.close();
  });

  it("caps messages at 1 MB in both directions", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(local);
    const c = collect();
    const ws = await s.openSocket(`ws://api.acme.test:${port}/`, [], c.events);
    ws.send(new Uint8Array(1024 * 1024 + 1));
    await until(() => c.closed.length > 0);
    expect(c.errors[0]).toBe("Sling refused to send the message: it's over 1 MB");

    const d = collect();
    const ws2 = await s.openSocket(`ws://api.acme.test:${port}/`, [], d.events);
    ws2.send("big");
    await until(() => d.closed.length > 0);
    // The relay drops the connection instead of passing the message on.
    expect(d.closed[0]?.[0]).toBe(1006);
    expect(d.got).toEqual(["hello"]);
    expect(d.errors).toHaveLength(1);
    await s.close();
  });

  it("holds at most 16 sockets per extension", async () => {
    const { broker } = brokerWith(table(LOCAL));
    const s = broker.session(local);
    const open: Awaited<ReturnType<BrokerSession["openSocket"]>>[] = [];
    for (let i = 0; i < 16; i++) {
      open.push(await s.openSocket(`ws://api.acme.test:${port}/`, [], collect().events));
    }
    await expect(s.openSocket(`ws://api.acme.test:${port}/`, [], collect().events)).rejects.toThrow(
      "Sling refused the connection: this extension already has 16 sockets open",
    );
    const c = collect();
    open[0]?.close(1000);
    await until(() => s.openSockets === 15);
    const again = await s.openSocket(`ws://api.acme.test:${port}/`, [], c.events);
    expect(again).toBeTruthy();
    await s.close();
  });
});
