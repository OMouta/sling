import { type AssistantChoice, canSearch, type PersonalityView, type TraceStep } from "@sling/core";

/** Whether Deep research is offered: the personality has the web, on a model that searches. */
export function canResearch(
  personality: Pick<PersonalityView, "tools"> | null | undefined,
  assistant: AssistantChoice | null | undefined,
): boolean {
  return Boolean(personality?.tools.includes("web")) && canSearch(assistant);
}

/** How many searches a reply ran and pages it opened. */
export function webCounts(steps: readonly TraceStep[]): { searches: number; pages: number } {
  let searches = 0;
  let pages = 0;
  for (const s of steps) {
    if (s.kind !== "tool") continue;
    if (s.name === "web_search") searches++;
    else if (s.name === "web_fetch") pages++;
  }
  return { searches, pages };
}

/** "3 searches · 2 pages", leaving out what's zero. */
export function webCountsText({ searches, pages }: { searches: number; pages: number }): string {
  return [
    searches ? `${searches} ${searches === 1 ? "search" : "searches"}` : "",
    pages ? `${pages} ${pages === 1 ? "page" : "pages"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A site's name: its hostname without `www.`. */
export function siteName(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "12s", "4m 05s", "1h 02m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
