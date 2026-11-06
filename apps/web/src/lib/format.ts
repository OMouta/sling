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

/** "850 ms", "3.2 s", "4m 05s", "1h 02m". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function between(start: string | null, end: string | null, now = Date.now()): number | null {
  if (!start) return null;
  return (end ? new Date(end).getTime() : now) - new Date(start).getTime();
}

/**
 * A coding agent's summary links files by their path on its own machine,
 * which leads nowhere in a browser. Shows each such link's text as code.
 */
export function withoutLocalLinks(markdown: string): string {
  return markdown.replace(
    /\[([^\]\n]+)\]\(((?:\/|~\/|file:)[^)\s]*)\)/g,
    (_m, text: string) => `\`${text.replaceAll("`", "")}\``,
  );
}
