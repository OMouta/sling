import type { ActionCheckView } from "@sling/core";
import { CircleCheck, CircleDashed, CircleHelp, CircleX } from "lucide-react";
import { cx } from "./ui.tsx";

const LOOK = {
  passed: { Icon: CircleCheck, tone: "text-ok", label: "Checked" },
  failed: { Icon: CircleX, tone: "text-danger", label: "Check failed" },
  waiting: { Icon: CircleDashed, tone: "text-subtle", label: "Still checking" },
  unchecked: { Icon: CircleHelp, tone: "text-subtle", label: "Couldn't check" },
} as const;

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * What Sling saw when it looked after an action: the event read back, the
 * message fetched, or a PR's CI. `row` sits at the bottom of a step's card.
 */
export function ActionCheckLine({
  check,
  variant = "line",
  className,
}: {
  check: ActionCheckView;
  variant?: "row" | "line";
  className?: string;
}) {
  const look = LOOK[check.state];
  return (
    <p
      role="status"
      aria-label={`${look.label}: ${check.message}`}
      title={`${look.label} at ${clock(check.at)}`}
      className={cx(
        "flex min-w-0 items-center gap-1.5 text-xs leading-4",
        variant === "row" && "border-t border-border px-2.5 py-1.5",
        check.state === "failed" ? "text-danger" : "text-muted",
        className,
      )}
    >
      <look.Icon
        aria-hidden="true"
        size={13}
        className={cx(
          "shrink-0",
          look.tone,
          check.state === "waiting" && "animate-spin [animation-duration:3s]",
        )}
      />
      <span className="min-w-0 truncate">{check.message}</span>
    </p>
  );
}
