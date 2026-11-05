import { HARNESS_LABELS, type Harness, isHarness, type TaskEventView } from "@sling/core";
import { Check, ChevronRight, LoaderCircle, Square, SquareCheck, X } from "lucide-react";
import { useState } from "react";
import { cx, Mono } from "./ui.tsx";

type P = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");

/** A task's event stream as a readable timeline. */
export function Timeline({ events, harness }: { events: TaskEventView[]; harness: Harness }) {
  // Show a command once: its completed event replaces the started one.
  const finishedCommands = new Set(
    events
      .filter((e) => e.type === "command" && (e.payload as P).status !== "started")
      .map((e) => s((e.payload as P).itemId)),
  );
  const visible = events.filter(
    (e) =>
      !(
        e.type === "command" &&
        (e.payload as P).status === "started" &&
        finishedCommands.has(s((e.payload as P).itemId))
      ) && e.type !== "usage",
  );
  // Only the latest plan is interesting.
  const lastPlan = [...visible].reverse().find((e) => e.type === "plan");

  return (
    <ol className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[62px] before:w-px before:bg-border">
      {visible.map((e) =>
        e.type === "plan" && e !== lastPlan ? null : (
          <EventRow key={e.seq} event={e} harness={harness} />
        ),
      )}
    </ol>
  );
}

function Row({
  time,
  children,
  className,
}: {
  time: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <li className={cx("relative flex gap-5 text-[13px] leading-5", className)}>
      <time className="tabular w-[52px] shrink-0 text-right font-mono text-[11px] leading-5 text-subtle">
        {new Date(time).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        })}
      </time>
      <span
        aria-hidden="true"
        className="absolute top-[7px] left-[59px] size-[7px] rounded-full bg-line-strong shadow-[0_0_0_3px_var(--bg)]"
      />
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function EventRow({ event, harness }: { event: TaskEventView; harness: Harness }) {
  const p = event.payload as P;
  switch (event.type) {
    case "accepted":
      return <Row time={event.at}>The machine accepted the task.</Row>;
    case "rejected":
      return (
        <Row time={event.at} className="text-danger">
          Refused: {s(p.message)}
        </Row>
      );
    case "started":
      return (
        <Row time={event.at}>
          Started {HARNESS_LABELS[isHarness(p.harness) ? p.harness : harness]} {s(p.harnessVersion)}{" "}
          on <Mono>{s(p.branch)}</Mono>
        </Row>
      );
    case "agent_message":
      return (
        <Row time={event.at}>
          <p className="whitespace-pre-wrap">{s(p.text)}</p>
        </Row>
      );
    case "command":
      return (
        <Row time={event.at}>
          <Command payload={p} />
        </Row>
      );
    case "file_change": {
      const changes = (p.changes as { path: string; kind: string }[]) ?? [];
      return (
        <Row time={event.at}>
          <ul className="space-y-0.5">
            {changes.map((c) => (
              <li key={c.path} className="font-mono text-xs text-soft">
                <span
                  className={
                    c.kind === "add" ? "text-ok" : c.kind === "delete" ? "text-danger" : "text-warn"
                  }
                >
                  {c.kind === "add" ? "A" : c.kind === "delete" ? "D" : "M"}
                </span>{" "}
                {c.path}
              </li>
            ))}
          </ul>
        </Row>
      );
    }
    case "plan": {
      const steps = (p.steps as { text: string; done: boolean }[]) ?? [];
      return (
        <Row time={event.at}>
          <ul className="space-y-0.5">
            {steps.map((st) => (
              <li
                key={st.text}
                className={cx("flex items-start gap-2", st.done && "text-muted line-through")}
              >
                {st.done ? (
                  <SquareCheck aria-label="Done" className="mt-[3px] shrink-0 text-ok" />
                ) : (
                  <Square aria-label="To do" className="mt-[3px] shrink-0 text-subtle" />
                )}
                {st.text}
              </li>
            ))}
          </ul>
        </Row>
      );
    }
    case "log":
      return (
        <Row time={event.at}>
          <span
            className={cx(
              "font-mono text-xs",
              p.stream === "harness_stderr" ? "text-warn" : "text-muted",
            )}
          >
            {s(p.text)}
          </span>
        </Row>
      );
    case "finished":
      return (
        <Row time={event.at} className="font-medium">
          Finished: {s(p.outcome)}
          {s(p.error) && <span className="font-normal text-danger"> ({s(p.error)})</span>}
        </Row>
      );
    case "action_result":
      return (
        <Row time={event.at}>
          {p.kind === "open_pr" ? "Pull request" : "Push"}: {s(p.outcome)}. {s(p.message)}{" "}
          {s(p.url) && (
            <a
              href={s(p.url)}
              target="_blank"
              rel="noreferrer"
              className="text-accent-text hover:underline"
            >
              {p.kind === "open_pr" ? "Open the pull request" : "Compare changes"}
            </a>
          )}
        </Row>
      );
    case "truncated":
      return (
        <Row time={event.at} className="text-warn">
          {s(p.message)}
        </Row>
      );
    default:
      return null;
  }
}

function Command({ payload }: { payload: P }) {
  const [open, setOpen] = useState(false);
  const status = s(payload.status);
  const output = s(payload.output);
  return (
    <div className="overflow-hidden rounded-lg bg-field shadow-field">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={output ? open : undefined}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {status === "started" ? (
          <LoaderCircle aria-label="Running" className="shrink-0 animate-spin text-muted" />
        ) : status === "failed" ? (
          <X aria-label="Failed" className="shrink-0 text-danger" />
        ) : (
          <Check aria-label="Done" className="shrink-0 text-ok" />
        )}
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-soft">
          {s(payload.command)}
        </code>
        {output && (
          <span className="flex items-center gap-0.5 text-xs text-subtle">
            {open ? "hide" : "output"}
            <ChevronRight
              aria-hidden="true"
              size={12}
              className={cx("transition-transform duration-150", open && "rotate-90")}
            />
          </span>
        )}
      </button>
      {open && output && (
        <pre className="max-h-80 overflow-auto border-t border-border px-3 py-2 font-mono text-xs whitespace-pre-wrap text-soft">
          {output}
        </pre>
      )}
    </div>
  );
}
