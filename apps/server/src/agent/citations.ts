import type { ReplySource, TraceStep } from "@sling/core";

/** `[3](https://…)`, with an optional `<…>` around the URL and a title after it. */
const CITATION =
  /\[(\d{1,3})\]\(\s*<?(https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)>?(?:\s+"[^"]*")?\s*\)/g;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
/** Sling's own link to a page of a document source. */
const DOCUMENT_PATH = /\/api\/sources\/([^/]+)\/view$/;

/** A URL as compared: no fragment, no trailing slash. */
function urlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.href;
  } catch {
    return url;
  }
}

/** The site's name for a URL: its hostname without `www.`. */
export function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function record(seen: Map<string, string>, url: unknown, title: unknown) {
  if (typeof url !== "string" || typeof title !== "string" || !title.trim()) return;
  const key = urlKey(url);
  if (!seen.has(key)) seen.set(key, title.trim());
}

/** Every `{ url | link, title | name }` in a tool's output, a few levels down. */
function walk(value: unknown, seen: Map<string, string>, depth: number) {
  if (depth > 4 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) walk(v, seen, depth + 1);
    return;
  }
  const o = value as Record<string, unknown>;
  record(seen, o.url ?? o.link, o.title ?? o.name);
  for (const v of Object.values(o)) walk(v, seen, depth + 1);
}

/**
 * Titles of the pages and documents a turn saw, by URL: search results,
 * pages it opened, and documents its source tools returned, then `extra`,
 * such as an API's source parts.
 */
export function pagesSeen(
  steps: readonly TraceStep[],
  extra: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const seen = new Map<string, string>();
  for (const s of steps) {
    if (s.kind !== "tool" || !s.output) continue;
    let output: unknown;
    try {
      output = JSON.parse(s.output);
    } catch {
      continue;
    }
    if (s.name === "web_fetch") {
      const input = s.input as { url?: unknown } | null;
      record(seen, input?.url, (output as { title?: unknown } | null)?.title);
    } else {
      walk(output, seen, 0);
    }
  }
  for (const [url, title] of extra) record(seen, url, title);
  return seen;
}

/**
 * The sources a reply cites: each Markdown link whose text is a number, once
 * per URL, in the order first cited, under the number it was first cited
 * by. A link to one of Sling's own documents, at `origin`, is a document
 * source with its page.
 */
export function collectSources(
  answer: string,
  seen: ReadonlyMap<string, string>,
  origin = "",
): ReplySource[] {
  const out: ReplySource[] = [];
  const cited = new Set<string>();
  for (const m of answer.replace(CODE, "").matchAll(CITATION)) {
    const n = Number(m[1]);
    const url = m[2] ?? "";
    const key = urlKey(url);
    if (!n || cited.has(key)) continue;
    cited.add(key);
    const title = seen.get(key);
    const doc = documentLink(url, origin);
    if (doc) {
      out.push({ n, url, title: title ?? "Document", kind: "document", ...doc });
    } else {
      out.push({ n, url, title: title ?? siteName(url), kind: "web" });
    }
  }
  return out;
}

function documentLink(url: string, origin: string): { sourceId: string; page?: number } | null {
  if (!origin) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const id = u.origin === origin ? DOCUMENT_PATH.exec(u.pathname)?.[1] : undefined;
  if (!id) return null;
  const page = Number(u.searchParams.get("page"));
  return {
    sourceId: decodeURIComponent(id),
    ...(Number.isInteger(page) && page > 0 ? { page } : {}),
  };
}
