const MAX_LABELS = 64;
const MAX_LABEL_LENGTH = 64;

/** Labels as stored: trimmed, lowercased, unique, and bounded. */
export function normalizeLabels(raw: readonly string[]): string[] {
  const out = new Set<string>();
  for (const l of raw) {
    const label = l.trim().toLowerCase();
    if (!label || label.length > MAX_LABEL_LENGTH) continue;
    out.add(label);
    if (out.size >= MAX_LABELS) break;
  }
  return [...out];
}

/**
 * A machine's labels plus `os:` and `arch:` from what it reported at
 * connect, for Runners that don't add those themselves.
 */
export function effectiveLabels(r: {
  labels: string[];
  os: string | null;
  arch: string | null;
}): string[] {
  const labels = [...r.labels];
  if (r.os && !labels.some((l) => l.startsWith("os:"))) labels.push(`os:${r.os.toLowerCase()}`);
  if (r.arch && !labels.some((l) => l.startsWith("arch:"))) {
    labels.push(`arch:${r.arch.toLowerCase()}`);
  }
  return labels;
}
