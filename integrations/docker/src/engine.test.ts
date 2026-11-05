import { chmod, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareApiVersions,
  createEngineClient,
  DockerError,
  demuxLogs,
  describeTransportError,
  normalizePem,
  parseHost,
  parseImageRef,
} from "./engine.ts";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type Handler = (req: Seen, res: http.ServerResponse) => void;

let dir: string;
let socketPath: string;
let server: http.Server;
let seen: Seen[];
let apiVersion: string;
let routes: Record<string, Handler>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sling-docker-"));
  socketPath = join(dir, "docker.sock");
  seen = [];
  apiVersion = "1.47";
  routes = {};
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      seen.push(entry);
      if (entry.url === "/_ping") {
        res.writeHead(200, { "Api-Version": apiVersion, "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }
      const path = entry.url.split("?")[0]?.replace(/^\/v[\d.]+/, "") ?? "";
      const handler = routes[`${entry.method} ${path}`];
      if (!handler) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: `no route ${entry.method} ${path}` }));
        return;
      }
      handler(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function client() {
  return createEngineClient({ host: `unix://${socketPath}` });
}

function json(status: number, body: unknown): Handler {
  return (_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

function query(url: string): URLSearchParams {
  return new URL(url, "http://docker").searchParams;
}

describe("Engine API client", () => {
  it("negotiates the daemon's API version and uses it on every call", async () => {
    routes["GET /version"] = json(200, {
      Version: "27.0.0",
      ApiVersion: "1.47",
      Os: "linux",
      Arch: "amd64",
    });
    const api = client();
    expect(await api.version()).toMatchObject({ Version: "27.0.0" });
    expect(seen.map((s) => s.url)).toEqual(["/_ping", "/v1.47/version"]);
  });

  it("caps the version at the newest it was tested against", async () => {
    apiVersion = "1.99";
    routes["GET /version"] = json(200, { Version: "40.0.0" });
    await client().version();
    expect(seen[1]?.url).toBe("/v1.54/version");
  });

  it("refuses a daemon that's too old", async () => {
    apiVersion = "1.30";
    await expect(client().ping()).rejects.toThrow(/speaks API 1.30. Sling needs 1.40 or newer/);
  });

  it("checks whether an image is present", async () => {
    routes["GET /images/alpine:3/json"] = json(200, { Id: "sha256:x" });
    const api = client();
    expect(await api.imageExists("alpine:3")).toBe(true);
    expect(await api.imageExists("busybox:1")).toBe(false);
  });

  it("pulls by repository and tag, with the registry login, to the end of the stream", async () => {
    let finished = false;
    routes["POST /images/create"] = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write(`${JSON.stringify({ status: "Pulling from acme/sandbox" })}\n`);
      setTimeout(() => {
        res.write(
          `${JSON.stringify({ status: "Downloading", progress: "[==>   ]" })}\n{"status":"Dig`,
        );
        setTimeout(() => {
          finished = true;
          res.end(`est: sha256:abc"}\n`);
        }, 20);
      }, 20);
    };
    await client().pullImage("ghcr.io/acme/sandbox:1", {
      username: "bot",
      password: "reg-secret",
      serveraddress: "ghcr.io",
    });
    expect(finished).toBe(true);
    const pull = seen.find((s) => s.url.includes("/images/create"));
    expect(pull?.method).toBe("POST");
    expect(Object.fromEntries(query(pull?.url ?? ""))).toEqual({
      fromImage: "ghcr.io/acme/sandbox",
      tag: "1",
    });
    const auth = JSON.parse(
      Buffer.from(String(pull?.headers["x-registry-auth"]), "base64url").toString("utf8"),
    );
    expect(auth).toEqual({ username: "bot", password: "reg-secret", serveraddress: "ghcr.io" });
  });

  it("pulls latest when the image has no tag, and by digest when it has one", async () => {
    routes["POST /images/create"] = (_req, res) => res.end();
    const api = client();
    await api.pullImage("alpine", null);
    await api.pullImage("alpine@sha256:0123", null);
    const pulls = seen.filter((s) => s.url.includes("/images/create")).map((s) => query(s.url));
    expect(Object.fromEntries(pulls[0] ?? [])).toEqual({ fromImage: "alpine", tag: "latest" });
    expect(Object.fromEntries(pulls[1] ?? [])).toEqual({ fromImage: "alpine@sha256:0123" });
    expect(seen.find((s) => s.url.includes("/images/create"))?.headers).not.toHaveProperty(
      "x-registry-auth",
    );
  });

  it("fails a pull whose stream reports an error", async () => {
    routes["POST /images/create"] = (_req, res) => {
      res.writeHead(200);
      res.write(`${JSON.stringify({ status: "Pulling" })}\n`);
      res.end(
        `${JSON.stringify({ errorDetail: { message: "manifest unknown" }, error: "manifest unknown" })}\n`,
      );
    };
    await expect(client().pullImage("alpine:nope", null)).rejects.toThrow(
      "Couldn't pull alpine:nope: manifest unknown",
    );
  });

  it("fails a pull the daemon refuses outright", async () => {
    routes["POST /images/create"] = json(404, {
      message: "pull access denied for sling-sandbox, repository does not exist",
    });
    const error = await client()
      .pullImage("sling-sandbox:latest", null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DockerError);
    expect((error as DockerError).status).toBe(404);
    expect((error as DockerError).message).toMatch(/pull access denied/);
  });

  it("creates a named container from the spec and returns its ID", async () => {
    routes["POST /containers/create"] = json(201, { Id: "c0ffee", Warnings: [] });
    const id = await client().createContainer("sling-sbx_1", {
      Image: "alpine:3",
      Env: ["A=1"],
      Labels: { "sling.sandbox": "sbx_1" },
      Tty: false,
      OpenStdin: false,
      AttachStdin: false,
      StopTimeout: 5,
      HostConfig: {
        NetworkMode: "bridge",
        PidsLimit: 1,
        Init: true,
        CapDrop: ["ALL"],
        CapAdd: [],
        SecurityOpt: [],
        Privileged: false,
        PublishAllPorts: false,
        PortBindings: {},
        AutoRemove: false,
        RestartPolicy: { Name: "no" },
        ExtraHosts: [],
      },
    });
    expect(id).toBe("c0ffee");
    const create = seen.find((s) => s.url.includes("/containers/create"));
    expect(query(create?.url ?? "").get("name")).toBe("sling-sbx_1");
    expect(JSON.parse(create?.body ?? "{}")).toMatchObject({ Image: "alpine:3", Env: ["A=1"] });
    expect(create?.headers["content-type"]).toBe("application/json");
  });

  it("carries the daemon's status and message on a refused request", async () => {
    routes["POST /containers/create"] = json(409, { message: "name already in use" });
    const error = (await client()
      .createContainer("sling-x", {} as never)
      .catch((e: unknown) => e)) as DockerError;
    expect(error.status).toBe(409);
    expect(error.unreachable).toBe(false);
    expect(error.message).toBe("Docker didn't create the container: name already in use");
  });

  it("treats stopping or removing a missing container as done", async () => {
    routes["POST /containers/gone/stop"] = json(404, { message: "No such container" });
    routes["DELETE /containers/gone"] = json(404, { message: "No such container" });
    routes["POST /containers/done/stop"] = (_req, res) => {
      res.writeHead(304);
      res.end();
    };
    routes["DELETE /containers/busy"] = json(409, { message: "removal already in progress" });
    const api = client();
    expect(await api.stopContainer("gone", 5)).toBe(false);
    expect(await api.removeContainer("gone")).toBe(false);
    expect(await api.stopContainer("done", 5)).toBe(true);
    expect(await api.removeContainer("busy")).toBe(true);
    const stop = seen.find((s) => s.url.includes("/containers/gone/stop"));
    expect(query(stop?.url ?? "").get("t")).toBe("5");
    const remove = seen.find((s) => s.method === "DELETE");
    expect(Object.fromEntries(query(remove?.url ?? ""))).toEqual({ force: "true", v: "true" });
  });

  it("lists containers by label filter, including stopped ones", async () => {
    routes["GET /containers/json"] = json(200, [
      { Id: "a", Names: ["/x"], Labels: {}, State: "running" },
    ]);
    expect(await client().listContainers(["sling.sandbox", "sling.workspace=ws_1"])).toHaveLength(
      1,
    );
    const list = seen.find((s) => s.url.includes("/containers/json"));
    expect(query(list?.url ?? "").get("all")).toBe("true");
    expect(JSON.parse(query(list?.url ?? "").get("filters") ?? "{}")).toEqual({
      label: ["sling.sandbox", "sling.workspace=ws_1"],
    });
  });

  it("returns null when inspecting a missing container", async () => {
    expect(await client().inspectContainer("nope")).toBeNull();
  });

  it("refuses IDs that would change the request path", async () => {
    await expect(client().removeContainer("../images/x")).rejects.toThrow(/isn't a container ID/);
    expect(seen).toEqual([]);
  });

  it("explains a socket path with nothing there", async () => {
    const api = createEngineClient({ host: `unix://${join(dir, "missing.sock")}` });
    const error = (await api.ping().catch((e: unknown) => e)) as DockerError;
    expect(error.unreachable).toBe(true);
    expect(error.code).toBe("ENOENT");
    expect(error.message).toMatch(/^There's no Docker socket at .*missing\.sock\./);
  });

  it.skipIf(process.getuid?.() === 0)("explains a socket it isn't allowed to use", async () => {
    await chmod(socketPath, 0);
    const error = (await client()
      .ping()
      .catch((e: unknown) => e)) as DockerError;
    expect(error.code).toBe("EACCES");
    expect(error.message).toMatch(/^Permission denied on the Docker socket/);
  });

  it("gives up on a daemon that stops answering", async () => {
    const api = createEngineClient({ host: `unix://${socketPath}` });
    routes["GET /version"] = () => {};
    const controller = new AbortController();
    const pending = api.version(controller.signal);
    setTimeout(() => controller.abort(new Error("stopped")), 50);
    await expect(pending).rejects.toThrow("stopped");
  });
});

describe("transport errors", () => {
  const tcp = parseHost({ host: "tcp://docker.lan:2376" });
  const tls = parseHost({
    host: "tcp://docker.lan:2376",
    tlsCa: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
  });

  it("says what to check for each failure", () => {
    const err = (code: string, message = code) => Object.assign(new Error(message), { code });
    expect(describeTransportError(err("ECONNREFUSED"), tcp).message).toMatch(
      /^Nothing accepted a connection at docker.lan:2376/,
    );
    expect(describeTransportError(err("ENOTFOUND"), tcp).message).toBe(
      "Couldn't resolve docker.lan.",
    );
    expect(
      describeTransportError(err("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"), tls)
        .message,
    ).toMatch(/^TLS with docker.lan:2376 failed: self-signed certificate\. Check the CA/);
    expect(describeTransportError(err("ECONNRESET"), tcp).message).toMatch(/add its certificates/);
  });
});

describe("hosts and certificates", () => {
  it("reads unix and tcp hosts", () => {
    expect(parseHost({ host: "unix:///var/run/docker.sock" })).toEqual({
      kind: "unix",
      socketPath: "/var/run/docker.sock",
    });
    expect(parseHost({ host: "tcp://10.0.0.5:2375" })).toEqual({
      kind: "tcp",
      hostname: "10.0.0.5",
      port: 2375,
      tls: null,
    });
  });

  it("uses TLS when certificates are given, and wants the cert and key together", () => {
    const pem = (label: string) => `-----BEGIN ${label}-----\nAAAA\n-----END ${label}-----`;
    const endpoint = parseHost({
      host: "tcp://docker.lan:2376",
      tlsCa: pem("CERTIFICATE"),
      tlsCert: pem("CERTIFICATE"),
      tlsKey: pem("PRIVATE KEY"),
    });
    expect(endpoint).toMatchObject({
      kind: "tcp",
      tls: { ca: expect.any(String), key: expect.any(String) },
    });
    expect(() => parseHost({ host: "tcp://docker.lan:2376", tlsCert: pem("CERTIFICATE") })).toThrow(
      /both the client certificate and its key/,
    );
    expect(parseHost({ host: "tcp://docker.lan:2376", tlsCa: "", tlsKey: "" })).toMatchObject({
      tls: null,
    });
  });

  it("restores the line breaks a password field strips from a key", () => {
    const body = "A".repeat(100);
    const flattened = `-----BEGIN PRIVATE KEY-----${body}-----END PRIVATE KEY-----`;
    expect(normalizePem(flattened)).toBe(
      `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n${"A".repeat(36)}\n-----END PRIVATE KEY-----\n`,
    );
  });

  it("keeps a well-formed chain of certificates", () => {
    const chain = [
      "-----BEGIN CERTIFICATE-----\nAAAA\nBBBB\n-----END CERTIFICATE-----",
      "-----BEGIN CERTIFICATE-----\nCCCC\n-----END CERTIFICATE-----",
    ].join("\n");
    expect(normalizePem(chain)).toBe(
      "-----BEGIN CERTIFICATE-----\nAAAABBBB\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nCCCC\n-----END CERTIFICATE-----\n",
    );
  });
});

describe("image references", () => {
  it("splits registry, repository, tag, and digest", () => {
    expect(parseImageRef("alpine")).toEqual({
      repository: "alpine",
      tag: null,
      digest: null,
      registry: "docker.io",
    });
    expect(parseImageRef("sling-sandbox:latest")).toMatchObject({
      tag: "latest",
      registry: "docker.io",
    });
    expect(parseImageRef("acme/tool:1.2")).toMatchObject({
      repository: "acme/tool",
      registry: "docker.io",
    });
    expect(parseImageRef("ghcr.io/acme/sandbox:1")).toMatchObject({
      repository: "ghcr.io/acme/sandbox",
      tag: "1",
      registry: "ghcr.io",
    });
    expect(parseImageRef("localhost:5000/x")).toMatchObject({
      repository: "localhost:5000/x",
      tag: null,
      registry: "localhost:5000",
    });
    expect(parseImageRef("ghcr.io/a/b:1@sha256:ff")).toMatchObject({
      tag: "1",
      digest: "sha256:ff",
    });
  });

  it("rejects names that aren't image references", () => {
    expect(() => parseImageRef("alpine 3")).toThrow(/isn't a valid image name/);
    expect(() => parseImageRef("../x")).toThrow();
    expect(() => parseImageRef("a/../../containers/x")).toThrow();
  });
});

describe("helpers", () => {
  it("compares API versions numerically", () => {
    expect(compareApiVersions("1.54", "1.9")).toBeGreaterThan(0);
    expect(compareApiVersions("1.40", "1.40")).toBe(0);
    expect(compareApiVersions("1.39", "1.40")).toBeLessThan(0);
  });

  it("splits Docker's multiplexed log stream", () => {
    const frame = (stream: number, text: string) => {
      const payload = Buffer.from(text);
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    expect(demuxLogs(Buffer.concat([frame(1, "out\n"), frame(2, "err\n")]))).toBe("out\nerr\n");
    expect(demuxLogs(Buffer.from("plain text from a TTY"))).toBe("plain text from a TTY");
  });
});
