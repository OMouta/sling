import { MODE_POLICY, type RuleView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ShieldCheck, Zap } from "lucide-react";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { applyRuleEvent, useRules } from "../lib/rules.ts";
import { Content } from "./Page.tsx";
import { Button, Card, Empty, ErrorText, Skeleton } from "./ui.tsx";

/** Approvals → Rules: the standing answers in force, each with Revoke. */
export function RulesList() {
  const rules = useRules();
  const active = (rules.data ?? []).filter((r) => !r.revokedAt);
  const allow = active.filter((r) => r.kind === "allow");
  const start = active.filter((r) => r.kind === "start");

  if (rules.data && active.length === 0) {
    return <Empty fill icon={ShieldCheck} title="No rules yet" />;
  }
  return (
    <Content className="space-y-6">
      {rules.isPending && <Skeleton className="h-32 w-full rounded-xl" />}
      <ErrorText error={rules.error} />
      {allow.length > 0 && <RuleGroup title="Allowed without asking" rules={allow} />}
      {start.length > 0 && <RuleGroup title="Starts work" rules={start} />}
    </Content>
  );
}

function RuleGroup({ title, rules }: { title: string; rules: RuleView[] }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="px-1 text-xs font-medium text-subtle">{title}</h2>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-border">
          {rules.map((r) => (
            <RuleRow key={r.id} rule={r} />
          ))}
        </ul>
      </Card>
    </section>
  );
}

/** "Used 3 times, last 2 hours ago", or "Not used yet". */
function usage(rule: RuleView): string {
  if (rule.uses === 0) return rule.kind === "start" ? "Hasn't started a chat yet" : "Not used yet";
  const times =
    rule.kind === "start"
      ? `Started ${rule.uses === 1 ? "a chat" : `${rule.uses} chats`}`
      : `Used ${rule.uses === 1 ? "once" : `${rule.uses} times`}`;
  return rule.lastUsedAt ? `${times}, last ${ago(rule.lastUsedAt)}` : times;
}

function RuleRow({ rule }: { rule: RuleView }) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.del<RuleView>(`/api/rules/${rule.id}`),
    onSuccess: (view) => applyRuleEvent(qc, { type: "rule.updated", rule: view }),
  });
  const Icon = rule.kind === "start" ? Zap : ShieldCheck;
  const from = rule.createdFrom.conversationId;
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-3 text-soft shadow-active"
      >
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-5 font-medium break-words">{rule.summary}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-muted">
          {rule.kind === "start" && <span>{MODE_POLICY[rule.mode].label} ·</span>}
          <span>{usage(rule)}</span>
          {from && (
            <>
              <span aria-hidden="true">·</span>
              <Link
                to="/c/$id"
                params={{ id: from }}
                className="text-soft decoration-faint underline-offset-2 hover:text-text hover:underline"
              >
                From a chat
              </Link>
            </>
          )}
        </p>
        <ErrorText error={revoke.error} />
      </div>
      <Button size="sm" busy={revoke.isPending} onClick={() => revoke.mutate()}>
        Revoke
      </Button>
    </li>
  );
}
