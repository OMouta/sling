import { newId } from "@sling/core";
import { schema } from "@sling/db";
import type { AppContext } from "./context.ts";

export interface AuditEntry {
  workspaceId: string;
  actorType: "user" | "runner" | "agent" | "system";
  actorId?: string | null;
  verb: string;
  subjectType: string;
  subjectId: string;
  details?: Record<string, unknown>;
}

/** Append-only audit log. Failures are logged, never thrown at the caller. */
export async function audit(ctx: Pick<AppContext, "db" | "log">, entry: AuditEntry) {
  try {
    await ctx.db.insert(schema.auditEvents).values({
      id: newId("aud"),
      workspaceId: entry.workspaceId,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      verb: entry.verb,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      details: entry.details ?? {},
    });
  } catch (err) {
    ctx.log.error({ err, entry }, "audit write failed");
  }
}
