/**
 * Where an allow rule meets a send from chat, just before Sling would ask:
 * either a rule answers for the user, or the card gets the rule its Always
 * allow would make.
 */
import type { PermissionMode, RuleOfferView, RuleView } from "@sling/core";
import type { ToolScope } from "../agent/tools.ts";
import type { AppContext } from "../context.ts";
import type { RuleCall } from "./service.ts";

/** What a send is, as rules see it. */
export interface RuleSubject {
  /** A flagged node type, or `run_workflow`. */
  action: string;
  installationId: string | null;
  args: Record<string, unknown>;
  /** The call's audit details. They get the rule's ID when a rule answers. */
  details: Record<string, unknown>;
}

/**
 * The rule that lets this send go without asking, noted on its step and in
 * its audit; or, when none does, what the card can offer.
 */
export async function ruleAnswer(
  ctx: AppContext,
  scope: ToolScope,
  mode: PermissionMode,
  summary: string,
  toolCallId: string,
  subject: RuleSubject,
): Promise<{ rule: RuleView | null; offer: RuleOfferView | null }> {
  const call: RuleCall = {
    workspaceId: scope.workspaceId,
    ownerId: scope.ownerId,
    action: subject.action,
    installationId: subject.installationId,
    args: subject.args,
    mode,
    conversationId: scope.conversationId,
  };
  const rule = await ctx.rules.allowing(call);
  if (rule) {
    subject.details.ruleId = rule.id;
    await ctx.rules.used(rule, call);
    scope.trace?.toolUpdate(toolCallId, {
      approval: {
        id: `rule_${toolCallId}`,
        kind: "send",
        state: "approved",
        machine: "",
        summary,
        allowedBy: { ruleId: rule.id, summary: rule.summary },
      },
    });
    return { rule, offer: null };
  }
  // Working out an offer never stands in the way of the question itself.
  const offer = await ctx.rules.offer(call).catch((err: unknown) => {
    ctx.log.warn({ err, action: subject.action }, "rule offer failed");
    return null;
  });
  return { rule: null, offer };
}
