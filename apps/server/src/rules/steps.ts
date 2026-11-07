/**
 * Allow rules for a task's push and PR steps, which ask in Supervised. A
 * rule pins the repo, as `host/owner/name`. Merges and deploys never match.
 */
import type { ActionKind, RuleOfferView, RuleView } from "@sling/core";
import { type Db, schema } from "@sling/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import type { RuleCall } from "./service.ts";

type TaskRow = typeof schema.tasks.$inferSelect;
type ApprovalRow = typeof schema.approvals.$inferSelect;
type ActionRow = typeof schema.actions.$inferSelect;

/** The task's repo as `host/owner/name`: its machine's repo, or its sandbox's. */
async function repoKey(db: Db, task: TaskRow): Promise<string | null> {
  if (task.repoId) {
    const [repo] = await db
      .select({ key: schema.repos.remoteKey })
      .from(schema.repos)
      .where(eq(schema.repos.id, task.repoId));
    if (repo?.key) return repo.key;
  }
  if (task.sandboxId) {
    const [sbx] = await db
      .select({ key: schema.sandboxes.remoteKey })
      .from(schema.sandboxes)
      .where(eq(schema.sandboxes.id, task.sandboxId));
    if (sbx?.key) return sbx.key;
  }
  return null;
}

async function stepCall(db: Db, task: TaskRow, kind: ActionKind): Promise<RuleCall | null> {
  if (kind !== "push" && kind !== "open_pr") return null;
  const repo = await repoKey(db, task);
  if (!repo) return null;
  return {
    workspaceId: task.workspaceId,
    ownerId: task.ownerId,
    action: kind,
    installationId: null,
    args: { repo },
    mode: task.mode,
    conversationId: task.conversationId,
    taskId: task.id,
  };
}

/** The allow rule that lets this step go without asking, and the call to count its use with. */
export async function stepRule(
  ctx: AppContext,
  db: Db,
  task: TaskRow,
  kind: ActionKind,
): Promise<{ rule: RuleView; call: RuleCall } | null> {
  const call = await stepCall(db, task, kind);
  const rule = call ? await ctx.rules.allowing(call) : null;
  return call && rule ? { rule, call } : null;
}

/** What Always allow on a waiting push or PR approval would make. */
export async function stepRuleOffer(
  ctx: AppContext,
  approval: ApprovalRow,
  action: ActionRow | null,
  task: TaskRow | null,
): Promise<RuleOfferView | null> {
  if (approval.kind !== "task_action" || approval.state !== "pending" || !action || !task) {
    return null;
  }
  const call = await stepCall(ctx.db, task, action.kind);
  if (!call) return null;
  const offer = await ctx.rules.offer(call).catch((err: unknown) => {
    ctx.log.warn({ err, approvalId: approval.id }, "rule offer failed");
    return null;
  });
  return offer ? { ...offer, rule: { ...offer.rule, approvalId: approval.id } } : null;
}
