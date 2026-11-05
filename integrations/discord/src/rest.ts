/**
 * A small Discord REST client. The connector only needs a handful of
 * endpoints, and a plain interface keeps the nodes and the connection test
 * easy to run against a fake.
 */

export const DISCORD_API = "https://discord.com/api/v10";

const USER_AGENT = "DiscordBot (https://sling.invalid, 0.0.0)";

export interface RestResponse {
  status: number;
  /** Parsed JSON, or the raw text when the body isn't JSON. */
  body: unknown;
  /** From the Retry-After header on rate-limited responses. */
  retryAfterMs?: number;
}

export interface DiscordRest {
  request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<RestResponse>;
}

export type RestFactory = (token: string) => DiscordRest;

/** People sometimes paste the token with its `Bot ` header prefix. */
export function normalizeToken(token: string): string {
  return token.trim().replace(/^Bot\s+/i, "");
}

export function createRest(
  token: string,
  options: { fetch?: typeof fetch; baseUrl?: string } = {},
): DiscordRest {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? DISCORD_API;
  const auth = `Bot ${normalizeToken(token)}`;
  return {
    async request(method, path, body, signal) {
      const headers: Record<string, string> = { Authorization: auth, "User-Agent": USER_AGENT };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      return {
        status: res.status,
        body: parsed,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      };
    },
  };
}

export function isOk(res: RestResponse): boolean {
  return res.status >= 200 && res.status < 300;
}

/** Discord's error body is `{ code, message }`. Falls back to the status. */
export function describeError(res: RestResponse): string {
  const body = res.body;
  if (body && typeof body === "object") {
    const { code, message } = body as { code?: unknown; message?: unknown };
    if (typeof message === "string") {
      return typeof code === "number" && code !== 0 ? `${message} (Discord code ${code})` : message;
    }
  }
  return `HTTP ${res.status}`;
}

export function field(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}
