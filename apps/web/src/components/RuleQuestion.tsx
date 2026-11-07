import { RULE_SUGGEST_AFTER, type RuleOfferView } from "@sling/core";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { streakOf, useAlwaysAllow } from "../lib/rules.ts";
import { Button, cx, ErrorText } from "./ui.tsx";

/**
 * The answer row of a question that a rule could answer next time. Always
 * allow first shows the rule it would make; confirming saves it and allows
 * this one. Without an offer it's the plain question.
 */
export function RuleQuestion({
  offers,
  approvalId,
  question,
  approve,
  deny,
  onDecide,
  className,
}: {
  offers: RuleOfferView[];
  /** The approval the rule is made from, when the offers don't name it. */
  approvalId: string | null;
  question?: ReactNode;
  approve: string;
  deny: string;
  onDecide: (allow: boolean) => Promise<unknown>;
  /** Its padding and background, for where it sits. */
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const decide = useMutation({ mutationFn: onDecide });
  const always = useAlwaysAllow(offers, approvalId, () => onDecide(true));
  const streak = streakOf(offers);
  const busy = decide.isPending || always.isPending;

  return (
    <div className={cx("space-y-1.5 border-t border-border", className)}>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="mr-auto min-w-0">
            <p className="text-xs text-muted">{offers.length > 1 ? "New rules" : "New rule"}</p>
            {offers.map((o) => (
              <p key={o.summary} className="text-[13px] font-medium break-words text-text">
                {o.summary}
              </p>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Back
            </Button>
            <Button
              size="sm"
              variant="primary"
              busy={always.isPending}
              onClick={() => always.mutate()}
            >
              Always allow
            </Button>
          </div>
        </div>
      ) : (
        <>
          {streak >= RULE_SUGGEST_AFTER && (
            <p className="text-xs text-muted">You've allowed this {streak} times</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="mr-auto min-w-0 text-[13px] text-soft">{question}</p>
            <div className="ml-auto flex gap-2">
              {offers.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  Always allow
                </Button>
              )}
              <Button size="sm" busy={decide.isPending} onClick={() => decide.mutate(false)}>
                {deny}
              </Button>
              <Button
                size="sm"
                variant="primary"
                busy={decide.isPending}
                disabled={always.isPending}
                onClick={() => decide.mutate(true)}
              >
                {approve}
              </Button>
            </div>
          </div>
        </>
      )}
      <ErrorText error={decide.error ?? always.error} />
    </div>
  );
}
