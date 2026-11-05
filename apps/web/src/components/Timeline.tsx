import type { TaskEventView } from "@sling/core";
import { useState } from "react";
import { cx } from "./ui.tsx";

type P = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");

/** A task's event stream as a readable timeline. */
export function Timeline({ events }: { events: TaskEventView[] }) {
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
    <ol className="space-y-2">
      {visible.map((e) =>
        e.type === "plan" && e !== lastPlan ? null : <EventRow key={e.seq} event={e} />,
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
    <li className={cx("flex gap-3 text-sm", className)}>
      <time className="w-14 shrink-0 pt-0.5 text-right font-mono text-xs text-muted">
        {new Date(time).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
      </time>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

function EventRow({ event }: { event: TaskEventView }) {
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
          Started Codex {s(p.harnessVersion)} on{" "}
          <code className="font-mono text-xs">{s(p.branch)}</code>
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
              <li key={c.path} className="font-mono text-xs">
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
              <li key={st.text} className={st.done ? "text-muted line-through" : ""}>
                {st.done ? "☑" : "☐"} {st.text}
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
            <a href={s(p.url)} target="_blank" rel="noreferrer" className="text-accent underline">
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
    <div className="rounded-lg border border-border bg-surface-2/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <span
          className={
            status === "failed" ? "text-danger" : status === "completed" ? "text-ok" : "text-muted"
          }
        >
          {status === "started" ? "…" : status === "failed" ? "✗" : "✓"}
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{s(payload.command)}</code>
        {output && <span className="text-xs text-muted">{open ? "hide" : "output"}</span>}
      </button>
      {open && output && (
        <pre className="max-h-80 overflow-auto border-t border-border px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {output}
        </pre>
      )}
    </div>
  );
}
