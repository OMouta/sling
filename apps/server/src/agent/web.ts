import { type AssistantProvider, canSearch, type PersonalityTool } from "@sling/core";
import type { MessageMeta } from "@sling/db";
import type { TraceRecorder } from "./trace.ts";

/** Model steps an API turn may take, and how long a CLI turn may run, for Deep research. */
export const RESEARCH_MAX_STEPS = 60;
export const RESEARCH_TURN_MS = 30 * 60_000;
/** Most of a page's text kept in its step. The chat shows only its site and title. */
const PAGE_TEXT_LIMIT = 2_000;

/** The names every provider's web steps go by. */
export const WEB_SEARCH = "web_search";
export const WEB_FETCH = "web_fetch";

/** Whether a turn searches the web: its personality has the web, on a model that searches. */
export function searchesWeb(
  tools: readonly PersonalityTool[],
  choice: { provider: AssistantProvider } | null | undefined,
): boolean {
  return tools.includes("web") && canSearch(choice);
}

/** Whether the message being answered asked for Deep research. */
export function wantsResearch(
  rows: readonly { role: string; meta?: MessageMeta | null }[],
): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r?.role === "assistant") return false;
    if (r?.role === "user") return r.meta?.research === true;
  }
  return false;
}

interface SearchResult {
  title: string;
  url: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function searchOutput(results: SearchResult[]) {
  return { results };
}

function pageOutput(title: string, text: string) {
  return {
    ...(title ? { title } : {}),
    text: text.length > PAGE_TEXT_LIMIT ? `${text.slice(0, PAGE_TEXT_LIMIT)}…` : text,
  };
}

/** Links from a list of `{ url, title? }`, skipping anything without a URL. */
function links(items: unknown): SearchResult[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((r) => {
    const url = str((r as { url?: unknown } | null)?.url);
    return url ? [{ title: str((r as { title?: unknown }).title), url }] : [];
  });
}

/**
 * A provider's own web call, as the step every provider's search shares:
 * `web_search` with `{ query }` and `{ results }`, or `web_fetch` with
 * `{ url }` and `{ title?, text }`. Anthropic's calls carry their input,
 * while OpenAI's say what they did only in their result.
 */
function webStep(
  toolName: string,
  input: unknown,
  output: unknown,
): { name: string; input: { query: string } | { url: string }; output: unknown } | null {
  const i = (input ?? {}) as Record<string, unknown>;
  const o = (output ?? {}) as Record<string, unknown>;
  if (toolName === WEB_FETCH) {
    const content = (o.content ?? {}) as {
      title?: unknown;
      source?: { type?: unknown; data?: unknown };
    };
    const text = content.source?.type === "text" ? str(content.source.data) : "";
    return {
      name: WEB_FETCH,
      input: { url: str(i.url) || str(o.url) },
      output: pageOutput(str(content.title), text),
    };
  }
  if (toolName !== WEB_SEARCH) return null;
  const action = (o.action ?? {}) as Record<string, unknown>;
  if (action.type === "openPage" || action.type === "findInPage") {
    return { name: WEB_FETCH, input: { url: str(action.url) }, output: pageOutput("", "") };
  }
  const queries = Array.isArray(action.queries) ? action.queries : [];
  const query = str(i.query) || str(action.query) || str(queries[0]);
  // Anthropic's results are a list of pages, and OpenAI's carry only URLs.
  const results = Array.isArray(output) ? links(output) : links(o.sources);
  return { name: WEB_SEARCH, input: { query }, output: searchOutput(results) };
}

/** The parts of an API turn's `fullStream` this reads. */
export interface WebStreamPart {
  type: string;
  toolCallId?: string;
  toolName?: string;
  providerExecuted?: boolean;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  sourceType?: string;
  url?: string;
  title?: string;
}

/**
 * Records a provider's own web search and page reads in the trace, under
 * the same steps a CLI's give. A call starts its step when its input says
 * what it does, else when its result comes. Source parts become the titles
 * citations are shown with.
 */
export class ProviderWebSteps {
  readonly #trace: TraceRecorder;
  /** Calls whose step waits for their result, by ID: their input. */
  readonly #waiting = new Map<string, unknown>();

  constructor(trace: TraceRecorder) {
    this.#trace = trace;
  }

  /** Handles a part that belongs to a provider's web call. False for any other part. */
  handle(part: WebStreamPart): boolean {
    if (part.type === "source") {
      if (part.sourceType === "url" && part.url && part.title) {
        this.#trace.pageTitles.set(part.url, part.title);
      }
      return true;
    }
    const id = part.toolCallId ?? "";
    const name = part.toolName ?? "";
    if (!part.providerExecuted || (name !== WEB_SEARCH && name !== WEB_FETCH)) return false;
    if (part.type === "tool-call") {
      const step = webStep(name, part.input, null);
      const known = step && ("url" in step.input ? step.input.url : step.input.query);
      if (step && known) this.#trace.toolStarted(id, step.name, step.input);
      else this.#waiting.set(id, part.input);
      return true;
    }
    if (part.type === "tool-result" || part.type === "tool-error") {
      const ok = part.type === "tool-result";
      const step = webStep(name, this.#waiting.get(id) ?? part.input, ok ? part.output : null);
      if (this.#waiting.delete(id) && step) this.#trace.toolStarted(id, step.name, step.input);
      this.#trace.toolFinished(id, ok, ok ? step?.output : errorText(part.error));
      return true;
    }
    return false;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const code = (error as { errorCode?: unknown }).errorCode;
    if (typeof code === "string") return code;
    return JSON.stringify(error);
  }
  return String(error);
}

/** A CLI's built-in web call, as the Runner sends it. */
export function cliToolStarted(
  trace: TraceRecorder | undefined,
  use: { id: string; name: string; inputJson: string },
) {
  if (!trace || !use.id) return;
  let input: unknown = null;
  try {
    input = JSON.parse(use.inputJson);
  } catch {
    input = use.inputJson;
  }
  trace.toolStarted(use.id, use.name, input);
}

/** A CLI built-in tool's result. A page's text is cut, since its step shows only the page. */
export function cliToolFinished(
  trace: TraceRecorder | undefined,
  result: { id: string; output: string; error: boolean },
) {
  if (!trace) return;
  if (result.error) {
    trace.toolFinished(result.id, false, result.output);
    return;
  }
  let output: unknown = result.output;
  try {
    const o = JSON.parse(result.output) as { title?: unknown; text?: unknown };
    output = typeof o.text === "string" ? pageOutput(str(o.title), o.text) : o;
  } catch {
    // Not JSON: kept as text.
  }
  trace.toolFinished(result.id, true, output);
}
