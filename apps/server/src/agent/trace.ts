import type { ReplyTrace, ServerEvent, ToolStep, TraceStep } from "@sling/core";

/** Longest tool input kept as-is, and longest output kept, in characters. */
const INPUT_LIMIT = 4_000;
const OUTPUT_LIMIT = 2_000;

function shorten(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Tool arguments as stored: as they are, or as shortened JSON when large. */
function keptInput(input: unknown): unknown {
  const json = JSON.stringify(input ?? null);
  return json.length > INPUT_LIMIT ? shorten(json, INPUT_LIMIT) : (input ?? null);
}

/**
 * Collects one reply's thinking and tool calls in the order they happen,
 * and publishes each change so the chat shows it live. The steps are saved
 * with the reply, for the chat to show later. They never go back to a model.
 */
export class TraceRecorder {
  readonly #steps: TraceStep[] = [];
  readonly #started = Date.now();
  readonly #publish: (ev: ServerEvent) => void;
  readonly #conversationId: string;

  constructor(conversationId: string, publish: (ev: ServerEvent) => void) {
    this.#conversationId = conversationId;
    this.#publish = publish;
  }

  thinking(text: string) {
    if (!text) return;
    const last = this.#steps.at(-1);
    if (last?.kind === "thinking") last.text += text;
    else this.#steps.push({ kind: "thinking", text });
    this.#publish({ type: "agent.thinking", conversationId: this.#conversationId, text });
  }

  toolStarted(id: string, name: string, input: unknown) {
    const step: ToolStep = {
      kind: "tool",
      id,
      name,
      input: keptInput(input),
      status: "running",
      output: null,
    };
    this.#steps.push(step);
    this.#emit(step);
  }

  toolFinished(id: string, ok: boolean, output: unknown) {
    const step = this.#steps.find((s): s is ToolStep => s.kind === "tool" && s.id === id);
    if (!step) return;
    step.status = ok ? "done" : "error";
    const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
    step.output = shorten(text, OUTPUT_LIMIT);
    this.#emit(step);
  }

  /** What to save with the reply, or null when there was nothing to show. */
  result(): ReplyTrace | null {
    const steps = this.#steps.filter((s) => s.kind !== "thinking" || s.text.trim());
    if (steps.length === 0) return null;
    return { steps: structuredClone(steps), ms: Date.now() - this.#started };
  }

  #emit(step: ToolStep) {
    this.#publish({
      type: "agent.tool",
      conversationId: this.#conversationId,
      step: { ...step },
    });
  }
}
