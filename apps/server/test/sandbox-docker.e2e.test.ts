/**
 * A real sandbox, end to end: the Docker provider starts the `sling-sandbox`
 * image on the local daemon, `sling-runner sandbox` inside it clones a repo
 * over smart HTTP from this machine, a shell stand-in for Codex makes the
 * change, the Runner pushes it, and the server destroys the container.
 *
 * Needs Docker and the image, built with:
 *   docker build -f deploy/sandbox/Dockerfile -t sling-sandbox:dev .
 * Skips itself when the image is missing. Set SLING_SANDBOX_IMAGE to use another tag.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@sling/db";
import { connector as docker } from "@sling/integration-docker";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";

const BASE_IMAGE = process.env.SLING_SANDBOX_IMAGE || "sling-sandbox:dev";
const E2E_IMAGE = "sling-sandbox:e2e";
const GIT_TOKEN = "ghp_e2eFakeToken0123456789abcdefABCDEF";
const OPENAI_KEY = "sk-e2e-fake-openai-key-0123456789";

function dockerHost(): string {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  try {
    return execFileSync(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      {
        encoding: "utf8",
      },
    ).trim();
  } catch {
    return "unix:///var/run/docker.sock";
  }
}

function hasImage(tag: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const imageReady = hasImage(BASE_IMAGE);
if (!imageReady) {
  console.warn(`Skipping the Docker sandbox test: build ${BASE_IMAGE} first.`);
}

/** Codex as the image would run it: logs in with a key, edits files, and records the env it got. */
const FAKE_CODEX = `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.166.0" ;;
  login)
    if [ "$2" = "--with-api-key" ]; then cat > /dev/null; echo "API key saved."; exit 0; fi
    echo "Logged in using an API key" ;;
  exec)
    cat > /dev/null
    dir="."
    while [ $# -gt 0 ]; do case "$1" in -C) dir="$2"; shift ;; esac; shift; done
    echo "- Dark mode" >> "$dir/CHANGELOG.md"
    env | sort > "$dir/AGENT_ENV.txt"
    printf '%s\\n' "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"id\\":\\"f1\\",\\"type\\":\\"file_change\\",\\"changes\\":[{\\"path\\":\\"$dir/CHANGELOG.md\\",\\"kind\\":\\"add\\"},{\\"path\\":\\"$dir/AGENT_ENV.txt\\",\\"kind\\":\\"add\\"}],\\"status\\":\\"completed\\"}}"
    echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Added a changelog line."}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
    ;;
esac
`;

/** Serves bare repos under `root` over git's smart HTTP protocol, push included. */
function gitHttpServer(root: string): Server {
  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://git");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(url.pathname),
      REQUEST_METHOD: req.method ?? "GET",
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_ADDR: req.socket.remoteAddress ?? "",
    };
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") env[`HTTP_${k.toUpperCase().replaceAll("-", "_")}`] = v;
    }
    const cgi = spawn("git", ["http-backend"], { env });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      headersDone = true;
      let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const i = line.indexOf(":");
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else res.setHeader(name, value);
      }
      res.statusCode = status;
      res.write(head.subarray(end + 4));
    });
    cgi.on("close", () => res.end());
    cgi.stderr.resume();
  });
}

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  ms: number,
): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let gitServer: Server;
let dir = "";
let cookie = "";
let origin = "";
let repoKey = "";
let bare = "";

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(server.url + path, {
    method,
    headers: {
      origin,
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie();
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

function slingContainers(): string[] {
  return execFileSync(
    "docker",
    ["ps", "-a", "--filter", "label=sling.sandbox", "--format", "{{.ID}}"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
}

describe.skipIf(!imageReady)("a real Docker sandbox", { timeout: 180_000 }, () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sling-docker-e2e-"));

    // An image with the Codex stand-in on top of the real sandbox image.
    const ctx = join(dir, "image");
    mkdirSync(ctx);
    writeFileSync(join(ctx, "fake-codex"), FAKE_CODEX);
    writeFileSync(
      join(ctx, "Dockerfile"),
      `FROM ${BASE_IMAGE}\nCOPY --chmod=755 fake-codex /usr/local/bin/fake-codex\n`,
    );
    execFileSync("docker", ["build", "-q", "-t", E2E_IMAGE, ctx], { stdio: "ignore" });

    // The repo, served over smart HTTP so the container can clone and push.
    const root = join(dir, "git");
    bare = join(root, "acme", "site.git");
    mkdirSync(join(root, "acme"), { recursive: true });
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(bare, "config", "http.receivepack", "true");
    const work = join(dir, "work");
    mkdirSync(work);
    git(work, "init", "-q", "-b", "main");
    writeFileSync(join(work, "CHANGELOG.md"), "# Changelog\n");
    git(work, "add", ".");
    git(work, "commit", "-qm", "init");
    git(work, "push", "-q", bare, "main");
    gitServer = gitHttpServer(root);
    const gitPort = await freePort();
    await new Promise<void>((ok) => gitServer.listen(gitPort, "0.0.0.0", () => ok()));
    repoKey = "host.docker.internal/acme/site";

    pg = await new PostgreSqlContainer("postgres:18-alpine").start();
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    const config: Config = {
      databaseUrl: pg.getConnectionUri(),
      publicUrl: new URL(origin),
      secretKey: "e2e-secret-key-that-is-long-enough-1234",
      // The container reaches the server through the Docker host's gateway.
      host: "0.0.0.0",
      port,
      logLevel: "warn",
      webDist: undefined,
      testing: { sandboxCodexBin: "/usr/local/bin/fake-codex" },
    };
    server = await startServer(config, { connectors: [docker], jobs: true });

    await api("POST", "/api/auth/sign-up/email", {
      name: "Admin",
      email: "admin@example.com",
      password: "correct-horse-battery",
    });
    const [ws] = await server.ctx.db.select().from(schema.workspaces);
    const [owner] = await server.ctx.db.select().from(schema.users);
    if (!ws || !owner) throw new Error("no workspace");
    // Straight into the table: the API only takes HTTPS clone URLs.
    await server.ctx.db.insert(schema.sandboxRepos).values({
      workspaceId: ws.id,
      ownerId: owner.id,
      remoteKey: repoKey,
      cloneUrl: `http://host.docker.internal:${gitPort}/acme/site.git`,
      defaultBranch: "main",
      network: false,
    });
    await api("PUT", "/api/settings/sandboxes/secrets", {
      openaiApiKey: OPENAI_KEY,
      gitToken: GIT_TOKEN,
    });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
    await pg?.stop();
    gitServer?.close();
    for (const id of slingContainers()) {
      execFileSync("docker", ["rm", "-f", id], { stdio: "ignore" });
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs a task in a fresh container, pushes the result, and destroys it", async () => {
    const provider = await api<{ id: string }>("POST", "/api/installations", {
      connectorId: "docker",
      name: "Local Docker",
      credentials: { host: dockerHost() },
      config: {
        image: E2E_IMAGE,
        pullPolicy: "never",
        controlPlaneUrl: `http://host.docker.internal:${new URL(origin).port}`,
      },
    });
    expect(await api("POST", `/api/installations/${provider.id}/test`)).toMatchObject({ ok: true });

    const requested = Date.now();
    const task = await api<{ id: string; environment: string }>("POST", "/api/tasks", {
      repo: repoKey,
      title: "Add a dark mode line",
      objective: "Add a changelog line about dark mode.",
      deliver: "push",
      mode: "auto",
      environment: "sandbox",
      providerInstallationId: provider.id,
    });
    expect(task.environment).toBe("sandbox");

    interface Sandboxes {
      sandboxes: { id: string; state: string; taskId: string | null; externalId: string | null }[];
    }
    const sandbox = async () =>
      (await api<Sandboxes>("GET", "/api/sandboxes")).sandboxes.find((s) => s.taskId === task.id);

    await until(
      "the sandbox's Runner to connect",
      async () => {
        const s = await sandbox();
        return s && ["ready", "busy", "releasing", "destroyed"].includes(s.state);
      },
      60_000,
    );
    const bootMs = Date.now() - requested;

    const done = await until(
      "the push",
      async () => {
        const t = await api<{
          task: { state: string; actions: { kind: string; state: string }[] };
        }>("GET", `/api/tasks/${task.id}`);
        return t.task.state === "succeeded" && t.task.actions[0]?.state === "succeeded" ? t : null;
      },
      90_000,
    );
    const deliveredAt = Date.now();
    expect(done.task.actions.map((a) => a.kind)).toEqual(["push"]);

    await until(
      "the sandbox to be destroyed",
      async () => (await sandbox())?.state === "destroyed",
      60_000,
    );
    const teardownMs = Date.now() - deliveredAt;
    await until("the container to be gone", async () => slingContainers().length === 0, 30_000);

    // The branch arrived, with the agent's change.
    const branch = git(
      bare,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/sling/",
    ).trim();
    expect(branch).toMatch(/^sling\//);
    expect(git(bare, "show", `${branch}:CHANGELOG.md`)).toContain("- Dark mode");

    // What the agent could see: no git token, no pairing code, no Sling variables.
    const agentEnv = git(bare, "show", `${branch}:AGENT_ENV.txt`);
    expect(agentEnv).not.toContain(GIT_TOKEN);
    expect(agentEnv).not.toMatch(/^SLING_/m);
    expect(agentEnv).not.toMatch(/^GH_TOKEN=/m);
    expect(agentEnv).not.toContain(OPENAI_KEY);

    console.log(
      `Docker sandbox: request to Runner connected ${bootMs} ms, delivered to destroyed ${teardownMs} ms`,
    );
    expect(bootMs).toBeLessThan(15_000);
    expect(teardownMs).toBeLessThan(30_000);
  });
});
