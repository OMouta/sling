import { ArrowLeft, Check, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button, cx, Dialog } from "./ui.tsx";

export interface WizardStep {
  id: string;
  /** The question the step asks, as its heading. */
  title: string;
  /** One short line under the heading, only when it helps. */
  hint?: ReactNode;
  content: ReactNode;
  /** Continue stays off while this is true. */
  blocked?: boolean;
  /** Continue shows a spinner while this is true, such as a lookup still running. */
  busy?: boolean;
  /** Runs on Continue. Resolve false to stay on the step. */
  onNext?: () => boolean | Promise<boolean>;
}

/** A row on the review screen, for editing what's already set up. */
export interface ReviewRow {
  stepId: string;
  label: string;
  value: ReactNode;
}

/**
 * A form one question at a time: a heading, what Sling found, the fields for
 * it, and Back and Continue. The last step's button does the work, and a done
 * screen says what happened. Editing opens on a review of every answer, and
 * each row opens its step.
 */
export function Wizard({
  title,
  steps,
  finishLabel,
  onFinish,
  finishing,
  error,
  secondary,
  done,
  review,
  reviewTop,
  onClose,
}: {
  title: string;
  steps: WizardStep[];
  /** The last step's button, such as "Add". */
  finishLabel: string;
  /** Resolves true when it worked, to show the done screen or close. */
  onFinish: () => boolean | Promise<boolean>;
  finishing?: boolean;
  /** Shown above the buttons, such as a failed connection check. */
  error?: ReactNode;
  /** Another button next to the main one, such as "Add anyway". */
  secondary?: ReactNode;
  /** What to show once it worked. Without it the dialog closes. */
  done?: ReactNode;
  /** Edit mode: start on a review of these rows, and save from there. */
  review?: ReviewRow[];
  /** Fields above the review rows, such as the name. */
  reviewTop?: ReactNode;
  onClose: () => void;
}) {
  const editing = review !== undefined;
  const [at, setAt] = useState<number | "review" | "done">(editing ? "review" : 0);
  const [advancing, setAdvancing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  // Its own, so a wizard opened over another one submits its own step.
  const formId = `wizard-step${useId()}`;

  // A step that disappears (its fields no longer apply) can't strand you past the end.
  const index = typeof at === "number" ? Math.min(at, Math.max(steps.length - 1, 0)) : at;
  const step = typeof index === "number" ? steps[index] : undefined;
  const last = typeof index === "number" && index === steps.length - 1;

  // Each step starts at its first field.
  useEffect(() => {
    if (typeof index !== "number") return;
    const first = body.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]):not([disabled]), textarea, select, [role=radio]",
    );
    first?.focus({ preventScroll: true });
  }, [index]);

  const finish = async () => {
    if (await onFinish()) {
      if (done) setAt("done");
      else onClose();
    }
  };

  const next = async () => {
    if (!step || step.blocked || step.busy || advancing) return;
    if (step.onNext) {
      setAdvancing(true);
      try {
        if (!(await step.onNext())) return;
      } finally {
        setAdvancing(false);
      }
    }
    if (editing) setAt("review");
    else if (last) await finish();
    else setAt((typeof index === "number" ? index : 0) + 1);
  };

  const back = () => {
    if (editing) setAt("review");
    else if (typeof index === "number" && index > 0) setAt(index - 1);
  };

  const footer =
    index === "done" ? (
      <Button variant="primary" data-autofocus onClick={onClose}>
        Done
      </Button>
    ) : index === "review" ? (
      <>
        {error && <div className="mr-auto min-w-0 text-xs text-danger">{error}</div>}
        <Button onClick={onClose}>Cancel</Button>
        {secondary}
        <Button variant="primary" busy={finishing} onClick={() => void finish()}>
          {finishLabel}
        </Button>
      </>
    ) : (
      <>
        {(editing || (typeof index === "number" && index > 0)) && (
          <Button icon={ArrowLeft} className="mr-auto" onClick={back}>
            Back
          </Button>
        )}
        {secondary && last && !editing ? secondary : null}
        <Button
          variant="primary"
          type="submit"
          form={formId}
          busy={advancing || step?.busy || (last && !editing && finishing)}
          disabled={step?.blocked}
        >
          {editing ? "Done" : last ? finishLabel : "Continue"}
        </Button>
      </>
    );

  return (
    <Dialog title={title} onClose={onClose} footer={footer}>
      {!editing && index !== "done" && steps.length > 1 && (
        <ol aria-label="Steps" className="mb-5 flex gap-1">
          {steps.map((s, i) => (
            <li
              key={s.id}
              aria-current={i === index ? "step" : undefined}
              className={cx(
                "h-1 flex-1 rounded-full transition-colors duration-200",
                typeof index === "number" && i <= index ? "bg-accent" : "bg-surface-3",
              )}
            >
              <span className="sr-only">
                Step {i + 1} of {steps.length}: {s.title}
              </span>
            </li>
          ))}
        </ol>
      )}

      {index === "done" ? (
        <div className="anim-pop flex flex-col items-center py-6 text-center">
          <span className="mb-4 grid size-11 place-items-center rounded-full bg-ok/15 text-ok">
            <Check aria-hidden="true" size={20} strokeWidth={2.5} />
          </span>
          {done}
        </div>
      ) : index === "review" ? (
        <div className="space-y-4">
          {reviewTop}
          <ul
            aria-label="Settings"
            className="divide-y divide-border overflow-hidden rounded-xl bg-surface-2 shadow-raised"
          >
            {(review ?? []).map((r) => {
              const i = steps.findIndex((s) => s.id === r.stepId);
              return (
                <li key={`${r.stepId}.${r.label}`}>
                  <button
                    type="button"
                    disabled={i < 0}
                    onClick={() => setAt(i)}
                    className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-150 hover:bg-hover disabled:cursor-default"
                  >
                    <span className="w-32 shrink-0 text-xs text-muted">{r.label}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text">{r.value}</span>
                    {i >= 0 && (
                      <ChevronRight aria-hidden="true" size={14} className="shrink-0 text-subtle" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : step ? (
        <form
          id={formId}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void next();
          }}
          className="min-h-[180px]"
        >
          <div ref={body} key={step.id} className="anim-fade space-y-4">
            <div className="space-y-1">
              <h3 className="text-[15px] leading-5 font-medium">{step.title}</h3>
              {step.hint && <p className="text-xs leading-4 text-muted">{step.hint}</p>}
            </div>
            {step.content}
          </div>
          {error && last && !editing && (
            <div
              role="alert"
              className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-xs leading-4 text-danger"
            >
              {error}
            </div>
          )}
        </form>
      ) : null}
    </Dialog>
  );
}
