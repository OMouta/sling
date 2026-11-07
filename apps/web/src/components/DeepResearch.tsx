import type { ReplyTrace, TraceStep } from "@sling/core";
import { ChevronRight, FlaskConical, X } from "lucide-react";
import { useState } from "react";
import { elapsed, webCounts, webCountsText } from "../lib/research.ts";
import { useNow } from "../lib/useNow.ts";
import { type ActivityContext, ReplySteps } from "./ChatActivity.tsx";
import { cx } from "./ui.tsx";

/** Deep research for the next message: on from the + menu, off once it's sent. */
export function useDeepResearch() {
  const [on, setOn] = useState(false);
  return {
    on,
    off: () => setOn(false),
    /** The + menu's switch. */
    option: { on, toggle: () => setOn((v) => !v) },
  };
}

/** Shown in the composer while Deep research is on for the next message. */
export function ResearchChip({ onRemove }: { onRemove: () => void }) {
  return (
    <div className="flex px-2.5 pt-2.5">
      <span className="flex h-7 items-center gap-1.5 rounded-full bg-[var(--tag-purple-bg)] pr-1 pl-2.5 text-xs font-medium text-[var(--tag-purple-text)] shadow-[inset_0_0_0_1px_var(--tag-purple-border)]">
        <FlaskConical aria-hidden="true" size={13} />
        Deep research
        <button
          type="button"
          aria-label="Turn off Deep research"
          onClick={onRemove}
          className="grid size-5 cursor-pointer place-items-center rounded-full transition-colors duration-150 hover:bg-[var(--tag-purple-border)]"
        >
          <X aria-hidden="true" size={12} />
        </button>
      </span>
    </div>
  );
}

/** The working line of a Deep research turn: how much it has searched and read so far. */
export function ResearchLine({ steps, startedAt }: { steps: TraceStep[]; startedAt: number }) {
  const now = useNow(1000, true);
  const counts = webCountsText(webCounts(steps));
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted">
      <FlaskConical aria-hidden="true" size={14} className="shrink-0 text-subtle" />
      <span className="text-shimmer">Researching</span>
      <span className="tabular truncate text-subtle">
        {counts ? `${counts} · ` : ""}
        {elapsed(now - startedAt)}
      </span>
    </p>
  );
}

/**
 * A finished Deep research reply's work, folded into one line with how long
 * it took and what it read, since it can run to dozens of steps. Steps that
 * need the reader, such as a task or an approval, keep them all in view.
 */
export function ResearchSteps({ trace, ctx }: { trace: ReplyTrace; ctx: ActivityContext }) {
  const [open, setOpen] = useState(false);
  const counts = webCounts(trace.steps);
  const keepOpen = trace.steps.some(
    (s) => s.kind === "tool" && (s.approval || s.name === "delegate_coding_task"),
  );
  if (keepOpen || (!counts.searches && !counts.pages)) {
    return <ReplySteps steps={trace.steps} ctx={ctx} />;
  }
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full min-w-0 cursor-pointer items-center gap-2 text-left text-[13px] text-muted transition-colors duration-150 hover:text-soft"
      >
        <FlaskConical aria-hidden="true" size={14} className="shrink-0 text-subtle" />
        <span className="shrink-0">Researched for {elapsed(trace.ms)}</span>
        <span className="tabular truncate text-subtle">{webCountsText(counts)}</span>
        <ChevronRight
          aria-hidden="true"
          size={13}
          className={cx(
            "shrink-0 text-subtle opacity-0 transition duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>
      {open && (
        <div className="mt-2 ml-[7px] border-l border-border pl-4">
          <ReplySteps steps={trace.steps} ctx={ctx} />
        </div>
      )}
    </div>
  );
}
