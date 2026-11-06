/** URLs and headers for talking to an ntfy server. */
import { DEFAULT_SERVER, type NtfyConfig, type NtfyCredentials } from "./schemas.ts";

/** The server URL without a trailing slash. */
export function baseUrl(config: Pick<NtfyConfig, "server">): string {
  return (config.server || DEFAULT_SERVER).replace(/\/+$/, "");
}

export function authHeaders(credentials: NtfyCredentials): Record<string, string> {
  const token = credentials.accessToken?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * ntfy takes the Authorization header in an `auth` query parameter, as
 * unpadded URL-safe base64, for clients such as WebSockets that can't set
 * headers.
 */
export function authParam(token: string): string {
  return btoa(`Bearer ${token}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `wss://<server>/<topics>/ws`, with `since` and `auth` when given. */
export function subscribeUrl(
  config: Pick<NtfyConfig, "server">,
  credentials: NtfyCredentials,
  topics: string[],
  since: string | null,
): string {
  const url = new URL(baseUrl(config));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${topics.join(",")}/ws`;
  if (since) url.searchParams.set("since", since);
  const token = credentials.accessToken?.trim();
  if (token) url.searchParams.set("auth", authParam(token));
  return url.toString();
}

/** The server and topics, for logs and status lines. Never includes the token. */
export function describeSubscription(config: Pick<NtfyConfig, "server">, topics: string[]): string {
  return `${new URL(baseUrl(config)).host}/${topics.join(",")}`;
}

/** ntfy's error body is `{ "code": 40301, "http": 403, "error": "forbidden" }`. */
export async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return text.trim().slice(0, 200) || res.statusText || `HTTP ${res.status}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof TypeError && error.cause instanceof Error) {
    return `${error.message}: ${error.cause.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
