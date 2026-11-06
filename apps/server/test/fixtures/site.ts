/**
 * A site to deploy and check. `/health` answers 200 once the deployed copy of
 * SLING_FAKE.md lists the title it waits for, and 500 until then. `/version`
 * shows the deployed commit. Which copy counts as deployed depends on how the
 * target deploys:
 *
 * - `merge`: the bare repo's default branch, read live, as a host that
 *   deploys on merge would serve it.
 * - `hook`: what the default branch held when `/hook` was last called.
 * - `command`: what the deploy command copied into `deployDir`.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type SiteMode = "merge" | "hook" | "command";

interface Deployed {
  content: string;
  sha: string;
}

export interface HookCall {
  method: string;
  headers: IncomingMessage["headers"];
  /** performance.now() when it arrived and when it answered. */
  receivedAt: number;
  answeredAt: number;
}

export class TestSite {
  mode: SiteMode = "merge";
  /** The title /health waits for. */
  expect = "";
  /** Answers 500 whatever is deployed. */
  down = false;
  /** Makes /status answer 503, for a check that depends on nothing else. */
  statusDown = false;
  /** How long /hook takes to answer. */
  hookDelayMs = 0;
  readonly hookCalls: HookCall[] = [];
  /** What GET /github-version shows, for a target merged through the fake GitHub. */
  githubVersion = "";
  #hooked: Deployed | null = null;
  #server: Server | null = null;
  url = "";

  readonly bare: string;
  readonly deployDir: string;
  readonly branch: string;

  constructor(bare: string, deployDir: string, branch = "main") {
    this.bare = bare;
    this.deployDir = deployDir;
    this.branch = branch;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((ok) => this.#server?.listen(0, "127.0.0.1", ok));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  close(): Promise<void> {
    return new Promise((ok) => {
      this.#server?.closeAllConnections();
      this.#server?.close(() => ok());
    });
  }

  /** The default branch of the bare repo, as it is now. */
  async live(): Promise<Deployed> {
    const git = (...args: string[]) =>
      run("git", ["--git-dir", this.bare, ...args], { encoding: "utf8" }).then((r) => r.stdout);
    const [content, sha] = await Promise.all([
      git("show", `${this.branch}:SLING_FAKE.md`).catch(() => ""),
      git("rev-parse", this.branch).then((s) => s.trim()),
    ]);
    return { content, sha };
  }

  async deployed(): Promise<Deployed> {
    if (this.mode === "merge") return this.live();
    if (this.mode === "hook") return this.#hooked ?? { content: "", sha: "" };
    const [content, sha] = await Promise.all([
      readFile(join(this.deployDir, "SLING_FAKE.md"), "utf8").catch(() => ""),
      readFile(join(this.deployDir, "VERSION"), "utf8").catch(() => ""),
    ]);
    return { content, sha: sha.trim() };
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://site").pathname;
    if (path === "/ok") return res.end("ok");
    if (path === "/status") {
      res.statusCode = this.statusDown ? 503 : 200;
      return res.end(this.statusDown ? "unavailable" : "ok");
    }
    if (path === "/github-version") return res.end(this.githubVersion);
    if (path === "/hook") {
      const receivedAt = performance.now();
      for await (const _ of req) {
        // Drain the body; hooks get none.
      }
      this.#hooked = await this.live();
      if (this.hookDelayMs) await new Promise((r) => setTimeout(r, this.hookDelayMs));
      res.end(`deploying ${this.#hooked.sha.slice(0, 7)}`);
      this.hookCalls.push({
        method: req.method ?? "",
        headers: req.headers,
        receivedAt,
        answeredAt: performance.now(),
      });
      return;
    }
    const d = await this.deployed();
    if (path === "/version") return res.end(`commit ${d.sha}`);
    if (path === "/health") {
      const fixed = !this.down && this.expect !== "" && d.content.includes(`- ${this.expect}`);
      res.statusCode = fixed ? 200 : 500;
      return res.end(fixed ? "ok" : "broken");
    }
    res.statusCode = 404;
    res.end();
  }
}
