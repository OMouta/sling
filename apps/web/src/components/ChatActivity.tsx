import type { PermissionMode, TaskView, ToolStep, TraceStep } from "@sling/core";
import { useMutation } from "@tanstack/react-query";
import {
  Brain,
  Check,
  ChevronRight,
  Laptop,
  Lock,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { api } from "../lib/api.ts";
import { duration } from "../lib/format.ts";
import { useNow } from "../lib/useNow.ts";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { Button, cx, ErrorText, Spinner } from "./ui.tsx";

/** What each of Sling's tools is doing, has done, and failed to do. */
const TOOLS: Record<string, [string, string, string]> = {
  list_machines: ["Looking at your machines", "Looked at your machines", "Couldn't list machines"],
  delegate_coding_task: ["Starting a task", "Started a task", "Couldn't start a task"],
  get_task: ["Checking a task", "Checked a task", "Couldn't check a task"],
  cancel_task: ["Cancelling a task", "Cancelled a task", "Couldn't cancel a task"],
  run_command: ["Running a command", "Ran a command", "Couldn't run a command"],
};

export function toolLabel(step: ToolStep): string {
  const [running, done, failed] = TOOLS[step.name] ?? [
    `Running ${step.name}`,
    `Ran ${step.name}`,
    `${step.name} failed`,
  ];
  return step.status === "running" ? running : step.status === "error" ? failed : done;
}

/** What the chat needs to show steps that point at other things. */
export interface ActivityContext {
  conversationId: string;
  conversationMode: PermissionMode;
  tasks: Map<string, TaskView>;
}

function parse<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The task a delegate_coding_task call started, from its result. */
export function startedTaskId(step: TraceStep): string | null {
  if (step.kind !== "tool" || step.name !== "delegate_coding_task") return null;
  return parse<{ taskId?: string }>(step.output)?.taskId ?? null;
}

/**
 * A reply's work, in the order it happened: thinking, what the assistant
 * said along the way, commands and their output, and the tasks it started,
 * which show as their live cards right where they began. `live` marks a
 * reply still being written, whose last step may be in progress.
 */
export function ReplySteps({
  steps,
  live = false,
  ctx,
}: {
  steps: TraceStep[];
  live?: boolean;
  ctx: ActivityContext;
}) {
  if (steps.length === 0) return null;
  return (
    <ol aria-label="Steps" className="space-y-2">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        if (s.kind === "thinking") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps only grow at the end.
            <li key={i}>
              <ThinkingStep text={s.text} active={live && last} />
            </li>
          );
        }
        if (s.kind === "text") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps only grow at the end.
            <li key={i} className="prose-chat text-sm leading-6">
              <ChatMarkdown>{s.text}</ChatMarkdown>
            </li>
          );
        }
        return (
          <li key={s.id}>
            {s.name === "run_command" ? (
              <CommandStep step={s} ctx={ctx} />
            ) : s.name === "delegate_coding_task" ? (
              <TaskStep step={s} ctx={ctx} />
            ) : (
              <ToolRow step={s} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The line shown while the assistant works with nothing else to show yet. */
export function WorkingLine({ startedAt }: { startedAt: number }) {
  const now = useNow(1000, true);
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted">
      <Spinner className="size-3.5" />
      <span className="text-shimmer">Thinking</span>
      <span className="tabular text-subtle">
        {Math.max(0, Math.round((now - startedAt) / 1000))}s
      </span>
    </p>
  );
}

function Disclosure({
  open,
  onToggle,
  disabled,
  children,
  className,
  label,
}: {
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={disabled ? undefined : open}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cx(
        "group flex w-full min-w-0 cursor-pointer items-center gap-2 text-left text-[13px] transition-colors duration-150 disabled:cursor-default",
        className,
      )}
    >
      {children}
      {!disabled && (
        <ChevronRight
          aria-hidden="true"
          size={13}
          className={cx(
            "shrink-0 text-subtle opacity-0 transition duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      )}
    </button>
  );
}

function ThinkingStep({ text, active }: { text: string; active: boolean }) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? active;
  const preview = text
    .replace(/[*`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    <div>
      <Disclosure
        open={open}
        onToggle={() => setToggled(!open)}
        className="text-muted hover:text-soft"
        label={active ? "Thinking" : "Thought"}
      >
        {active ? (
          <Spinner className="size-3.5" />
        ) : (
          <Brain aria-hidden="true" size={14} className="shrink-0 text-subtle" />
        )}
        <span className={cx("shrink-0", active && "text-shimmer")}>
          {active ? "Thinking" : "Thought"}
        </span>
        {!open && <span className="min-w-0 truncate text-subtle">{preview}</span>}
      </Disclosure>
      {open && (
        <div className="prose-chat prose-thinking mt-1.5 ml-[7px] border-l border-border pl-4 text-[13px] leading-5 text-muted">
          <ChatMarkdown>{text}</ChatMarkdown>
        </div>
      )}
    </div>
  );
}

interface CommandInput {
  command?: string;
  machine?: string;
  cwd?: string;
  outsideSandbox?: boolean;
}

interface CommandOutput {
  machine?: string;
  cwd?: string;
  sandboxed?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
  durationMs?: number;
  output?: string;
  error?: string;
}

/** A shell command: the command, where it ran, how it ended, and its output on a click. */
function CommandStep({ step, ctx }: { step: ToolStep; ctx: ActivityContext }) {
  const input = (typeof step.input === "object" ? step.input : null) as CommandInput | null;
  const res = parse<CommandOutput>(step.output);
  const [open, setOpen] = useState(false);
  const approval = step.approval;
  const waiting = approval?.state === "pending";
  const running = step.status === "running" && !waiting;
  const failed =
    step.status === "error" ||
    Boolean(res?.error) ||
    res?.timedOut ||
    (res?.exitCode !== undefined && res.exitCode !== 0);
  const output = res?.output ?? (step.status === "error" ? step.output : null);
  const machine = res?.machine ?? approval?.machine ?? input?.machine;
  const command = input?.command ?? "";

  return (
    <div
      className={cx(
        "overflow-hidden rounded-lg bg-field shadow-field",
        waiting && "shadow-[inset_0_0_0_1px_var(--tag-amber-border)]",
      )}
    >
      <Disclosure
        open={open}
        onToggle={() => setOpen((o) => !o)}
        disabled={!output}
        className="px-2.5 py-1.5 hover:bg-hover"
        label={`$ ${command}`}
      >
        {running ? (
          <Spinner className="size-3.5" />
        ) : waiting ? (
          <ShieldAlert aria-hidden="true" size={14} className="shrink-0 text-warn" />
        ) : failed ? (
          <X aria-hidden="true" size={14} className="shrink-0 text-danger" />
        ) : (
          <SquareTerminal aria-hidden="true" size={14} className="shrink-0 text-subtle" />
        )}
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-soft">
          <span className="text-subtle select-none">$ </span>
          {command}
        </code>
        <CommandMeta
          res={res}
          machine={machine}
          running={running}
          approved={approval?.state === "approved"}
        />
      </Disclosure>
      {waiting && approval && (
        <CommandApproval approvalId={approval.id} machine={approval.machine} ctx={ctx} />
      )}
      {!waiting && approval?.state === "denied" && (
        <p className="border-t border-border px-2.5 py-1.5 text-xs text-muted">
          You didn't allow it outside the sandbox.
        </p>
      )}
      {!waiting && approval?.state === "expired" && (
        <p className="border-t border-border px-2.5 py-1.5 text-xs text-muted">
          Nobody answered, so it didn't run.
        </p>
      )}
      {res?.error && approval?.state !== "denied" && approval?.state !== "expired" && (
        <p className="border-t border-border px-2.5 py-1.5 text-xs text-danger">{res.error}</p>
      )}
      {open && output && (
        <pre className="max-h-80 overflow-auto border-t border-border px-3 py-2 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap break-words text-soft">
          {output}
          {res?.timedOut && <span className="text-warn">{"\n"}Stopped: it ran too long.</span>}
        </pre>
      )}
    </div>
  );
}

function CommandMeta({
  res,
  machine,
  running,
  approved,
}: {
  res: CommandOutput | null;
  machine: string | undefined;
  running: boolean;
  approved: boolean;
}) {
  return (
    <span className="tabular flex shrink-0 items-center gap-2 text-[11.5px] text-subtle">
      {machine && (
        <span className="inline-flex items-center gap-1 max-sm:hidden">
          <Laptop aria-hidden="true" size={12} />
          {machine}
        </span>
      )}
      {res?.sandboxed && (
        <span title="Ran in the read-only sandbox: no writes, no network">
          <Lock aria-label="Sandboxed" size={11} />
        </span>
      )}
      {approved && (
        <span className="inline-flex items-center gap-1" title="You allowed it outside the sandbox">
          <ShieldCheck aria-hidden="true" size={12} />
          approved
        </span>
      )}
      {running ? null : res?.timedOut ? (
        <span className="text-warn">timed out</span>
      ) : typeof res?.exitCode === "number" && res.exitCode !== 0 ? (
        <span className="text-danger">exit {res.exitCode}</span>
      ) : null}
      {typeof res?.durationMs === "number" && <span>{duration(res.durationMs)}</span>}
    </span>
  );
}

function CommandApproval({
  approvalId,
  machine,
  ctx,
}: {
  approvalId: string;
  machine: string;
  ctx: ActivityContext;
}) {
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      api.post(`/api/conversations/${ctx.conversationId}/commands/${approvalId}`, { decision }),
  });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-surface px-2.5 py-2">
      <p className="mr-auto min-w-0 text-[13px] text-soft">
        Run this on <span className="font-medium text-text">{machine}</span> outside the sandbox?
        <span className="block text-xs text-muted">It can change files and use the network.</span>
      </p>
      <div className="flex gap-2">
        <Button size="sm" busy={decide.isPending} onClick={() => decide.mutate("deny")}>
          Deny
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={decide.isPending}
          onClick={() => decide.mutate("approve")}
        >
          Run it
        </Button>
      </div>
      <ErrorText error={decide.error} />
    </div>
  );
}

interface DelegateInput {
  title?: string;
  repo?: string;
}

interface DelegateOutput {
  taskId?: string;
  error?: string;
  reasons?: string[];
}

/** A task the assistant started: its live card, in the place it started. */
function TaskStep({ step, ctx }: { step: ToolStep; ctx: ActivityContext }) {
  const input = (typeof step.input === "object" ? step.input : null) as DelegateInput | null;
  const res = parse<DelegateOutput>(step.output);
  const task = res?.taskId ? ctx.tasks.get(res.taskId) : undefined;
  if (task) return <TaskCard task={task} compact conversationMode={ctx.conversationMode} />;
  if (step.status === "running") {
    return (
      <p className="flex items-center gap-2 text-[13px] text-muted">
        <Spinner className="size-3.5" />
        <span className="text-shimmer">
          Starting {input?.title ? `“${input.title}”` : "a task"}
        </span>
      </p>
    );
  }
  const error = res?.error ?? (step.status === "error" ? step.output : null);
  if (error) {
    return (
      <div className="rounded-lg bg-field px-2.5 py-2 text-[13px] shadow-field">
        <p className="flex items-center gap-2 text-danger">
          <X aria-hidden="true" size={14} className="shrink-0" />
          Couldn't start {input?.title ? `“${input.title}”` : "the task"}
        </p>
        <p className="mt-1 pl-[22px] text-xs text-soft">{error}</p>
        {res?.reasons && res.reasons.length > 0 && (
          <ul className="mt-1 space-y-0.5 pl-[22px] text-xs text-muted">
            {res.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return <ToolRow step={step} />;
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Any other tool call: what it did, with its input and result on a click. */
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
    <div>
      <Disclosure
        open={open}
        onToggle={() => setOpen((o) => !o)}
        disabled={!canOpen}
        className="text-muted hover:text-soft"
        label={toolLabel(step)}
      >
        {step.status === "running" ? (
          <Spinner className="size-3.5" />
        ) : step.status === "error" ? (
          <X aria-hidden="true" size={14} className="shrink-0 text-danger" />
        ) : (
          <Check aria-hidden="true" size={14} className="shrink-0 text-subtle" />
        )}
        <span
          className={cx(
            "truncate",
            step.status === "error" && "text-danger",
            step.status === "running" && "text-shimmer",
          )}
        >
          {toolLabel(step)}
        </span>
      </Disclosure>
      {open && (
        <div className="mt-1.5 ml-[7px] space-y-1.5 border-l border-border pl-4">
          {input && <TraceBlock label="Input" text={input} />}
          {step.output && <TraceBlock label="Result" text={pretty(step.output)} />}
        </div>
      )}
    </div>
  );
}

function TraceBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-lg bg-field shadow-field">
      <p className="flex items-center gap-1.5 px-2.5 pt-1.5 text-[11px] font-medium text-subtle">
        <Wrench aria-hidden="true" size={11} />
        {label}
      </p>
      <pre className="max-h-56 overflow-auto px-2.5 pt-0.5 pb-2 font-mono text-[11.5px] leading-[17px] break-words whitespace-pre-wrap text-soft">
        {text}
      </pre>
    </div>
  );
}
