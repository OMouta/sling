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

function send(method: string, path: string, body?: unknown): Promise<Response> {
  const raw = body instanceof Blob;
  return fetch(path, {
    method,
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
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
  get: <T>(path: string) => request<T>("GET", path),
  /** A `Blob` body goes up as raw bytes; anything else as JSON. */
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
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
