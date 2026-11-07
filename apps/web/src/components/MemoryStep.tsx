import type { ToolStep } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Brain, X } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../lib/api.ts";
import { markMemoryUndone, memoryApi } from "../lib/memory.ts";
import { cx, Spinner } from "./ui.tsx";

function parse(text: string | null): {
  error?: string;
  text?: string;
  alreadyRemembered?: boolean;
} {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** A `remember` call: what it saved, with Undo, or why it saved nothing. */
export function RememberStep({ step }: { step: ToolStep }) {
  const qc = useQueryClient();
  const memory = step.memory;
  // Undone here before the server says so, so the line changes at once.
  const [undoing, setUndoing] = useState(false);
  const undo = useMutation({
    mutationFn: (id: string) => memoryApi.remove(id),
    onMutate: () => setUndoing(true),
    onSuccess: (_r, id) => markMemoryUndone(qc, id),
    onError: (err, id) => {
      // Already deleted elsewhere: it's undone either way.
      if (err instanceof ApiError && err.status === 404) markMemoryUndone(qc, id);
      else setUndoing(false);
    },
  });

  if (!memory) {
    const out = parse(step.output);
    if (step.status === "running") {
      return (
        <p className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner className="size-3.5" />
          <span className="text-shimmer">Remembering</span>
        </p>
      );
    }
    if (out.alreadyRemembered && out.text) {
      return (
        <p className="flex min-w-0 items-start gap-2 text-[13px] leading-5">
          <Brain aria-hidden="true" size={14} className="mt-[3px] shrink-0 text-subtle" />
          <span className="min-w-0 break-words text-muted">
            Already remembered: <span className="text-soft">{out.text}</span>
          </span>
        </p>
      );
    }
    return (
      <p className="flex min-w-0 items-start gap-2 text-[13px] leading-5">
        <X aria-hidden="true" size={14} className="mt-[3px] shrink-0 text-danger" />
        <span className="min-w-0 break-words">
          <span className="text-danger">Not remembered</span>
          {out.error && (
            <span className="text-muted"> {out.error.replace(/^Not saved\.\s*/, "")}</span>
          )}
        </span>
      </p>
    );
  }

  const undone = memory.undone || undoing;
  return (
    <p className="flex min-w-0 items-start gap-2 text-[13px] leading-5">
      <Brain aria-hidden="true" size={14} className="mt-[3px] shrink-0 text-subtle" />
      <span className="min-w-0 break-words">
        <span className="text-muted">{undone ? "Forgotten: " : "Remembered: "}</span>
        <span className={undone ? "text-subtle line-through" : "text-soft"}>{memory.text}</span>
        {!undone && (
          <button
            type="button"
            onClick={() => undo.mutate(memory.id)}
            className={cx(
              "ml-2 cursor-pointer rounded text-xs font-medium text-muted underline-offset-2 transition-colors hover:text-text hover:underline focus-visible:text-text focus-visible:underline focus-visible:outline-none",
            )}
          >
            Undo
          </button>
        )}
      </span>
      {undo.error && !(undo.error instanceof ApiError && undo.error.status === 404) ? (
        <span className="shrink-0 text-xs text-danger">Couldn't undo</span>
      ) : null}
    </p>
  );
}
