/**
 * Workflow HTTP's network policy against real sockets on loopback. Names
 * resolve through a stand-in for DNS, so a test can say what a name points
 * at, and change its answer between the check and the connection.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { isIP } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outboundRequest } from "./outbound.ts";

interface Local {
  server: Server;
  port: number;
  hits: IncomingMessage[];
  origin: string;
}

async function local(
  handle?: (req: IncomingMessage) => {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<Local> {
  const hits: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    hits.push(req);
    const out = handle?.(req) ?? { status: 200, body: "from loopback" };
    res.writeHead(out.status, out.headers);
    res.end(out.body ?? "");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return { server, port, hits, origin: `http://127.0.0.1:${port}` };
}

/** DNS as a map. Each name has a list of answers, and later lookups get later ones. */
function dns(names: Record<string, string[][]>) {
  const asked: string[] = [];
  const resolve = async (host: string) => {
    asked.push(host);
    if (isIP(host)) return [{ address: host, family: isIP(host) }];
    const answers = names[host];
    if (!answers)
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    const seen = asked.filter((h) => h === host).length;
    const list = answers[Math.min(seen, answers.length) - 1] ?? [];
    return list.map((address) => ({ address, family: isIP(address) }));
  };
  return { resolve, asked };
}

function get(
  url: string,
  opts: {
    allowed?: string[];
    resolve?: ReturnType<typeof dns>["resolve"];
    headers?: Record<string, string>;
  } = {},
) {
  return outboundRequest(new URL(url), {
    method: "GET",
    headers: new Headers(opts.headers),
    signal: AbortSignal.timeout(5_000),
    allowedOrigins: opts.allowed ?? [],
    resolve: opts.resolve ?? dns({}).resolve,
  });
}

let target: Local;
let redirector: Local;

beforeAll(async () => {
  target = await local();
  redirector = await local((req) => ({
    status: 302,
    headers: { location: decodeURIComponent((req.url ?? "/").slice("/to/".length)) },
  }));
});

afterAll(async () => {
  for (const s of [target, redirector]) await new Promise((ok) => s.server.close(ok));
});

describe("internal destinations", () => {
  it("reaches an internal service only when its exact origin is allowed", async () => {
    const res = await get(`${target.origin}/ok`, { allowed: [target.origin] });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from loopback");
    // The same host on another port is another origin.
    await expect(
      get(`http://127.0.0.1:${redirector.port}/`, { allowed: [target.origin] }),
    ).rejects.toThrow(/network policy/);
  });

  it("refuses loopback by default", async () => {
    const before = target.hits.length;
    await expect(get(`${target.origin}/`)).rejects.toThrow(/network policy/);
    expect(target.hits.length).toBe(before);
  });

  it.each([
    ["decimal", "2130706433"],
    ["octal", "0177.0.0.1"],
    ["hex", "0x7f.0.0.1"],
    ["one hex number", "0x7f000001"],
    ["shortened", "127.1"],
    ["IPv4-mapped IPv6", "[::ffff:127.0.0.1]"],
    ["IPv4-mapped IPv6 in hex", "[::ffff:7f00:1]"],
    ["IPv4-compatible IPv6", "[::127.0.0.1]"],
    ["the unspecified address", "0"],
    ["IPv6 loopback", "[::1]"],
    ["IPv6 unspecified", "[::]"],
  ])("refuses loopback written as %s", async (_form, host) => {
    const before = target.hits.length;
    await expect(get(`http://${host}:${target.port}/`)).rejects.toThrow(/network policy/);
    expect(target.hits.length).toBe(before);
  });

  it.each([
    ["IPv6 link-local", "[fe80::1]"],
    ["IPv6 unique local", "[fd00::1]"],
    ["IPv6 unique local, fc00::/8", "[fc00::1]"],
    ["IPv4 private", "10.0.0.1"],
    ["IPv4 link-local", "169.254.1.1"],
    ["carrier-grade NAT", "100.64.0.1"],
  ])("refuses %s", async (_kind, host) => {
    await expect(get(`http://${host}/`)).rejects.toThrow(/network policy|metadata/);
  });

  it("refuses a name that resolves to loopback, unless that origin is allowed", async () => {
    const names = { "internal.test": [["127.0.0.1"]] };
    await expect(
      get(`http://internal.test:${target.port}/`, { resolve: dns(names).resolve }),
    ).rejects.toThrow(/network policy/);
    // One public answer among private ones doesn't get it through.
    const mixed = { "mixed.test": [["93.184.215.14", "127.0.0.1"]] };
    await expect(
      get(`http://mixed.test:${target.port}/`, { resolve: dns(mixed).resolve }),
    ).rejects.toThrow(/network policy/);
    const res = await get(`http://internal.test:${target.port}/`, {
      resolve: dns(names).resolve,
      allowed: [`http://internal.test:${target.port}`],
    });
    expect(res.status).toBe(200);
  });
});

describe("redirects", () => {
  const via = (to: string) => `${redirector.origin}/to/${encodeURIComponent(to)}`;

  it.each([
    ["loopback", (p: number) => `http://127.0.0.1:${p}/`],
    ["localhost", (p: number) => `http://localhost:${p}/`],
    ["IPv6 loopback", (p: number) => `http://[::1]:${p}/`],
    ["IPv4-mapped loopback", (p: number) => `http://[::ffff:127.0.0.1]:${p}/`],
    ["decimal loopback", (p: number) => `http://2130706433:${p}/`],
    ["the metadata address", () => "http://169.254.169.254/latest/meta-data/"],
  ])("checks a redirect to %s again", async (_kind, to) => {
    const before = target.hits.length;
    const names = dns({ localhost: [["127.0.0.1", "::1"]] });
    await expect(
      get(via(to(target.port)), { allowed: [redirector.origin], resolve: names.resolve }),
    ).rejects.toThrow(/network policy|metadata/);
    expect(target.hits.length).toBe(before);
  });

  it("follows a redirect between allowed origins, without the credentials", async () => {
    const res = await get(via(`${target.origin}/landed`), {
      allowed: [redirector.origin, target.origin],
      headers: { authorization: "Bearer secret", cookie: "a=b", "x-kept": "1" },
    });
    expect(res.status).toBe(200);
    const hit = target.hits.at(-1);
    expect(hit?.url).toBe("/landed");
    expect(hit?.headers.authorization).toBeUndefined();
    expect(hit?.headers.cookie).toBeUndefined();
    expect(hit?.headers["x-kept"]).toBe("1");
  });
});

describe("responses", () => {
  it("stops reading a body over 2 MB", async () => {
    const big = await local(() => ({ status: 200, body: "x".repeat(3 * 1024 * 1024) }));
    try {
      await expect(get(`${big.origin}/`, { allowed: [big.origin] })).rejects.toThrow(
        "HTTP response exceeds 2 MB",
      );
    } finally {
      await new Promise((ok) => big.server.close(ok));
    }
  });
});

describe("a DNS answer that changes", () => {
  it("connects to the address it checked, not to what the name says next", async () => {
    // Checked as the allowed internal service, then the name moves to the metadata address.
    const names = dns({ "rebind.test": [["127.0.0.1"], ["169.254.169.254"]] });
    const before = target.hits.length;
    const res = await get(`http://rebind.test:${target.port}/pinned`, {
      allowed: [`http://rebind.test:${target.port}`],
      resolve: names.resolve,
    });
    expect(res.status).toBe(200);
    expect(target.hits.length).toBe(before + 1);
    expect(names.asked).toEqual(["rebind.test"]);
  });

  it("checks the name again at each redirect hop", async () => {
    // The first hop is fine; by the second the name points at loopback, which isn't allowed.
    const names = dns({ "hop.test": [["127.0.0.1"], ["127.0.0.1"]] });
    await expect(
      get(`${redirector.origin}/to/${encodeURIComponent(`http://hop.test:${target.port}/`)}`, {
        allowed: [redirector.origin],
        resolve: names.resolve,
      }),
    ).rejects.toThrow(/network policy/);
    expect(names.asked).toContain("hop.test");
  });
});

describe("cloud metadata", () => {
  it.each([
    ["AWS, GCP, Azure, and others", "http://169.254.169.254/latest/meta-data/"],
    ["AWS containers", "http://169.254.170.2/v2/credentials"],
    ["AWS pod identity", "http://169.254.170.23/v1/credentials"],
    ["AWS over IPv6", "http://[fd00:ec2::254]/latest/meta-data/"],
    ["GCP over IPv6", "http://[fd20:ce::254]/computeMetadata/v1/"],
    ["Azure's host service", "http://168.63.129.16/machine"],
    ["Alibaba Cloud", "http://100.100.100.200/latest/meta-data/"],
    ["IPv4-mapped", "http://[::ffff:169.254.169.254]/"],
    ["IPv4-mapped in hex", "http://[::ffff:a9fe:a9fe]/"],
    ["NAT64", "http://[64:ff9b::a9fe:a9fe]/"],
    ["6to4", "http://[2002:a9fe:a9fe::1]/"],
    ["decimal", "http://2852039166/"],
  ])("refuses %s even when its origin is allowed", async (_kind, url) => {
    await expect(get(url, { allowed: [new URL(url).origin] })).rejects.toThrow(/metadata/);
  });

  it("refuses a name for it, even when allowed", async () => {
    const names = dns({ "metadata.google.internal": [["169.254.169.254"]] });
    await expect(
      get("http://metadata.google.internal/computeMetadata/v1/", {
        allowed: ["http://metadata.google.internal"],
        resolve: names.resolve,
      }),
    ).rejects.toThrow(/metadata/);
  });
});
