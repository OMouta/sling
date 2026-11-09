/** Small fetch wrapper for the control plane API. Same origin, cookie auth. */

export class ApiError extends Error {
  readonly status: number;
  /** Parsed response body, for endpoints that explain a failure in it. */
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * Why an answer to an approval came too late, when the server said so: it
 * was answered elsewhere, expired, or a restart ended it. Null otherwise.
 */
export function lateAnswer(error: unknown): string | null {
  return error instanceof ApiError && error.status === 409 ? error.message : null;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function send(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<Response> {
  const raw = body instanceof Blob;
  return fetch(path, {
    method,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 60_000)])
      : AbortSignal.timeout(options.timeoutMs ?? 60_000),
    credentials: "same-origin",
    headers:
      body === undefined
        ? {}
        : { "content-type": raw ? "application/octet-stream" : "application/json" },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
}

async function failure(res: Response): Promise<ApiError> {
  const text = await res.text();
  let data: { error?: string; message?: string } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the status line.
  }
  const message = data?.error ?? data?.message ?? `Request failed (${res.status})`;
  return new ApiError(res.status, message, data);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const res = await send(method, path, body, options);
  if (!res.ok) throw await failure(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** A file the server sends back, with the name from its Content-Disposition. */
async function download(path: string, body: unknown, fallbackName: string) {
  const res = await send("POST", path, body);
  if (!res.ok) throw await failure(res);
  const disposition = res.headers.get("content-disposition") ?? "";
  const name =
    /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ??
    /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  return { blob: await res.blob(), fileName: name ? decodeURIComponent(name) : fallbackName };
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>("GET", path, undefined, options),
  /** A `Blob` body goes up as raw bytes; anything else as JSON. */
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>("POST", path, body ?? {}, options),
  put: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>("PUT", path, body, options),
  patch: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>("PATCH", path, body, options),
  del: <T>(path: string, options?: RequestOptions) =>
    request<T>("DELETE", path, undefined, options),
  download,
};

/** Saves a blob through the browser's download prompt. */
export function saveBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
