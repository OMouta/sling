import type { ActionCheckView } from "@sling/core";
import { schema } from "@sling/db";
import { inArray } from "drizzle-orm";
import type { AppContext } from "../context.ts";

type Row = typeof schema.actionChecks.$inferSelect;

export function toActionCheckView(row: Pick<Row, "state" | "message" | "checkedAt" | "createdAt">) {
  return {
    state: row.state,
    message: row.message,
    at: (row.checkedAt ?? row.createdAt).toISOString(),
  } satisfies ActionCheckView;
}

/** The checks of task steps, by step. */
export async function actionCheckViews(
  ctx: Pick<AppContext, "db">,
  actionIds: string[],
): Promise<Map<string, ActionCheckView>> {
  if (actionIds.length === 0) return new Map();
  const rows = await ctx.db
    .select({
      actionId: schema.actionChecks.actionId,
      state: schema.actionChecks.state,
      message: schema.actionChecks.message,
      checkedAt: schema.actionChecks.checkedAt,
      createdAt: schema.actionChecks.createdAt,
    })
    .from(schema.actionChecks)
    .where(inArray(schema.actionChecks.actionId, actionIds));
  return new Map(rows.flatMap((r) => (r.actionId ? [[r.actionId, toActionCheckView(r)]] : [])));
}
