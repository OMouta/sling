import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionOfRequest, callHook, ciGate, githubPull, mergeOnGitHub } from "./steps.ts";

let server: Server;
let base = "";
const calls: { method: string; path: string; headers: IncomingMessage["headers"]; body: string }[] =
  [];

/** A pull request on the fake GitHub, as its API shows it. */
const pulls = new Map<
  number,
  { state: string; merged: boolean; merge_commit_sha: string | null; head: string; base: string }
>();

async function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const path = req.url ?? "/";
  calls.push({ method: req.method ?? "", path, headers: req.headers, body });
  const json = (status: number, value: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  };
  if (path === "/hook/ok") return res.end("queued build 42");
  if (path === "/hook/fail") {
    res.statusCode = 503;
    return res.end(`busy, try ${base}/hook/fail later`);
  }
  if (path === "/hook/slow") return void setTimeout(() => res.end("late"), 500);
  const m = /^\/api\/repos\/acme\/site\/pulls\/(\d+)(\/merge)?$/.exec(path);
  const pr = m ? pulls.get(Number(m[1])) : undefined;
  if (!m || !pr) return json(404, { message: "Not Found" });
  if (req.headers.authorization !== "Bearer ghp_test")
    return json(401, { message: "Bad credentials" });
  if (!m[2]) {
    return json(200, {
      state: pr.state,
      merged: pr.merged,
      merge_commit_sha: pr.merge_commit_sha,
      head: { ref: pr.head },
      base: { ref: pr.base },
    });
  }
  const wanted = JSON.parse(body) as { merge_method: string; sha?: string };
  if (wanted.sha && wanted.sha !== "c0ffee0000000000000000000000000000000000") {
    return json(409, { message: "Head branch was modified. Review and try the merge again." });
  }
  pr.merged = true;
  pr.state = "closed";
  pr.merge_commit_sha = "feedface00000000000000000000000000000000";
  return json(200, {
    sha: pr.merge_commit_sha,
    merged: true,
    message: "Pull Request successfully merged",
  });
}

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

describe("pull request URLs and request IDs", () => {
  it("reads a github.com pull request URL and nothing else", () => {
    expect(githubPull("https://github.com/acme/site/pull/12")).toEqual({
      owner: "acme",
      repo: "site",
      number: 12,
    });
    expect(githubPull("https://github.com/acme/site/compare/main...x")).toBeNull();
    expect(githubPull("https://gitlab.com/acme/site/pull/12")).toBeNull();
    expect(githubPull(null)).toBeNull();
  });

  it("finds the step a request belongs to", () => {
    expect(actionOfRequest("act_01abc.9f3e2a1b")).toBe("act_01abc");
  });
});

describe("merging through GitHub", () => {
  const opts = (number: number, extra: Partial<Parameters<typeof mergeOnGitHub>[0]> = {}) => ({
    api: `${base}/api`,
    token: "ghp_test",
    owner: "acme",
    repo: "site",
    number,
    branch: "sling/abc123-fix",
    base: "main",
    method: "squash" as const,
    headSha: "c0ffee0000000000000000000000000000000000",
    ...extra,
  });

  it("merges with the target's method and the task's commit, and answers the merge commit", async () => {
    pulls.set(1, {
      state: "open",
      merged: false,
      merge_commit_sha: null,
      head: "sling/abc123-fix",
      base: "main",
    });
    calls.length = 0;
    const r = await mergeOnGitHub(opts(1));
    expect(r).toEqual({
      outcome: "succeeded",
      sha: "feedface00000000000000000000000000000000",
      message: "Merged on GitHub (squash).",
    });
    const put = calls.find((c) => c.method === "PUT");
    expect(JSON.parse(put?.body ?? "{}")).toEqual({
      merge_method: "squash",
      sha: "c0ffee0000000000000000000000000000000000",
    });
    expect(put?.headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("answers an already merged PR with its merge commit, so asking twice is safe", async () => {
    calls.length = 0;
    const r = await mergeOnGitHub(opts(1));
    expect(r).toMatchObject({
      outcome: "succeeded",
      sha: "feedface00000000000000000000000000000000",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("refuses a PR whose head or base isn't the task's", async () => {
    pulls.set(2, {
      state: "open",
      merged: false,
      merge_commit_sha: null,
      head: "feature/x",
      base: "main",
    });
    expect(await mergeOnGitHub(opts(2))).toMatchObject({ outcome: "refused", sha: null });
    pulls.set(3, {
      state: "open",
      merged: false,
      merge_commit_sha: null,
      head: "sling/abc123-fix",
      base: "release",
    });
    expect((await mergeOnGitHub(opts(3))).message).toBe(
      "The pull request goes into release, not the default branch main.",
    );
  });

  it("fails with GitHub's reason when the head moved, or the token is wrong", async () => {
    pulls.set(4, {
      state: "open",
      merged: false,
      merge_commit_sha: null,
      head: "sling/abc123-fix",
      base: "main",
    });
    expect(
      await mergeOnGitHub(opts(4, { headSha: "1111111111111111111111111111111111111111" })),
    ).toEqual({
      outcome: "failed",
      sha: null,
      message:
        "GitHub wouldn't merge it (409): Head branch was modified. Review and try the merge again.",
    });
    expect(await mergeOnGitHub(opts(4, { token: "nope" }))).toEqual({
      outcome: "failed",
      sha: null,
      message: "GitHub answered 401: Bad credentials",
    });
  });
});

describe("deploy hooks", () => {
  it("counts a 2xx as taken, with the start of the answer, and sends the header", async () => {
    calls.length = 0;
    const r = await callHook({
      url: `${base}/hook/ok`,
      httpMethod: "POST",
      headerName: "X-Deploy-Token",
      headerValue: "hunter22-secret",
    });
    expect(r).toEqual({ ok: true, message: "The deploy hook accepted it (200): queued build 42" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/hook/ok" });
    expect(calls[0]?.headers["x-deploy-token"]).toBe("hunter22-secret");
  });

  it("fails on anything else, without repeating the hook's URL", async () => {
    const r = await callHook({ url: `${base}/hook/fail`, httpMethod: "GET" });
    expect(r).toEqual({
      ok: false,
      message: "The deploy hook answered 503: busy, try [hidden] later",
    });
  });

  it("gives up after its timeout and says the outcome is unknown", async () => {
    const r = await callHook({ url: `${base}/hook/slow`, httpMethod: "POST" }, 100);
    expect(r).toEqual({
      ok: false,
      message:
        "The deploy hook didn't answer within 0 s, so Sling can't tell whether a deploy started.",
    });
  });
});

describe("ciGate", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const min = (n: number) => new Date(now.getTime() + n * 60_000);
  const merge = min(-60);
  const check = (state: "passed" | "failed" | "waiting" | "unchecked", message: string) => ({
    state,
    message,
    checkedAt: min(-1),
    giveUpAt: min(10),
  });

  it("merges once CI passed, or when the PR has no CI", () => {
    expect(ciGate(check("passed", "CI passed: 3 checks"), merge, now)).toEqual({ kind: "merge" });
    expect(ciGate(check("unchecked", "No CI ran on this PR"), merge, now)).toEqual({
      kind: "merge",
    });
  });

  it("waits while CI runs, or before the check has started", () => {
    expect(ciGate(check("waiting", "CI running: 1 of 3 checks done"), merge, now)).toEqual({
      kind: "wait",
      message: "CI running: 1 of 3 checks done. Merging once it passes.",
    });
    expect(ciGate(null, merge, now)).toEqual({
      kind: "wait",
      message: "Waiting for CI before merging.",
    });
  });

  it("stops on failed CI, and on CI that didn't finish in time", () => {
    expect(ciGate(check("failed", "CI failed: lint (1 of 3)"), merge, now)).toEqual({
      kind: "fail",
      message: "CI failed: lint (1 of 3). The PR wasn't merged.",
    });
    const gaveUp = {
      state: "unchecked" as const,
      message: "CI running: 1 of 3 checks done. Sling stopped checking after 30 min.",
      checkedAt: min(-5),
      giveUpAt: min(-5),
    };
    expect(ciGate(gaveUp, merge, now)).toEqual({
      kind: "fail",
      message:
        "CI running: 1 of 3 checks done. Sling stopped checking after 30 min. The PR wasn't merged.",
    });
    // Its job was lost, and the time is up.
    expect(ciGate({ ...check("waiting", "CI running"), giveUpAt: min(-1) }, merge, now)).toEqual({
      kind: "wait",
      message: "CI running. Merging once it passes.",
    });
    expect(ciGate({ ...check("waiting", "CI running"), giveUpAt: min(-3) }, merge, now)).toEqual({
      kind: "fail",
      message: "CI didn't finish in time. The PR wasn't merged.",
    });
    // A check that gave up before a later deploy asked is run again.
    expect(ciGate(gaveUp, min(-1), now)).toEqual({ kind: "recheck" });
  });
});
