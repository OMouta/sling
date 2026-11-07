import type { ConversationStartedBy } from "@sling/core";
import { Link } from "@tanstack/react-router";
import { Zap } from "lucide-react";
import { useRules } from "../lib/rules.ts";

const EVENT = {
  down: "went down",
  up: "came back up",
  met: "got its reply",
  missed: "missed its deadline",
} as const;

/** In a chat's header: the start rule that opened the chat, linking to Approvals → Rules. */
export function StartedBy({ by }: { by: ConversationStartedBy }) {
  const rules = useRules();
  const summary =
    rules.data?.find((r) => r.id === by.ruleId)?.summary ?? `${by.checkName} ${EVENT[by.on]}`;
  return (
    <Link
      to="/approvals"
      search={{ tab: "rules" }}
      title={`Started by your rule: ${summary}`}
      aria-label={`Started by your rule: ${summary}`}
      className="flex h-[22px] min-w-0 items-center gap-1.5 rounded-full bg-surface-2 px-2 text-xs text-soft shadow-raised transition-colors duration-150 hover:text-text"
    >
      <Zap aria-hidden="true" size={12} className="shrink-0 text-warn" />
      <span className="max-w-64 truncate max-sm:hidden">{summary}</span>
    </Link>
  );
}
