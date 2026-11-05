const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : "";
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
