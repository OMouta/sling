/**
 * A small Docker Engine API client over a Unix socket or TCP, with TLS when
 * certificates are given. It covers only the calls the provider makes.
 */
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { DockerCredentials } from "./schemas.ts";

/** Newest API version this client was tested against. Older daemons get their own version. */
export const MAX_API_VERSION = "1.54";
/** Docker 19.03. Everything the provider sends exists in this version. */
export const MIN_API_VERSION = "1.40";

const DEFAULT_TIMEOUT_MS = 30_000;
/** A pull can go quiet while it extracts a large layer. */
const PULL_IDLE_TIMEOUT_MS = 300_000;

export type DockerEndpoint =
  | { kind: "unix"; socketPath: string }
  | {
      kind: "tcp";
      hostname: string;
      port: number;
      tls: { ca?: string; cert?: string; key?: string } | null;
    };

/** A failure talking to Docker. `status` is set when the daemon answered, `code` when it couldn't be reached. */
export class DockerError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DockerError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }

  /** True when the daemon couldn't be reached at all, as opposed to refusing a request. */
  get unreachable(): boolean {
    return this.status === null;
  }
}

export interface DockerVersion {
  Version: string;
  ApiVersion: string;
  Os: string;
  Arch: string;
}

export interface RegistryAuth {
  username: string;
  password: string;
  serveraddress: string;
}

/** The parts of the Engine API's container create body that the provider sets. */
export interface ContainerSpec {
  Image: string;
  Env: string[];
  Labels: Record<string, string>;
  Cmd?: string[];
  Tty: false;
  OpenStdin: false;
  AttachStdin: false;
  StopTimeout: number;
  HostConfig: {
    NetworkMode: string;
    NanoCpus?: number;
    Memory?: number;
    MemorySwap?: number;
    PidsLimit: number;
    Init: true;
    CapDrop: string[];
    CapAdd: string[];
    SecurityOpt: string[];
    Privileged: false;
    PublishAllPorts: false;
    PortBindings: Record<string, never>;
    AutoRemove: false;
    RestartPolicy: { Name: "no" };
    ExtraHosts: string[];
  };
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Labels: Record<string, string>;
  State: string;
}

export interface ContainerInfo {
  Id: string;
  Name: string;
  State: { Status: string; Running: boolean };
  Config: { Image: string; Env: string[] | null; Labels: Record<string, string> | null };
  HostConfig: Record<string, unknown>;
  NetworkSettings: { Ports: Record<string, unknown> | null; Networks: Record<string, unknown> };
}

export interface DockerApi {
  /** Where this client connects, for messages. Never includes credentials. */
  readonly endpoint: string;
  /** True for tcp:// without TLS. */
  readonly plaintextTcp: boolean;
  ping(signal?: AbortSignal): Promise<void>;
  version(signal?: AbortSignal): Promise<DockerVersion>;
  imageExists(image: string, signal?: AbortSignal): Promise<boolean>;
  /** Pulls and reads the progress stream to the end. Rejects with the daemon's error if the pull fails. */
  pullImage(image: string, auth: RegistryAuth | null, signal?: AbortSignal): Promise<void>;
  networkExists(name: string, signal?: AbortSignal): Promise<boolean>;
  /** Returns the new container's ID. A name already in use rejects with status 409. */
  createContainer(name: string, spec: ContainerSpec, signal?: AbortSignal): Promise<string>;
  startContainer(id: string, signal?: AbortSignal): Promise<void>;
  /** Resolves false when there was no such container. */
  stopContainer(id: string, timeoutSeconds: number, signal?: AbortSignal): Promise<boolean>;
  /** Force-removes it with its anonymous volumes. Resolves false when it was already gone. */
  removeContainer(id: string, signal?: AbortSignal): Promise<boolean>;
  inspectContainer(id: string, signal?: AbortSignal): Promise<ContainerInfo | null>;
  /** Containers in any state that match every label filter (`key` or `key=value`). */
  listContainers(labels: string[], signal?: AbortSignal): Promise<ContainerSummary[]>;
  /** Stdout and stderr so far. */
  containerLogs(id: string, signal?: AbortSignal): Promise<string>;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;

/**
 * Rebuilds PEM blocks with proper line breaks. A password field drops the
 * newlines from a pasted key, which leaves it unreadable to TLS.
 */
export function normalizePem(text: string): string {
  const blocks = [...text.matchAll(PEM_BLOCK)].map(([, label, body]) => {
    const lines = (body ?? "").split(/\r?\n/).map((l) => l.trim());
    // Encrypted keys carry headers such as "Proc-Type: 4,ENCRYPTED" before a blank line.
    const headerEnd = lines.indexOf("");
    const hasHeaders = lines.some((l) => /^[A-Za-z-]+: /.test(l));
    const headers = hasHeaders && headerEnd > 0 ? lines.slice(0, headerEnd).filter(Boolean) : [];
    const b64 = (hasHeaders && headerEnd > 0 ? lines.slice(headerEnd) : lines)
      .join("")
      .replace(/\s+/g, "");
    const wrapped = b64.match(/.{1,64}/g) ?? [];
    const head = headers.length ? [...headers, ""] : [];
    return [`-----BEGIN ${label}-----`, ...head, ...wrapped, `-----END ${label}-----`].join("\n");
  });
  return blocks.length ? `${blocks.join("\n")}\n` : text;
}

function present(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export function parseHost(credentials: DockerCredentials): DockerEndpoint {
  const host = credentials.host;
  if (host.startsWith("unix://")) {
    return { kind: "unix", socketPath: host.slice("unix://".length) };
  }
  const match = /^tcp:\/\/([^/:]+):(\d{1,5})$/.exec(host);
  if (!match?.[1] || !match[2]) {
    throw new DockerError(
      `Can't read the Docker host "${host}". Use unix:///path or tcp://host:port.`,
    );
  }
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new DockerError(`Port ${port} is out of range.`);
  const ca = present(credentials.tlsCa);
  const cert = present(credentials.tlsCert);
  const key = present(credentials.tlsKey);
  if (Boolean(cert) !== Boolean(key)) {
    throw new DockerError(
      "Give both the client certificate and its key, or neither. The daemon checks them as a pair.",
    );
  }
  const tls =
    ca || cert
      ? {
          ...(ca ? { ca: normalizePem(ca) } : {}),
          ...(cert ? { cert: normalizePem(cert) } : {}),
          ...(key ? { key: normalizePem(key) } : {}),
        }
      : null;
  return { kind: "tcp", hostname: match[1], port, tls };
}

export function describeEndpoint(endpoint: DockerEndpoint): string {
  if (endpoint.kind === "unix") return `unix://${endpoint.socketPath}`;
  return `tcp://${endpoint.hostname}:${endpoint.port}`;
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;

export interface ImageRef {
  /** Repository without tag or digest, for example ghcr.io/acme/sling-sandbox. */
  repository: string;
  tag: string | null;
  digest: string | null;
  /** Registry host, or docker.io for Docker Hub. */
  registry: string;
}

export function parseImageRef(image: string): ImageRef {
  if (!REFERENCE.test(image) || image.includes("..")) {
    throw new DockerError(`"${image}" isn't a valid image name.`);
  }
  let rest = image;
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const first = rest.split("/")[0] ?? "";
  const hasRegistry = rest.includes("/") && (/[.:]/.test(first) || first === "localhost");
  return { repository: rest, tag, digest, registry: hasRegistry ? first : "docker.io" };
}

/** What Docker calls Docker Hub in auth configs. */
export function registryServerAddress(registry: string): string {
  return registry === "docker.io" ? "https://index.docker.io/v1/" : registry;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function idPath(id: string): string {
  if (!ID.test(id)) throw new DockerError(`"${id}" isn't a container ID or name.`);
  return id;
}

/** "1.54" > "1.9" */
export function compareApiVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

const TLS_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "EPROTO",
]);

/** Turns a Node transport error into a message that says what to fix. */
export function describeTransportError(error: unknown, endpoint: DockerEndpoint): DockerError {
  const e = error as NodeJS.ErrnoException;
  const code = typeof e?.code === "string" ? e.code : "UNKNOWN";
  const message = e instanceof Error ? e.message : String(error);
  const where = describeEndpoint(endpoint);
  let text: string;
  if (endpoint.kind === "unix") {
    const path = endpoint.socketPath;
    if (code === "ENOENT") {
      text = `There's no Docker socket at ${path}. Check that Docker is running and that the host setting is right. If Sling runs in a container, mount the socket into it, as deploy/docker-compose.sandbox.yml does.`;
    } else if (code === "EACCES" || code === "EPERM") {
      text = `Permission denied on the Docker socket at ${path}. The user Sling runs as needs read and write access to it: add that user to the socket's group, usually docker. With compose, set DOCKER_GID to the socket's group ID.`;
    } else if (code === "ECONNREFUSED") {
      text = `Docker isn't accepting connections on ${path}. Is the daemon running?`;
    } else {
      text = `Couldn't reach Docker at ${where}: ${message}`;
    }
  } else if (code === "ECONNREFUSED") {
    text = `Nothing accepted a connection at ${endpoint.hostname}:${endpoint.port}. Check that the Docker daemon listens there and that a firewall isn't in the way.`;
  } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    text = `Couldn't resolve ${endpoint.hostname}.`;
  } else if (TLS_CODES.has(code) || code.startsWith("ERR_SSL") || code.startsWith("ERR_TLS")) {
    text = `TLS with ${endpoint.hostname}:${endpoint.port} failed: ${message}. Check the CA certificate, and that the daemon's certificate is issued for ${endpoint.hostname}.`;
  } else if (code === "ECONNRESET" && !endpoint.tls) {
    text = `The connection to ${endpoint.hostname}:${endpoint.port} was reset. If that daemon uses TLS, add its certificates.`;
  } else if (code === "ETIMEDOUT") {
    text = message;
  } else {
    text = `Couldn't reach Docker at ${where}: ${message}`;
  }
  return new DockerError(text, { code, cause: error });
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Fails the request after this long without any data. */
  idleTimeoutMs?: number;
  /** Streams the body here instead of collecting it. */
  onData?: (chunk: Buffer) => void;
}

function daemonMessage(response: Response): string {
  const text = response.body.toString("utf8").trim();
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON, for example a proxy's error page.
  }
  return text || `HTTP ${response.status}`;
}

/** Splits the multiplexed stdout/stderr stream Docker sends for containers without a TTY. */
export function demuxLogs(buffer: Buffer): string {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    if (stream !== 0 && stream !== 1 && stream !== 2) return buffer.toString("utf8");
    const size = buffer.readUInt32BE(offset + 4);
    out.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(out).toString("utf8");
}

export function createEngineClient(credentials: DockerCredentials): DockerApi {
  const endpoint = parseHost(credentials);
  const label = describeEndpoint(endpoint);
  let negotiated: Promise<string> | null = null;

  function send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const query = Object.entries(options.query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const fullPath = query ? `${path}?${query}` : path;
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { ...options.headers };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const idleMs = options.idleTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<Response>((resolve, reject) => {
      let req: http.ClientRequest;
      const common = {
        method,
        path: fullPath,
        headers,
        agent: false as const,
        signal: options.signal,
      };
      if (endpoint.kind === "unix") {
        req = http.request({ ...common, socketPath: endpoint.socketPath });
      } else if (endpoint.tls) {
        req = https.request({
          ...common,
          host: endpoint.hostname,
          port: endpoint.port,
          ...endpoint.tls,
          ...(isIP(endpoint.hostname) ? {} : { servername: endpoint.hostname }),
        });
      } else {
        req = http.request({ ...common, host: endpoint.hostname, port: endpoint.port });
      }
      req.setTimeout(idleMs, () => {
        req.destroy(
          Object.assign(new Error(`Docker at ${label} didn't answer within ${idleMs / 1000} s.`), {
            code: "ETIMEDOUT",
          }),
        );
      });
      req.on("error", (error) => {
        if (options.signal?.aborted) reject(options.signal.reason ?? error);
        else reject(describeTransportError(error, endpoint));
      });
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        const status = res.statusCode ?? 0;
        const streaming = options.onData && status >= 200 && status < 300;
        res.on("data", (chunk: Buffer) => {
          if (streaming) options.onData?.(chunk);
          else chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", (error) => reject(describeTransportError(error, endpoint)));
      });
      req.end(payload);
    });
  }

  async function apiVersion(signal?: AbortSignal): Promise<string> {
    negotiated ??= (async () => {
      const res = await send("GET", "/_ping", { signal });
      if (res.status !== 200) {
        throw new DockerError(`Docker at ${label} answered the ping with: ${daemonMessage(res)}`, {
          status: res.status,
        });
      }
      const header = res.headers["api-version"];
      const server = typeof header === "string" ? header : MIN_API_VERSION;
      if (compareApiVersions(server, MIN_API_VERSION) < 0) {
        throw new DockerError(
          `Docker at ${label} speaks API ${server}. Sling needs ${MIN_API_VERSION} or newer (Docker 19.03 and later).`,
          { status: res.status },
        );
      }
      return compareApiVersions(server, MAX_API_VERSION) > 0 ? MAX_API_VERSION : server;
    })();
    try {
      return await negotiated;
    } catch (error) {
      negotiated = null;
      throw error;
    }
  }

  async function call(method: string, path: string, options: RequestOptions = {}) {
    const version = await apiVersion(options.signal);
    return send(method, `/v${version}${path}`, options);
  }

  function fail(what: string, res: Response): never {
    throw new DockerError(`${what}: ${daemonMessage(res)}`, { status: res.status });
  }

  return {
    endpoint: label,
    plaintextTcp: endpoint.kind === "tcp" && !endpoint.tls,

    async ping(signal) {
      negotiated = null;
      await apiVersion(signal);
    },

    async version(signal) {
      const res = await call("GET", "/version", { signal });
      if (res.status !== 200) fail("Couldn't read the Docker version", res);
      return JSON.parse(res.body.toString("utf8")) as DockerVersion;
    },

    async imageExists(image, signal) {
      parseImageRef(image);
      const res = await call("GET", `/images/${image}/json`, { signal });
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      fail(`Couldn't look up the image ${image}`, res);
    },

    async pullImage(image, auth, signal) {
      const ref = parseImageRef(image);
      const query = ref.digest
        ? { fromImage: `${ref.repository}@${ref.digest}` }
        : { fromImage: ref.repository, tag: ref.tag ?? "latest" };
      const headers: Record<string, string> = {};
      if (auth) {
        headers["X-Registry-Auth"] = Buffer.from(JSON.stringify(auth)).toString("base64url");
      }
      let pending = "";
      let streamError: string | null = null;
      const onLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as { error?: string; errorDetail?: { message?: string } };
          const message = event.errorDetail?.message ?? event.error;
          if (message) streamError = message;
        } catch {
          // Progress lines are JSON; ignore anything else.
        }
      };
      const res = await call("POST", "/images/create", {
        query,
        headers,
        signal,
        idleTimeoutMs: PULL_IDLE_TIMEOUT_MS,
        onData(chunk) {
          pending += chunk.toString("utf8");
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) onLine(line);
        },
      });
      onLine(pending);
      if (res.status < 200 || res.status >= 300) fail(`Couldn't pull ${image}`, res);
      if (streamError) throw new DockerError(`Couldn't pull ${image}: ${streamError}`);
    },

    async networkExists(name, signal) {
      const res = await call("GET", `/networks/${encodeURIComponent(name)}`, { signal });
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      fail(`Couldn't look up the network ${name}`, res);
    },

    async createContainer(name, spec, signal) {
      const res = await call("POST", "/containers/create", {
        query: { name: idPath(name) },
        body: spec,
        signal,
      });
      if (res.status !== 201) fail("Docker didn't create the container", res);
      return (JSON.parse(res.body.toString("utf8")) as { Id: string }).Id;
    },

    async startContainer(id, signal) {
      const res = await call("POST", `/containers/${idPath(id)}/start`, { signal });
      if (res.status !== 204 && res.status !== 304) fail("Docker didn't start the container", res);
    },

    async stopContainer(id, timeoutSeconds, signal) {
      const res = await call("POST", `/containers/${idPath(id)}/stop`, {
        query: { t: timeoutSeconds },
        signal,
        idleTimeoutMs: DEFAULT_TIMEOUT_MS + timeoutSeconds * 1000,
      });
      if (res.status === 404) return false;
      if (res.status !== 204 && res.status !== 304) fail("Docker didn't stop the container", res);
      return true;
    },

    async removeContainer(id, signal) {
      const res = await call("DELETE", `/containers/${idPath(id)}`, {
        query: { force: true, v: true },
        signal,
      });
      if (res.status === 404) return false;
      // 409 means a removal is already in progress, which is what we want.
      if (res.status !== 204 && res.status !== 409) fail("Docker didn't remove the container", res);
      return true;
    },

    async inspectContainer(id, signal) {
      const res = await call("GET", `/containers/${idPath(id)}/json`, { signal });
      if (res.status === 404) return null;
      if (res.status !== 200) fail("Couldn't inspect the container", res);
      return JSON.parse(res.body.toString("utf8")) as ContainerInfo;
    },

    async listContainers(labels, signal) {
      const res = await call("GET", "/containers/json", {
        query: { all: true, filters: JSON.stringify({ label: labels }) },
        signal,
      });
      if (res.status !== 200) fail("Couldn't list containers", res);
      return JSON.parse(res.body.toString("utf8")) as ContainerSummary[];
    },

    async containerLogs(id, signal) {
      const res = await call("GET", `/containers/${idPath(id)}/logs`, {
        query: { stdout: true, stderr: true },
        signal,
      });
      if (res.status !== 200) fail("Couldn't read the container's logs", res);
      return demuxLogs(res.body);
    },
  };
}
