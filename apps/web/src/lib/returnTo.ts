/**
 * The page to open after signing in. Only a path on this site counts, so a
 * crafted link can't send someone elsewhere after they sign in.
 */
export function returnPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return undefined;
  }
  if (url.origin !== window.location.origin) return undefined;
  if (url.pathname === "/" || url.pathname === "/login" || url.pathname === "/setup") {
    return undefined;
  }
  return url.pathname + url.search + url.hash;
}
