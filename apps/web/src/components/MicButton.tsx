import { Mic } from "lucide-react";
import { useRef } from "react";
import type { Dictation } from "../lib/dictation.ts";
import { cx } from "./ui.tsx";

/** A press at least this long is a hold: letting go stops. A shorter one is a tap. */
export const HOLD_MS = 300;

/**
 * The composer's mic. Hold it to talk and let go to stop, or tap it to start
 * and tap again to stop. Enter and Space toggle it. Nothing shows where the
 * browser has no speech recognition.
 */
export function MicButton({ dictation, disabled }: { dictation: Dictation; disabled?: boolean }) {
  const press = useRef<{ at: number; started: boolean } | null>(null);
  if (!dictation.supported) return null;
  const { listening, hearing } = dictation;

  return (
    <button
      type="button"
      aria-label={listening ? "Stop dictating" : "Dictate"}
      aria-pressed={listening}
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // Keeps the focus where it was, so the composer stays the one typing.
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        press.current = { at: performance.now(), started: !listening };
        if (!listening) dictation.start();
      }}
      onPointerUp={() => {
        const p = press.current;
        press.current = null;
        if (!p) return;
        // A second tap stops. A hold stops on release, once the mic was on:
        // a first press that waited on the browser's permission prompt stays on.
        if (!p.started || (hearing && performance.now() - p.at >= HOLD_MS)) dictation.stop();
      }}
      onPointerCancel={() => {
        if (!press.current) return;
        press.current = null;
        dictation.stop();
      }}
      onClick={(e) => {
        // Keyboard presses arrive as clicks with no pointer behind them.
        if (e.detail !== 0) return;
        if (listening) dictation.stop();
        else dictation.start();
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={cx(
        "pressable relative inline-flex size-[30px] shrink-0 cursor-pointer touch-none items-center justify-center rounded-full select-none [-webkit-touch-callout:none] disabled:cursor-not-allowed disabled:opacity-50",
        listening
          ? "bg-[var(--tag-red-bg)] text-danger shadow-[0_0_0_0.5px_var(--tag-red-border)]"
          : "text-muted enabled:hover:bg-surface-3 enabled:hover:text-text",
      )}
    >
      {hearing && (
        <span
          aria-hidden="true"
          className="absolute inset-[7px] rounded-full bg-danger opacity-25 motion-safe:animate-ping"
        />
      )}
      <Mic aria-hidden="true" className="relative" />
    </button>
  );
}
