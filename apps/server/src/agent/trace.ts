import type {
  LiveReplyView,
  ReplyPersonality,
  ReplyTrace,
  ServerEvent,
  ToolStep,
  TraceStep,
} from "@sling/core";
import { collectSources, pagesSeen } from "./citations.ts";
import { liveText, splitFollowUps } from "./follow-ups.ts";

/** Longest tool input kept as-is, and longest output kept, in characters. */
const INPUT_LIMIT = 4_000;
const OUTPUT_LIMIT = 2_000;
/** A JSON result keeps its shape: each long string in it is cut to this. */
const FIELD_LIMIT = 12_000;
const JSON_LIMIT = 24_000;

function shorten(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function shortenStrings(value: unknown): unknown {
  if (typeof value === "string") return shorten(value, FIELD_LIMIT);
  if (Array.isArray(value)) return value.map(shortenStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortenStrings(v)]));
  }
  return value;
}

/**
 * A tool's result as stored. JSON stays JSON, so the chat can still read a
 * command's output from it, with long strings cut; other text is cut whole.
 */
export function keptOutput(text: string): string {
  try {
    const json = JSON.stringify(shortenStrings(JSON.parse(text)));
    if (json.length <= JSON_LIMIT) return json;
  } catch {
    // Not JSON.
  }
  return shorten(text, OUTPUT_LIMIT);
}

/** Tool arguments as stored: as they are, or as shortened JSON when large. */
function keptInput(input: unknown): unknown {
  const json = JSON.stringify(input ?? null);
  return json.length > INPUT_LIMIT ? shorten(json, INPUT_LIMIT) : (input ?? null);
}

/**
 * Collects one reply's work in the order it happens: thinking, tool calls,
 * and the text written between them. It publishes each change so the chat
 * shows it live. Text followed by more work, such as "I'll check your
 * machines" before a tool call, becomes a step too, so the answer is only
 * what comes after the last step. The steps are saved with the reply for the
 * chat to show, and never go back to a model.
 *
 * The browser builds the same steps from the same events, in
 * `apps/web/src/lib/realtime.ts`.
 */
export class TraceRecorder {
  readonly #steps: TraceStep[] = [];
  readonly #started = Date.now();
  readonly #publish: (ev: ServerEvent) => void;
  readonly #conversationId: string;
  /** Text since the last step: the answer, unless more work follows it. */
  #text = "";
  /** How much of it went out live. The follow-ups block never does. */
  #shown = 0;
  #finished = false;
  /** Changes to tool calls that haven't been recorded yet. */
  readonly #early = new Map<string, Partial<ToolStep>>();

  constructor(conversationId: string, publish: (ev: ServerEvent) => void) {
    this.#conversationId = conversationId;
    this.#publish = publish;
  }

  /** Recorded with the reply, so it's known later which personality wrote it. */
  personality: ReplyPersonality | undefined;
  /** Written as Deep research. */
  research = false;
  /** Titles of pages the model's provider named, by URL, for the reply's citations. */
  readonly pageTitles = new Map<string, string>();
  /** Sling's own origin, whose source links cite documents. */
  publicOrigin = "";

  text(delta: string) {
    if (!delta) return;
    this.#text += delta;
    const shown = liveText(this.#text);
    if (shown.length <= this.#shown) return;
    const text = shown.slice(this.#shown);
    this.#shown = shown.length;
    this.#publish({ type: "agent.delta", conversationId: this.#conversationId, text });
  }

  thinking(text: string) {
    if (!text) return;
    this.#settleText();
    const last = this.#steps.at(-1);
    if (last?.kind === "thinking") last.text += text;
    else this.#steps.push({ kind: "thinking", text });
    this.#publish({ type: "agent.thinking", conversationId: this.#conversationId, text });
  }

  toolStarted(id: string, name: string, input: unknown) {
    this.#settleText();
    if (this.#tool(id)) return;
    const step: ToolStep = {
      kind: "tool",
      id,
      name,
      input: keptInput(input),
      status: "running",
      output: null,
      ...this.#early.get(id),
    };
    this.#early.delete(id);
    this.#steps.push(step);
    this.#emit(step);
  }

  /**
   * Changes a tool call while it runs, as when a command waits for approval,
   * or when a tool drops a value from its recorded input. A tool can start
   * before its call is recorded, so a change that comes first waits for it.
   */
  toolUpdate(
    id: string,
    patch: Pick<Partial<ToolStep>, "approval" | "input" | "memory" | "check">,
  ) {
    const step = this.#tool(id);
    if (!step) {
      this.#early.set(id, { ...this.#early.get(id), ...patch });
      return;
    }
    Object.assign(step, patch);
    this.#emit(step);
  }

  toolFinished(id: string, ok: boolean, output: unknown) {
    const step = this.#tool(id);
    if (!step) return;
    step.status = ok ? "done" : "error";
    const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
    step.output = keptOutput(text);
    this.#emit(step);
  }

  /** Whether the reply is done: a change now wouldn't be saved with it. */
  get finished(): boolean {
    return this.#finished;
  }

  /** The reply so far, for a chat opened while it's being written. */
  snapshot(): LiveReplyView {
    return {
      text: liveText(this.#text),
      steps: structuredClone(this.#steps),
      startedAt: this.#started,
    };
  }

  #tool(id: string): ToolStep | undefined {
    return this.#steps.find((s): s is ToolStep => s.kind === "tool" && s.id === id);
  }

  /**
   * The answer and what led to it. The answer is the text after the last
   * step. With none, the last text step stands in, and then `fallback`.
   * Its follow-ups come out of it first.
   */
  finish(fallback: string): { answer: string; trace: ReplyTrace | null } {
    this.#finished = true;
    let { text: answer, followUps } = splitFollowUps(this.#text.trim());
    if (!answer) {
      const i = this.#steps.findLastIndex((s) => s.kind === "text");
      const step = this.#steps[i];
      if (step?.kind === "text") {
        ({ text: answer, followUps } = splitFollowUps(step.text.trim()));
        this.#steps.splice(i, 1);
      }
    }
    if (!answer) ({ text: answer, followUps } = splitFollowUps(fallback.trim()));
    const more = followUps.length ? { followUps } : {};
    const steps = this.#steps.filter((s) => s.kind === "tool" || s.text.trim());
    const ms = Date.now() - this.#started;
    const sources = collectSources(answer, pagesSeen(steps, this.pageTitles), this.publicOrigin);
    const extra = {
      ...(sources.length ? { sources } : {}),
      ...more,
      ...(this.research ? { research: true } : {}),
    };
    if (this.personality) {
      return {
        answer,
        trace: {
          steps: structuredClone(steps),
          ms,
          personality: { ...this.personality },
          ...extra,
        },
      };
    }
    const keep = steps.length > 0 || sources.length > 0 || followUps.length > 0 || this.research;
    return { answer, trace: keep ? { steps: structuredClone(steps), ms, ...extra } : null };
  }

  #settleText() {
    this.#shown = 0;
    if (!this.#text.trim()) {
      this.#text = "";
      return;
    }
    this.#steps.push({ kind: "text", text: this.#text.trim() });
    this.#text = "";
  }

  #emit(step: ToolStep) {
    this.#publish({
      type: "agent.tool",
      conversationId: this.#conversationId,
      step: { ...step },
    });
  }
}
