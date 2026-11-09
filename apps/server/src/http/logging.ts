/** Request URLs can contain webhook credentials and OAuth authorization codes. */
export function safeRequestUrl(raw: string): string {
  const path = raw.split("?")[0] ?? "/";
  const safePath = path.startsWith("/hooks/") ? "/hooks/[REDACTED]" : path;
  return raw.includes("?") ? `${safePath}?[REDACTED]` : safePath;
}

export function requestLog(req: { method?: string; url?: string; hostname?: string; ip?: string }) {
  return {
    method: req.method,
    url: safeRequestUrl(req.url ?? "/"),
    hostname: req.hostname,
    remoteAddress: req.ip,
  };
}
