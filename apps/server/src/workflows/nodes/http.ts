import { NodeError } from "@sling/workflow";
import { z } from "zod";
import { defineNode } from "../types.ts";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
/** Responses bigger than this are cut off. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function readBody(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new NodeError(`The response is bigger than ${MAX_BODY_BYTES} bytes`, {
        code: "response_too_large",
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const httpRequestNode = defineNode({
  type: "http.request",
  version: 1,
  title: "HTTP request",
  description:
    "Calls a URL. GET and HEAD are retried on network errors, 429, and 5xx; other methods are never retried automatically.",
  category: "action",
  configSchema: z.object({
    method: z.enum(METHODS).default("GET").describe("HTTP method."),
    url: z.string().min(1).describe("The URL, http or https. May be an expression."),
    headers: z
      .record(z.string(), z.string())
      .default({})
      .describe("Request headers, as a JSON object of strings.")
      .meta({ widget: "json" }),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(120_000)
      .default(30_000)
      .describe("Give up after this many milliseconds."),
    failOnError: z
      .boolean()
      .default(true)
      .describe("Fail the node on a 4xx or 5xx response. Turn off to pass every response on."),
  }),
  expressionFields: ["url", "headers"],
  inputs: [
    {
      name: "body",
      type: "json",
      description: "Request body. Objects are sent as JSON; strings are sent as they are.",
    },
  ],
  outputs: [{ name: "response", type: "http.response", description: "Status, headers, and body." }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: false,
  idempotentWhen: (config) =>
    config.method === undefined || config.method === "GET" || config.method === "HEAD",
  retry: { maxAttempts: 3, backoffMs: 1000 },
  run: async (ctx, { inputs, config }) => {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new NodeError(`Not a URL: ${config.url}`, { code: "invalid_url" });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new NodeError("Only http and https URLs are allowed", { code: "invalid_url" });
    }
    const headers = new Headers(config.headers);
    let body: string | undefined;
    const raw = inputs.body;
    if (raw !== null && raw !== undefined && config.method !== "GET" && config.method !== "HEAD") {
      if (typeof raw === "string") {
        body = raw;
      } else {
        body = JSON.stringify(raw);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: config.method,
        headers,
        body,
        redirect: "follow",
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(config.timeoutMs)]),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new NodeError(
        timedOut
          ? `No response within ${config.timeoutMs} ms`
          : `Request failed: ${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)}`,
        { code: timedOut ? "timeout" : "network_error", retryable: true },
      );
    }
    const text = config.method === "HEAD" ? "" : await readBody(res);
    let parsed: unknown = text;
    if ((res.headers.get("content-type") ?? "").includes("json") && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const response = {
      status: res.status,
      ok: res.ok,
      headers: Object.fromEntries(res.headers),
      body: parsed,
      durationMs: Date.now() - started,
    };
    if (!res.ok && config.failOnError) {
      throw new NodeError(`HTTP ${res.status} from ${url.host}`, {
        code: "http_error",
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    return { exec: "next", outputs: { response } };
  },
});
