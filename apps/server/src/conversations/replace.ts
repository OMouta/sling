import type { ToolStep } from "@sling/core";
import { schema } from "@sling/db";
import { and, eq, gt } from "drizzle-orm";
import type { AppContext } from "../context.ts";

type MessageRow = typeof schema.messages.$inferSelect;

/**
 * Tools that only read, or only touch the chat and Sling's memory of the
 * user, so running them again changes nothing anyone else sees. Memory
 * dedupes what it saves. A check only looks at a site or runs a command in
 * its read-only sandbox.
 */
const STAYS_IN_CHAT = new Set([
  "list_machines",
  "get_task",
  "run_check",
  "read_setup",
  "workflow_nodes",
  "remember",
  "forget",
  "recall",
  "search_files",
  "read_file",
  "search_sources",
  "read_source",
  "web_search",
  "web_fetch",
]);

/** Keys a tool's result has once it did something, even when it then failed. */
const DID_SOMETHING = ["taskId", "installation", "machine", "applied", "status", "runId"];

function parsed(output: string | null): Record<string, unknown> | null {
  if (!output) return null;
  try {
    const v = JSON.parse(output);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Whether a tool call did something outside the chat: started a task or a
 * deploy, sent something, changed Sling's setup, or ran a command outside
 * the sandbox. Only what the trace stored counts, so anything unclear is
 * taken as a yes: running it twice could do it twice.
 */
export function hadSideEffect(step: ToolStep, reads: ReadonlySet<string> = new Set()): boolean {
  const approval = step.approval;
  // Approved, or allowed by a rule: the command, send, or change went ahead.
  if (approval?.state === "approved") return true;
  if (STAYS_IN_CHAT.has(step.name) || reads.has(step.name)) return false;
  const out = parsed(step.output);
  if (step.name === "run_command" && out?.sandboxed === true) return false;
  // Declined, expired, or still waiting when the turn ended: nothing ran.
  if (approval) return false;
  // Refused before doing anything, such as a task no machine could take.
  if (step.status === "done" && typeof out?.error === "string") {
    return DID_SOMETHING.some((k) => k in out);
  }
  return true;
}

/** The latest user message and every message after it, or null with none. */
export function latestExchange(
  rows: readonly MessageRow[],
): { user: MessageRow; after: MessageRow[] } | null {
  const i = rows.findLastIndex((r) => r.role === "user");
  const user = rows[i];
  return user ? { user, after: rows.slice(i + 1) } : null;
}

/**
 * The messages Retry (a reply) or Edit (a user message) may replace: the
 * latest user message and its reply, when the reply is there and nothing
 * since the message did anything outside the chat. A note from Sling after
 * it, such as a task finishing, belongs to work that's already out there.
 * `taskStarted` says a task began in the chat since the message, which an
 * interrupted turn can leave without a trace.
 */
export function replaceableIds(
  rows: readonly MessageRow[],
  opts: { reads?: ReadonlySet<string>; taskStarted?: boolean } = {},
): Set<string> {
  const exchange = latestExchange(rows);
  if (!exchange || opts.taskStarted) return new Set();
  const { user, after } = exchange;
  if (!after.some((r) => r.role === "assistant")) return new Set();
  // A notice for the person, such as a slow start, did nothing outside the chat.
  if (after.some((r) => r.role === "system" && !r.meta?.notice)) return new Set();
  for (const r of after) {
    for (const step of r.trace?.steps ?? []) {
      if (step.kind === "tool" && hadSideEffect(step, opts.reads)) return new Set();
    }
  }
  // An API turn stores each model step; the chat shows the last one as the reply.
  const reply = after.findLast((r) => r.role === "assistant");
  return new Set(reply ? [user.id, reply.id] : [user.id]);
}

/**
 * The app actions that only read, such as listing calendar events, by the
 * names the assistant calls them. A type that sends in any version is out.
 */
function readOnlyAppTools(ctx: AppContext): Set<string> {
  const sends = new Map<string, boolean>();
  for (const spec of ctx.registry.specs()) {
    if (!spec.assistant) continue;
    const name = spec.type.replace(/\./g, "_");
    sends.set(name, (sends.get(name) ?? false) || spec.assistant.sends);
  }
  return new Set([...sends].filter(([, s]) => !s).map(([name]) => name));
}

/** Whether a task started in the conversation after `since`. */
async function taskStartedSince(
  ctx: AppContext,
  conversationId: string,
  since: Date,
): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.conversationId, conversationId), gt(schema.tasks.createdAt, since)))
    .limit(1);
  return Boolean(row);
}

/** `replaceableIds` with what only the server knows: which app tools read, and the chat's tasks. */
export async function replaceable(
  ctx: AppContext,
  rows: readonly MessageRow[],
): Promise<Set<string>> {
  const reads = readOnlyAppTools(ctx);
  const ids = replaceableIds(rows, { reads });
  const exchange = latestExchange(rows);
  if (ids.size === 0 || !exchange) return ids;
  const started = await taskStartedSince(
    ctx,
    exchange.user.conversationId,
    exchange.user.createdAt,
  );
  return started ? new Set() : ids;
}
