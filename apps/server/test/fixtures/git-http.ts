/**
 * Serves bare git repos over smart HTTP through `git http-backend`, so a
 * test remote has an http URL: it gets a remote key like a hosted repo, and
 * machines push and fetch through `origin` as usual.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface GitServer {
  /** Base URL, such as http://127.0.0.1:1234. A repo at <root>/acme/site.git is <url>/acme/site.git. */
  url: string;
  close(): Promise<void>;
}

export async function serveGit(root: string): Promise<GitServer> {
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://git.local");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        // http-backend allows pushes only for a known user.
        REMOTE_USER: "sling-test",
        REMOTE_ADDR: "127.0.0.1",
        PATH_INFO: decodeURIComponent(u.pathname),
        QUERY_STRING: u.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (started) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      let end = head.indexOf("\r\n\r\n");
      let sep = 4;
      if (end < 0) {
        end = head.indexOf("\n\n");
        sep = 2;
      }
      if (end < 0) return;
      started = true;
      for (const line of head.subarray(0, end).toString("utf8").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (name.toLowerCase() === "status") res.statusCode = Number.parseInt(value, 10) || 200;
        else res.setHeader(name, value);
      }
      res.write(head.subarray(end + sep));
    });
    child.stdout.on("end", () => res.end());
    child.on("error", () => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
