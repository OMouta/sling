/** Largest stored size of a node run's inputs or outputs, as JSON. */
export const PAYLOAD_CAP_BYTES = 64 * 1024;
/** How much of an oversized payload is kept as a preview. */
const PREVIEW_CHARS = 4 * 1024;

export const REDACTED = "[redacted]";

/** Keys whose values are credentials wherever they appear. */
const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_secret|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|bot[-_]?token|private[-_]?key)$/i;

function scrubString(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const s of secrets) {
    if (s.length >= 4 && out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out;
}

function scrub(value: unknown, secrets: readonly string[], depth: number): unknown {
  if (typeof value === "string") return scrubString(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (depth > 64) return "[too deep]";
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] =
      SENSITIVE_KEY.test(k) && v !== null && v !== "" ? REDACTED : scrub(v, secrets, depth + 1);
  }
  return out;
}

/**
 * Prepares a node run's inputs or outputs for storage: credential values and
 * fields named like credentials are replaced, and anything over 64 KB is cut
 * down to a marker with a preview.
 */
export function redactPayload(
  value: Record<string, unknown> | null | undefined,
  secrets: readonly string[] = [],
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const clean = scrub(value, secrets, 0) as Record<string, unknown>;
  let json: string;
  try {
    json = JSON.stringify(clean);
  } catch {
    return { _truncated: true, size: 0, preview: "[not serializable]" };
  }
  const size = Buffer.byteLength(json);
  if (size <= PAYLOAD_CAP_BYTES) return clean;
  return { _truncated: true, size, preview: json.slice(0, PREVIEW_CHARS) };
}

/**
 * The values of a connector's secret credential fields, for value-based
 * redaction. Nested strings under a secret field count too.
 */
export function secretStrings(
  credentials: Record<string, unknown>,
  secretFields: readonly string[],
  out: Set<string> = new Set(),
): Set<string> {
  const collect = (v: unknown) => {
    if (typeof v === "string") {
      if (v.length >= 4) out.add(v);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) collect(x);
    }
  };
  for (const f of secretFields) collect(credentials[f]);
  return out;
}
