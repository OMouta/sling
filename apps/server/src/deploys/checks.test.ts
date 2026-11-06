import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeResult,
  downReason,
  MAX_BODY_BYTES,
  probe,
  runCheck,
  runChecks,
  showsCommit,
  statusMatches,
} from "./checks.ts";

let server: Server;
let base = "";
const seen: IncomingMessage[] = [];

function handle(req: IncomingMessage, res: ServerResponse) {
  seen.push(req);
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  if (path === "/ok") return res.end("all good");
  if (path === "/down") {
    res.statusCode = 500;
    return res.end("boom");
  }
  if (path === "/teapot") {
    res.statusCode = 418;
    return res.end("short and stout");
  }
  if (path === "/hop") {
    const n = Number(url.searchParams.get("n") ?? "0");
    res.statusCode = 302;
    res.setHeader("location", n > 0 ? `/hop?n=${n - 1}` : "/ok");
    return res.end();
  }
  if (path === "/slow") {
    setTimeout(() => res.end("late"), 1000);
    return;
  }
  if (path === "/big") {
    res.write("x".repeat(MAX_BODY_BYTES));
    return res.end("NEEDLE");
  }
  if (path === "/cookie") {
    res.setHeader("set-cookie", "a=1");
    res.statusCode = 302;
    res.setHeader("location", "/echo-cookie");
    return res.end();
  }
  if (path === "/echo-cookie") return res.end(req.headers.cookie ?? "no cookie");
  res.statusCode = 404;
  res.end();
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

describe("status matching", () => {
  it("takes 200 to 399 without a status, and only the status asked for with one", () => {
    expect(statusMatches(200, null)).toBe(true);
    expect(statusMatches(399, undefined)).toBe(true);
    expect(statusMatches(400, null)).toBe(false);
    expect(statusMatches(199, null)).toBe(false);
    expect(statusMatches(418, 418)).toBe(true);
    expect(statusMatches(200, 204)).toBe(false);
  });

  it("finds a commit in full or by its first seven characters", () => {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    expect(showsCommit(`{"commit":"${sha}"}`, sha)).toBe(true);
    expect(showsCommit("deployed ABCDEF1", sha)).toBe(true);
    expect(showsCommit("deployed abcdef0", sha)).toBe(false);
    expect(showsCommit("anything", "abc")).toBe(false);
  });
});

describe("health checks", () => {
  it("passes a page that answers 200 and fails one that answers 500", async () => {
    const [ok, down] = await runChecks([
      { url: `${base}/ok`, status: null, contains: null },
      { url: `${base}/down`, status: null, contains: null },
    ]);
    expect(ok).toMatchObject({ url: `${base}/ok`, ok: true, status: 200, error: null });
    expect(down).toMatchObject({
      ok: false,
      status: 500,
      error: "Expected 200 to 399, got 500",
    });
    expect(ok?.ms).toBeGreaterThanOrEqual(0);
    expect(describeResult(down as never)).toBe(`${base}/down: 500 (Expected 200 to 399, got 500)`);
  });

  it("matches an exact status, and looks for text in the body", async () => {
    expect(await runCheck({ url: `${base}/teapot`, status: 418, contains: "stout" })).toMatchObject(
      {
        ok: true,
        status: 418,
      },
    );
    expect(await runCheck({ url: `${base}/ok`, status: 201, contains: null })).toMatchObject({
      ok: false,
      error: "Expected 201, got 200",
    });
    expect(await runCheck({ url: `${base}/ok`, status: null, contains: "bad" })).toMatchObject({
      ok: false,
      status: 200,
      error: 'The page doesn\'t contain "bad"',
    });
  });

  it("follows up to five redirects and no more", async () => {
    expect(
      await runCheck({ url: `${base}/hop?n=4`, status: null, contains: "good" }),
    ).toMatchObject({ ok: true, status: 200 });
    expect(await runCheck({ url: `${base}/hop?n=5`, status: null, contains: null })).toMatchObject({
      ok: false,
      status: null,
      error: "More than 5 redirects",
    });
  });

  it("reads only the first megabyte", async () => {
    expect(await runCheck({ url: `${base}/big`, status: null, contains: "NEEDLE" })).toMatchObject({
      ok: false,
      error: 'The page doesn\'t contain "NEEDLE"',
    });
  });

  it("gives up after the timeout, and says when nothing listens", async () => {
    const slow = await probe(`${base}/slow`, { readBody: false, timeoutMs: 200 });
    expect(slow).toMatchObject({ ok: false, error: "No answer within 200 ms" });
    const refused = await runCheck({ url: "http://127.0.0.1:1/", status: null, contains: null });
    expect(refused.ok).toBe(false);
    expect(refused.status).toBeNull();
    expect(refused.error).toMatch(/^Couldn't reach it: /);
  });

  it("sends Sling's user agent and never a cookie", async () => {
    seen.length = 0;
    const r = await runCheck({ url: `${base}/cookie`, status: null, contains: "no cookie" });
    expect(r.ok).toBe(true);
    expect(seen.map((s) => s.headers["user-agent"])).toEqual([
      "Sling health check",
      "Sling health check",
    ]);
  });

  it("refuses what isn't http or https", async () => {
    expect(await probe("file:///etc/passwd", { readBody: true })).toMatchObject({
      ok: false,
      error: "Only http and https URLs can be checked",
    });
  });

  it("names why a target is down: the status, or the error when nothing answered", () => {
    const r = (status: number | null, error: string | null) => ({
      url: "u",
      ok: false,
      status,
      ms: 1,
      error,
    });
    expect(downReason([r(502, "Expected 200 to 399, got 502")])).toBe("502");
    expect(downReason([r(null, "No answer within 10 s")])).toBe("No answer within 10 s");
    expect(downReason([r(200, 'The page doesn\'t contain "ok"')])).toBe(
      'The page doesn\'t contain "ok"',
    );
    expect(downReason([])).toBe("");
  });
});
