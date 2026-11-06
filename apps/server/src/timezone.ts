import { schema } from "@sling/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "./context.ts";

/** True for a time zone name this Node knows, such as Europe/Lisbon. */
export function isTimeZone(name: string): boolean {
  if (!name || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The workspace's time zone. UTC until the web app sets one. */
export async function workspaceTimeZone(ctx: AppContext, workspaceId: string): Promise<string> {
  const [ws] = await ctx.db
    .select({ timeZone: schema.workspaces.timeZone })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  const tz = ws?.timeZone;
  return tz && isTimeZone(tz) ? tz : "UTC";
}
