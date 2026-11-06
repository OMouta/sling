/**
 * A fake Fly Machines API on a local port, for tests. It keeps Machines in
 * memory and answers the requests the provider makes the way Fly documents
 * them: 200 on create, `metadata.<key>` filters and `fly-next-cursor` pages on
 * list, 404 for a missing Machine, and 412 when deleting a running Machine
 * without force.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  created_at: string;
  config: {
    image: string;
    env: Record<string, string>;
    guest: { cpu_kind: string; cpus: number; memory_mb: number };
    auto_destroy?: boolean;
    restart?: { policy: string };
    metadata?: Record<string, string>;
  };
}

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
  body: unknown;
}

export interface FakeMachinesApi {
  url: string;
  token: string;
  apps: Set<string>;
  machines: Map<string, FakeMachine & { app: string }>;
  requests: FakeRequest[];
  /** Machines per list page. */
  pageSize: number;
  /** Called after each create, for example to start the sandbox's Runner locally. */
  onCreate: ((machine: FakeMachine) => void | Promise<void>) | null;
  /** Answers the next request with this instead. */
  failNext: { status: number; error: string } | null;
  close(): Promise<void>;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
  if (!text) return undefined;
  return JSON.parse(text);
}

export async function startFakeMachinesApi(
  options: { token?: string; apps?: string[] } = {},
): Promise<FakeMachinesApi> {
  const api: FakeMachinesApi = {
    url: "",
    token: options.token ?? "fly-test-token",
    apps: new Set(options.apps ?? ["sling-sandboxes"]),
    machines: new Map(),
    requests: [],
    pageSize: 50,
    onCreate: null,
    failNext: null,
    close: async () => {},
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const body = await readBody(req).catch(() => null);
    api.requests.push({
      method: req.method ?? "",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization,
      body,
    });
    if (api.failNext) {
      const { status, error } = api.failNext;
      api.failNext = null;
      return send(res, status, { error });
    }
    if (req.headers.authorization !== `Bearer ${api.token}`) {
      return send(res, 401, { error: "You must be authenticated to view this." });
    }
    const m = /^\/v1\/apps\/([^/]+)(\/machines(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (!m) return send(res, 404, { error: "not found" });
    const app = decodeURIComponent(m[1] as string);
    if (!api.apps.has(app)) return send(res, 404, { error: "app not found" });

    if (!m[2]) {
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      return send(res, 200, {
        id: "app123",
        name: app,
        status: "deployed",
        organization: { name: "Personal", slug: "personal" },
      });
    }

    const machineId = m[3] ? decodeURIComponent(m[3]) : null;
    if (!machineId && req.method === "POST") {
      const r = body as { name?: string; region?: string; config?: FakeMachine["config"] };
      if (!r?.config?.image) return send(res, 422, { error: "image is required" });
      const guest = r.config.guest;
      if (!guest || guest.memory_mb % 256 !== 0) {
        return send(res, 422, { error: "memory_mb must be a multiple of 256" });
      }
      const machine: FakeMachine & { app: string } = {
        app,
        id: randomBytes(7).toString("hex"),
        name: r.name ?? "random-name",
        state: "started",
        region: r.region ?? "iad",
        created_at: new Date().toISOString(),
        config: r.config,
      };
      api.machines.set(machine.id, machine);
      await api.onCreate?.(machine);
      const { app: _app, ...out } = machine;
      return send(res, 200, out);
    }

    if (!machineId && req.method === "GET") {
      const filters = [...url.searchParams].filter(([k]) => k.startsWith("metadata."));
      const includeDeleted = url.searchParams.get("include_deleted") === "true";
      const all = [...api.machines.values()].filter(
        (x) =>
          x.app === app &&
          (includeDeleted || x.state !== "destroyed") &&
          filters.every(([k, v]) => x.config.metadata?.[k.slice("metadata.".length)] === v),
      );
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = all.slice(start, start + api.pageSize);
      const next = start + api.pageSize < all.length ? String(start + api.pageSize) : null;
      return send(
        res,
        200,
        page.map(({ app: _app, ...x }) => x),
        next ? { "fly-next-cursor": next } : {},
      );
    }

    if (machineId && req.method === "DELETE") {
      const machine = api.machines.get(machineId);
      if (!machine || machine.app !== app) return send(res, 404, { error: "machine not found" });
      if (machine.state === "destroyed") return send(res, 200, { ok: true });
      if (machine.state === "started" && url.searchParams.get("force") !== "true") {
        return send(res, 412, { error: "machine is running, stop it first or use force" });
      }
      machine.state = "destroyed";
      return send(res, 200, { ok: true });
    }

    return send(res, 405, { error: "method not allowed" });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () => new Promise<void>((r) => server.close(() => r()));
  return api;
}
