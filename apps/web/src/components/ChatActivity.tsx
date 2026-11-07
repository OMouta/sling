import type {
  CommandApprovalView,
  PermissionMode,
  SetupChangeRow,
  SetupChangeView,
  TaskView,
  ToolStep,
  TraceStep,
} from "@sling/core";
import { useMutation } from "@tanstack/react-query";
import {
  Brain,
  Check,
  ChevronRight,
  Laptop,
  Lock,
  Send,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Workflow,
  Wrench,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { api } from "../lib/api.ts";
import { duration, readableLocalDate } from "../lib/format.ts";
import { useNow } from "../lib/useNow.ts";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { Button, cx, ErrorText, Input, Spinner } from "./ui.tsx";
import { OpenInEditor, WorkflowSteps } from "./WorkflowSteps.tsx";

/** What each of Sling's tools is doing, has done, and failed to do. */
const TOOLS: Record<string, [string, string, string]> = {
  list_machines: ["Looking at your machines", "Looked at your machines", "Couldn't list machines"],
  delegate_coding_task: ["Starting a task", "Started a task", "Couldn't start a task"],
  get_task: ["Checking a task", "Checked a task", "Couldn't check a task"],
  cancel_task: ["Cancelling a task", "Cancelled a task", "Couldn't cancel a task"],
  run_command: ["Running a command", "Ran a command", "Couldn't run a command"],
  run_check: ["Checking the site", "Checked the site", "Couldn't check the site"],
  // Its name in replies saved before it was renamed.
  check_deploy_target: ["Checking the site", "Checked the site", "Couldn't check the site"],
  deploy_task: ["Starting a deploy", "Started a deploy", "Couldn't start the deploy"],
  run_workflow: ["Running a workflow", "Ran a workflow", "Couldn't run the workflow"],
  calendar_list_events: [
    "Reading your calendar",
    "Read your calendar",
    "Couldn't read your calendar",
  ],
  calendar_create_event: ["Adding an event", "Added an event", "Couldn't add the event"],
  email_send: ["Sending an email", "Sent an email", "Couldn't send the email"],
  discord_send_message: [
    "Sending a Discord message",
    "Sent a Discord message",
    "Couldn't send the Discord message",
  ],
  read_setup: ["Looking at your setup", "Looked at your setup", "Couldn't read your setup"],
  save_deploy_target: [
    "Setting up a deploy target",
    "Set up a deploy target",
    "Couldn't set up the deploy target",
  ],
  save_app_account: ["Connecting an app", "Connected an app", "Couldn't connect the app"],
  add_workflow: ["Adding a workflow", "Added a workflow", "Couldn't add the workflow"],
  change_workflow: ["Changing a workflow", "Changed a workflow", "Couldn't change the workflow"],
  save_personality: [
    "Saving a personality",
    "Saved a personality",
    "Couldn't save the personality",
  ],
  change_settings: ["Changing settings", "Changed settings", "Couldn't change settings"],
  create_workflow: ["Writing a workflow", "Created a workflow", "Couldn't create the workflow"],
  workflow_nodes: [
    "Looking up workflow steps",
    "Looked up workflow steps",
    "Couldn't look up workflow steps",
  ],
};

/** A call that failed, or finished with an error for the assistant, such as a refused workflow. */
function failedStep(step: ToolStep): boolean {
  if (step.status !== "done") return step.status === "error";
  return Boolean(parse<{ error?: unknown }>(step.output)?.error);
}

export function toolLabel(step: ToolStep): string {
  const [running, done, failed] = TOOLS[step.name] ?? [
    `Running ${step.name}`,
    `Ran ${step.name}`,
    `${step.name} failed`,
  ];
  return step.status === "running" ? running : failedStep(step) ? failed : done;
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
            ) : s.approval?.kind === "send" ? (
              <SendStep step={s} approval={s.approval} ctx={ctx} />
            ) : s.approval?.kind === "change" && s.approval.change ? (
              <ChangeStep step={s} approval={s.approval} change={s.approval.change} ctx={ctx} />
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
        <ChatApproval
          approvalId={approval.id}
          ctx={ctx}
          approve="Run it"
          question={
            <>
              Run this on <span className="font-medium text-text">{approval.machine}</span> outside
              the sandbox?
            </>
          }
          detail="It can change files and use the network."
        />
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

/** Deny or allow something the assistant waits on: a command outside the sandbox, or a send. */
function ChatApproval({
  approvalId,
  ctx,
  question,
  detail,
  approve,
}: {
  approvalId: string;
  ctx: ActivityContext;
  question: ReactNode;
  detail?: string;
  approve: string;
}) {
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      api.post(`/api/conversations/${ctx.conversationId}/commands/${approvalId}`, { decision }),
  });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-surface px-2.5 py-2">
      <p className="mr-auto min-w-0 text-[13px] text-soft">
        {question}
        {detail && <span className="block text-xs text-muted">{detail}</span>}
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
          {approve}
        </Button>
      </div>
      <ErrorText error={decide.error} />
    </div>
  );
}

/**
 * Something the assistant sends outside Sling through one of your apps: an
 * email, a message, an event, a workflow that does things. It shows what
 * would go out, and waits for you outside Full access.
 */
function SendStep({
  step,
  approval,
  ctx,
}: {
  step: ToolStep;
  approval: CommandApprovalView;
  ctx: ActivityContext;
}) {
  const [open, setOpen] = useState(false);
  const waiting = approval.state === "pending";
  const stopped = approval.state === "denied" || approval.state === "expired";
  const running = step.status === "running" && !waiting && !stopped;
  const failed = step.status === "error" && !stopped;
  const result = step.output ? pretty(step.output) : null;
  const summary = approval.summary || toolLabel(step);

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
        disabled={!result || stopped}
        className="px-2.5 py-1.5 hover:bg-hover"
        label={summary}
      >
        {running ? (
          <Spinner className="size-3.5" />
        ) : waiting ? (
          <ShieldAlert aria-hidden="true" size={14} className="shrink-0 text-warn" />
        ) : failed ? (
          <X aria-hidden="true" size={14} className="shrink-0 text-danger" />
        ) : (
          <Send aria-hidden="true" size={14} className="shrink-0 text-subtle" />
        )}
        <span
          className={cx(
            "min-w-0 flex-1 truncate text-[13px]",
            stopped ? "text-muted" : "text-soft",
            failed && "text-danger",
          )}
        >
          {summary}
        </span>
        {approval.state === "approved" && (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-subtle"
            title="You allowed it"
          >
            <ShieldCheck aria-hidden="true" size={12} />
            approved
          </span>
        )}
      </Disclosure>
      {waiting && <SendValues input={step.input} />}
      {waiting && (
        <ChatApproval approvalId={approval.id} ctx={ctx} approve="Allow" question="Allow this?" />
      )}
      {approval.state === "denied" && (
        <p className="border-t border-border px-2.5 py-1.5 text-xs text-muted">
          You didn't allow it, so nothing went out.
        </p>
      )}
      {approval.state === "expired" && (
        <p className="border-t border-border px-2.5 py-1.5 text-xs text-muted">
          Nobody answered, so nothing went out.
        </p>
      )}
      {open && result && (
        <pre className="max-h-80 overflow-auto border-t border-border px-3 py-2 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap break-words text-soft">
          {result}
        </pre>
      )}
    </div>
  );
}

/** One value of a send, as text a person reads before allowing it. */
function sendValueText(v: unknown): string {
  if (typeof v === "string") return readableLocalDate(v);
  if (Array.isArray(v)) return v.map(sendValueText).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}

/**
 * Every value a waiting send would go out with, such as an email's body,
 * since the summary above names only the recipient and subject.
 */
function SendValues({ input }: { input: unknown }) {
  const entries =
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.entries(input as Record<string, unknown>).filter(
          ([, v]) => v !== null && v !== undefined && v !== "",
        )
      : [];
  if (entries.length === 0 && typeof input !== "string") return null;
  return (
    <div className="max-h-64 overflow-auto border-t border-border px-2.5 py-2 text-xs leading-[18px]">
      {entries.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="whitespace-pre-wrap break-words text-soft">{sendValueText(v)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <pre className="font-mono whitespace-pre-wrap break-words text-soft">{String(input)}</pre>
      )}
    </div>
  );
}

/**
 * A change to Sling's own setup that the assistant proposes: what would
 * change, an input for each password or token it needs, and Apply. What's
 * typed there goes to the server with the Apply, never into the chat.
 * Once decided, it's one line.
 */
function ChangeStep({
  step,
  approval,
  change,
  ctx,
}: {
  step: ToolStep;
  approval: CommandApprovalView;
  change: SetupChangeView;
  ctx: ActivityContext;
}) {
  const [open, setOpen] = useState(false);
  const waiting = approval.state === "pending";
  const stopped = approval.state === "denied" || approval.state === "expired";
  const applying = approval.state === "approved" && step.status === "running";
  const res = parse<{ error?: string }>(step.output);
  const error = res?.error ?? (step.status === "error" ? step.output : null);
  const failed = approval.state === "approved" && !applying && Boolean(error);
  const subject = change.title.replace(/\?$/, "");
  const editorId =
    approval.state === "approved" && !applying && !failed ? change.workflow?.workflowId : null;
  const line = waiting
    ? change.title
    : applying
      ? change.doing
      : failed || stopped
        ? subject
        : change.done;

  return (
    <div
      className={cx(
        "overflow-hidden rounded-lg bg-field shadow-field",
        waiting && "shadow-[inset_0_0_0_1px_var(--tag-amber-border)]",
      )}
    >
      <div className={cx("flex items-center", editorId && "gap-1 pr-1")}>
        <Disclosure
          open={open}
          onToggle={() => setOpen((o) => !o)}
          disabled={waiting || applying || change.rows.length === 0}
          className={cx("py-1.5 pl-2.5 hover:bg-hover", !editorId && "pr-2.5")}
          label={line}
        >
          {applying ? (
            <Spinner className="size-3.5" />
          ) : waiting ? (
            <ShieldAlert aria-hidden="true" size={14} className="shrink-0 text-warn" />
          ) : failed ? (
            <X aria-hidden="true" size={14} className="shrink-0 text-danger" />
          ) : change.workflow ? (
            <Workflow aria-hidden="true" size={14} className="shrink-0 text-subtle" />
          ) : (
            <SlidersHorizontal aria-hidden="true" size={14} className="shrink-0 text-subtle" />
          )}
          <span
            className={cx(
              "min-w-0 flex-1 truncate text-[13px]",
              stopped ? "text-muted" : "text-soft",
              failed && "text-danger",
              applying && "text-shimmer",
            )}
          >
            {line}
          </span>
          {stopped && (
            <span className="shrink-0 text-[11.5px] text-subtle">
              {approval.state === "denied" ? "cancelled" : "expired"}
            </span>
          )}
        </Disclosure>
        {editorId && <OpenInEditor workflowId={editorId} />}
      </div>
      {waiting ? (
        <ChangeApproval approvalId={approval.id} change={change} ctx={ctx} />
      ) : (
        open && <ChangeDetails change={change} />
      )}
      {failed && error && (
        <p className="border-t border-border px-2.5 py-1.5 text-xs text-danger">{error}</p>
      )}
    </div>
  );
}

/**
 * What a change sets, and a workflow's steps when it writes one: a new
 * workflow leads with its steps, and an edit with what changes.
 */
function ChangeDetails({ change, children }: { change: SetupChangeView; children?: ReactNode }) {
  const steps = change.workflow ? <WorkflowSteps steps={change.workflow.steps} /> : null;
  const edit = change.rows.some((r) => r.before !== undefined);
  return (
    <>
      {!edit && steps}
      <ChangeRows rows={change.rows}>{children}</ChangeRows>
      {edit && steps}
    </>
  );
}

/**
 * What a change sets, one line each: label, then the new value, after the
 * old one for an edit. Inputs passed as children line up with the rows.
 */
function ChangeRows({ rows, children }: { rows: SetupChangeRow[]; children?: ReactNode }) {
  if (rows.length === 0 && !children) return null;
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-xs leading-[18px]">
      {rows.length > 0 && (
        <dl className="col-span-2 grid max-h-64 grid-cols-subgrid gap-y-1 overflow-auto border-t border-border px-2.5 py-2">
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows don't change once shown.
            <div key={i} className="contents">
              <dt className="text-muted">{r.label}</dt>
              <dd className="whitespace-pre-wrap break-words text-soft">
                {r.before !== undefined && (
                  <>
                    <span className="text-muted">{r.before}</span>
                    <span className="text-subtle"> → </span>
                  </>
                )}
                {r.after}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {children}
    </div>
  );
}

/** Cancel or apply a change, with what it needs typed in. Apply waits for the required ones. */
function ChangeApproval({
  approvalId,
  change,
  ctx,
}: {
  approvalId: string;
  change: SetupChangeView;
  ctx: ActivityContext;
}) {
  const base = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      api.post(`/api/conversations/${ctx.conversationId}/commands/${approvalId}`, {
        decision,
        ...(decision === "approve" && change.secrets.length > 0
          ? {
              secrets: Object.fromEntries(
                change.secrets.flatMap((f) => (values[f.key] ? [[f.key, values[f.key]]] : [])),
              ),
            }
          : {}),
      }),
    // Nothing typed stays in the page once it's sent.
    onSuccess: () => setValues({}),
  });
  const ready = change.secrets.every((f) => !f.required || (values[f.key] ?? "").trim() !== "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !decide.isPending) decide.mutate("approve");
  };
  return (
    <form onSubmit={submit}>
      <ChangeDetails change={change}>
        {change.secrets.length > 0 && (
          <div className="col-span-2 grid grid-cols-subgrid items-center gap-y-1.5 border-t border-border px-2.5 py-2">
            {change.secrets.map((f) => (
              <div key={f.key} className="contents">
                <label htmlFor={`${base}-${f.key}`} className="text-muted max-sm:col-span-2">
                  {f.label}
                  {f.link && (
                    <a
                      href={f.link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 text-accent-text hover:underline"
                    >
                      {f.link.label}
                    </a>
                  )}
                </label>
                <Input
                  id={`${base}-${f.key}`}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  required={f.required}
                  placeholder={f.placeholder ?? (f.required ? "" : "Keep the current one")}
                  value={values[f.key] ?? ""}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setValues((old) => ({ ...old, [f.key]: v }));
                  }}
                  className="max-sm:col-span-2"
                />
              </div>
            ))}
          </div>
        )}
      </ChangeDetails>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-border bg-surface px-2.5 py-2">
        <div className="mr-auto min-w-0">
          <ErrorText error={decide.error} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" busy={decide.isPending} onClick={() => decide.mutate("deny")}>
            Cancel
          </Button>
          <Button
            size="sm"
            type="submit"
            variant="primary"
            busy={decide.isPending}
            disabled={!ready}
          >
            Apply
          </Button>
        </div>
      </div>
    </form>
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
        ) : failedStep(step) ? (
          <X aria-hidden="true" size={14} className="shrink-0 text-danger" />
        ) : (
          <Check aria-hidden="true" size={14} className="shrink-0 text-subtle" />
        )}
        <span
          className={cx(
            "truncate",
            failedStep(step) && "text-danger",
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
