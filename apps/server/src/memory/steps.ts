import type { TraceRecorder } from "../agent/trace.ts";

/** A "Remembered" step in a reply still being written. */
interface LiveStep {
  trace: TraceRecorder;
  toolCallId: string;
}

/** Longer than any turn runs, so a step is never forgotten while its reply is written. */
const KEEP_MS = 15 * 60_000;

const live = new Map<string, LiveStep>();

/** Notes where a memory's "Remembered" step is, while its reply is being written. */
export function trackStep(memoryId: string, trace: TraceRecorder, toolCallId: string) {
  live.set(memoryId, { trace, toolCallId });
  setTimeout(() => live.delete(memoryId), KEEP_MS).unref?.();
}

/**
 * Marks a deleted memory's step undone in the reply being written, which
 * saves it that way. False when that reply is already saved.
 */
export function undoLiveStep(memoryId: string, text: string): boolean {
  const step = live.get(memoryId);
  live.delete(memoryId);
  if (!step || step.trace.finished) return false;
  step.trace.toolUpdate(step.toolCallId, { memory: { id: memoryId, text, undone: true } });
  return true;
}
