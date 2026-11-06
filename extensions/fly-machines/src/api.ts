/**
 * The slice of the Fly Machines API the provider uses, over the global fetch.
 * https://fly.io/docs/machines/api/
 */
import { DEFAULT_API_URL } from "./schemas.ts";

export interface FlyMachine {
  id: string;
  name?: string;
  /** created, starting, started, stopping, stopped, destroying, destroyed, ... */
  state: string;
  region?: string;
  created_at?: string;
  config?: { image?: string; metadata?: Record<string, string> };
}

export interface MachineRequest {
  name: string;
  region?: string;
  config: {
    image: string;
    env: Record<string, string>;
    guest: { cpu_kind: "shared" | "performance"; cpus: number; memory_mb: number };
    auto_destroy: boolean;
    restart: { policy: "no" | "on-failure" | "always" };
    metadata: Record<string, string>;
  };
}

/** A response the provider didn't expect, with Fly's own message. */
export class FlyApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string, message: string) {
    super(message);
    this.name = "FlyApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** The most list pages read in one call. Fly pages hold up to 1,000 Machines. */
const MAX_PAGES = 10;

async function detailOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return text.trim().slice(0, 300) || `HTTP ${res.status}`;
}

export function describeStatus(status: number, detail: string, app: string): string {
  if (status === 401 || status === 403) {
    return `Fly rejected the API token (${detail}). Create one with fly tokens create deploy --app ${app} and paste all of it.`;
  }
  if (status === 404) {
    return `Fly has no app called ${app} that this token can reach. Create it with fly apps create ${app}, or check the token's organization.`;
  }
  if (status === 429) return `Fly is rate limiting requests: ${detail}`;
  if (status >= 500) return `Fly's API failed (${status}): ${detail}`;
  return `Fly refused the request (${status}): ${detail}`;
}

export class FlyApi {
  readonly #base: string;
  readonly #token: string;
  readonly #app: string;
  readonly #signal: AbortSignal;

  constructor(options: { apiUrl?: string; token: string; app: string; signal: AbortSignal }) {
    this.#base = `${(options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "")}/v1`;
    this.#token = options.token;
    this.#app = options.app;
    this.#signal = options.signal;
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.#signal,
      });
    } catch (error) {
      if (this.#signal.aborted) throw error;
      const cause =
        error instanceof TypeError && error.cause instanceof Error
          ? `: ${error.cause.message}`
          : "";
      throw new Error(`Couldn't reach the Fly Machines API at ${this.#base}${cause}`, {
        cause: error,
      });
    }
  }

  async #fail(res: Response): Promise<never> {
    const detail = await detailOf(res);
    throw new FlyApiError(res.status, detail, describeStatus(res.status, detail, this.#app));
  }

  #appPath(rest = ""): string {
    return `/apps/${encodeURIComponent(this.#app)}${rest}`;
  }

  async getApp(): Promise<{ name: string; organization?: { slug?: string; name?: string } }> {
    const res = await this.#request("GET", this.#appPath());
    if (!res.ok) return this.#fail(res);
    return res.json();
  }

  async createMachine(request: MachineRequest): Promise<FlyMachine> {
    const res = await this.#request("POST", this.#appPath("/machines"), request);
    if (!res.ok) return this.#fail(res);
    return res.json();
  }

  /** Machines whose metadata has each key and value given, following Fly's page cursor. */
  async listMachines(metadata: Record<string, string>): Promise<FlyMachine[]> {
    const all: FlyMachine[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ include_deleted: "false" });
      for (const [k, v] of Object.entries(metadata)) query.set(`metadata.${k}`, v);
      if (cursor) query.set("cursor", cursor);
      const res = await this.#request("GET", this.#appPath(`/machines?${query}`));
      if (!res.ok) return this.#fail(res);
      all.push(...((await res.json()) as FlyMachine[]));
      cursor = res.headers.get("fly-next-cursor");
      if (!cursor) break;
    }
    return all;
  }

  /** Stops and deletes a Machine. A Machine that's already gone counts as deleted. */
  async deleteMachine(id: string): Promise<"deleted" | "missing"> {
    const res = await this.#request(
      "DELETE",
      this.#appPath(`/machines/${encodeURIComponent(id)}?force=true`),
    );
    if (res.status === 404) return "missing";
    if (!res.ok) return this.#fail(res);
    return "deleted";
  }
}
