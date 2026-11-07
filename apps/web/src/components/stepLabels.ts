import type { ToolStep } from "@sling/core";

function parse<T>(text: string | null): T | null {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

const input = (step: ToolStep) =>
  (step.input && typeof step.input === "object" ? step.input : {}) as Record<string, unknown>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "es"}`;

/**
 * What a memory, files, or sources step did, naming what it looked for or
 * read. Null for other tools.
 */
export function memoryFileLabel(step: ToolStep): string | null {
  if (step.name === "recall") {
    const query = String(input(step).query ?? "");
    if (step.status === "running") return `Looking in memory for “${query}”`;
    if (step.status === "error") return "Couldn't look in memory";
    return `Looked in memory for “${query}”`;
  }
  if (step.name === "forget") {
    const out = parse<{ error?: string }>(step.output);
    if (step.status === "running") return "Forgetting";
    if (step.status === "error" || out?.error) return "Couldn't forget it";
    return "Forgot it";
  }
  if (step.name === "search_files") {
    const query = String(input(step).query ?? "");
    const out = parse<{ hits?: unknown[]; error?: string; errors?: { error: string }[] }>(
      step.output,
    );
    if (step.status === "running") return `Searching your files for “${query}”`;
    const failed = out?.error ?? (out?.hits?.length ? null : out?.errors?.[0]?.error);
    if (step.status === "error" || failed) {
      return `Couldn't search your files${failed ? `: ${failed}` : ""}`;
    }
    const n = out?.hits?.length ?? 0;
    return `Searched your files for “${query}”: ${n ? plural(n, "match") : "no matches"}`;
  }
  if (step.name === "read_file") {
    const i = input(step);
    const path = String(i.path ?? "").replace(/^\.?\/+/, "");
    const where = [i.folder, path].filter(Boolean).join("/");
    const out = parse<{ error?: string }>(step.output);
    if (step.status === "running") return `Reading ${where}`;
    if (step.status === "error" || out?.error) {
      return `Couldn't read ${where}${out?.error ? `: ${out.error}` : ""}`;
    }
    return `Read ${where}`;
  }
  if (step.name === "search_sources") {
    const query = String(input(step).query ?? "");
    const out = parse<{ results?: unknown[]; error?: string }>(step.output);
    if (step.status === "running") return `Searching sources for “${query}”`;
    if (step.status === "error" || out?.error) return "Couldn't search sources";
    const n = out?.results?.length ?? 0;
    return `Searched sources for “${query}”: ${n ? plural(n, "match") : "no matches"}`;
  }
  if (step.name === "read_source") {
    const out = parse<{ name?: string; fromPage?: number; toPage?: number; error?: string }>(
      step.output,
    );
    if (step.status === "running") return "Reading a source";
    if (step.status === "error" || out?.error) return "Couldn't read the source";
    const pages =
      out?.fromPage && out.toPage
        ? out.fromPage === out.toPage
          ? `, page ${out.fromPage}`
          : `, pages ${out.fromPage}–${out.toPage}`
        : "";
    return `Read ${out?.name ?? "a source"}${pages}`;
  }
  return null;
}
