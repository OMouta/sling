/**
 * Where a page of a list ended: the last row's sort time and ID, as an
 * opaque string the client passes back for the next page. Times keep the
 * milliseconds the app writes, so the next page starts exactly after it.
 */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(cursor: string): { at: string; id: string } | null {
  const [at, id, extra] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!at || !id || extra !== undefined || Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}
