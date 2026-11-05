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

  constructor(conversationId: string, publish: (ev: ServerEvent) => void) {
    this.#conversationId = conversationId;
    this.#publish = publish;
  }

  text(delta: string) {
    if (!delta) return;
    this.#text += delta;
    this.#publish({ type: "agent.delta", conversationId: this.#conversationId, text: delta });
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

  /**
   * The answer and what led to it. The answer is the text after the last
   * step. With none, the last text step stands in, and then `fallback`.
   */
  finish(fallback: string): { answer: string; trace: ReplyTrace | null } {
    let answer = this.#text.trim();
    if (!answer) {
      const i = this.#steps.findLastIndex((s) => s.kind === "text");
      const step = this.#steps[i];
      if (step?.kind === "text") {
        answer = step.text.trim();
        this.#steps.splice(i, 1);
      }
    }
    if (!answer) answer = fallback.trim();
    const steps = this.#steps.filter((s) => s.kind === "tool" || s.text.trim());
    return {
      answer,
      trace: steps.length > 0 ? { steps: structuredClone(steps), ms: Date.now() - this.#started } : null,
    };
  }

  #settleText() {
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
