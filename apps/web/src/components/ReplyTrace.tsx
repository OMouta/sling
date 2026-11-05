import type { ToolStep, TraceStep } from "@sling/core";
import { Brain, ChevronRight, Wrench, X } from "lucide-react";
import { useState } from "react";
import { useNow } from "../lib/useNow.ts";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { cx, Spinner } from "./ui.tsx";

/** What each of Sling's tools is doing, has done, and failed to do. */
const TOOLS: Record<string, [string, string, string]> = {
  list_machines: ["Listing machines", "Listed machines", "Couldn't list machines"],
  delegate_coding_task: ["Starting a task", "Started a task", "Couldn't start a task"],
  get_task: ["Checking a task", "Checked a task", "Couldn't check a task"],
  cancel_task: ["Cancelling a task", "Cancelled a task", "Couldn't cancel a task"],
};

export function toolLabel(step: ToolStep): string {
  const [running, done, failed] = TOOLS[step.name] ?? [
    `Running ${step.name}`,
    `Ran ${step.name}`,
    `${step.name} failed`,
  ];
  return step.status === "running" ? running : step.status === "error" ? failed : done;
}

function seconds(ms: number) {
  return Math.max(1, Math.round(ms / 1000));
}

function summary(steps: TraceStep[], ms: number): string {
  const tools = steps.filter((s): s is ToolStep => s.kind === "tool");
  const head = steps.some((s) => s.kind === "thinking")
    ? `Thought for ${seconds(ms)}s`
    : `Worked for ${seconds(ms)}s`;
  const [only] = tools;
  if (tools.length === 1 && only) return `${head} · ${toolLabel(only)}`;
  if (tools.length > 1) return `${head} · ${tools.length} tool calls`;
  return head;
}

/**
 * How the assistant got to a reply: its thinking and the tools it called.
 * While the reply streams it's open and live. Once saved, it folds into one
 * line that opens on a click.
 */
export function ReplyTrace({
  steps,
  ms = 0,
  startedAt,
}: {
  steps: TraceStep[];
  /** How long a saved reply took. */
  ms?: number;
  /** Set while the reply is still coming in. */
  startedAt?: number;
}) {
  const live = startedAt !== undefined;
  const [open, setOpen] = useState(live);
  const now = useNow(1000, live);
  if (!live && steps.length === 0) return null;

  const last = steps.at(-1);
  const label = live
    ? last?.kind === "tool" && last.status === "running"
      ? toolLabel(last)
      : "Thinking"
    : summary(steps, ms);

  return (
    <div className="mb-2">
      <button
        type="button"
        aria-expanded={open}
        disabled={steps.length === 0}
        onClick={() => setOpen((o) => !o)}
        className="group flex max-w-full cursor-pointer items-center gap-1.5 text-[13px] text-muted transition-colors duration-150 hover:text-soft disabled:cursor-default"
      >
        {live ? (
          <Spinner className="size-3.5" />
        ) : steps.some((s) => s.kind === "thinking") ? (
          <Brain aria-hidden="true" size={14} className="shrink-0 text-subtle" />
        ) : (
          <Wrench aria-hidden="true" size={13} className="shrink-0 text-subtle" />
        )}
        <span className={cx("truncate", live && "text-shimmer")}>{label}</span>
        {live && startedAt !== undefined && (
          <span className="tabular text-subtle">{seconds(now - startedAt)}s</span>
        )}
        {steps.length > 0 && (
          <ChevronRight
            aria-hidden="true"
            size={13}
            className={cx(
              "shrink-0 text-subtle transition-transform duration-150",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      {open && steps.length > 0 && (
        <ol aria-label="Steps" className="mt-2 ml-[7px] space-y-2.5 border-l border-border pl-4">
          {steps.map((s, i) =>
            s.kind === "thinking" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps only grow at the end.
              <li key={i} className="prose-chat prose-thinking text-[13px] leading-5 text-muted">
                <ChatMarkdown>{s.text}</ChatMarkdown>
              </li>
            ) : (
              <ToolRow key={s.id} step={s} />
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function ToolRow({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false);
  const input =
    step.input && typeof step.input === "object" && Object.keys(step.input).length === 0
      ? null
      : typeof step.input === "string"
        ? step.input
        : JSON.stringify(step.input, null, 2);
  const canOpen = Boolean(input || step.output);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        disabled={!canOpen}
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-full cursor-pointer items-center gap-2 text-[13px] transition-colors duration-150 hover:text-text disabled:cursor-default"
      >
        {step.status === "running" ? (
          <Spinner className="size-3.5" />
        ) : step.status === "error" ? (
          <X aria-hidden="true" size={14} className="shrink-0 text-danger" />
        ) : (
          <Wrench aria-hidden="true" size={13} className="shrink-0 text-subtle" />
        )}
        <span className={cx("truncate", step.status === "error" ? "text-danger" : "text-soft")}>
          {toolLabel(step)}
        </span>
        {canOpen && (
          <ChevronRight
            aria-hidden="true"
            size={13}
            className={cx(
              "shrink-0 text-subtle transition-transform duration-150",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {input && <TraceBlock label="Input" text={input} />}
          {step.output && <TraceBlock label="Result" text={pretty(step.output)} />}
        </div>
      )}
    </li>
  );
}

function TraceBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-lg bg-field shadow-field">
      <p className="px-2.5 pt-1.5 text-[11px] font-medium text-subtle">{label}</p>
      <pre className="max-h-56 overflow-auto px-2.5 pt-0.5 pb-2 font-mono text-[11.5px] leading-[17px] break-words whitespace-pre-wrap text-soft">
        {text}
      </pre>
    </div>
  );
}
