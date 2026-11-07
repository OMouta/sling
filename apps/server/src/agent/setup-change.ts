/**
 * How the assistant changes Sling's own setup: it proposes a change, the
 * chat shows it as a card, and it applies only as the conversation's mode
 * says, the same way sends do. Read-only refuses, Full access applies at
 * once, and every other mode waits for Apply.
 *
 * A change that needs a password, a token, or a secret URL always shows its
 * card, even in Full access, because that's the only place the user types
 * it. The value goes from the card to the server with the Apply, and only
 * the apply function below sees it: never the model, the trace, the tool's
 * result, the audit log, or the logs.
 */
import { randomBytes } from "node:crypto";
import type {
  CommandApprovalView,
  PermissionMode,
  SetupChangeRow,
  SetupChangeView,
  SetupSecretField,
} from "@sling/core";
import { sendPolicy } from "@sling/core";
import { schema } from "@sling/db";
import { eq } from "drizzle-orm";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import type { SecretValues } from "./commands.ts";
import type { ToolScope } from "./tools.ts";

export interface CallOptions {
  toolCallId: string;
  abortSignal?: AbortSignal;
}

/** What applying a change gave: something for the model, or why it didn't happen. */
export type Applied =
  | { ok: true; subjectId: string; result: Record<string, unknown> }
  | { ok: false; error: string };

export interface Proposal {
  tool: string;
  subjectType: "deploy_target" | "installation" | "workflow" | "personality" | "workspace" | "rule";
  /** The thing changed. Empty for something new, until it's made. */
  subjectId: string;
  change: SetupChangeView;
  /** Makes the change. `secrets` holds what the card asked for and the user typed. */
  apply: (secrets: SecretValues) => Promise<Applied>;
  /** Shows the card in every mode, as for a rule, which outlives the chat that made it. */
  always?: boolean;
}

export type ChangeDecision = "full_access" | "approved" | "denied" | "expired" | "refused";

export const REFUSED =
  "This conversation is Read-only, so it can't change Sling's setup. read_setup still works. Tell the user it needs another mode, which they switch in the app. Don't try another way.";
export const DENIED =
  "The user cancelled, so nothing changed. Don't try another way around it; ask what they'd like instead.";
export const EXPIRED =
  "The user didn't answer in time, so nothing changed. Don't try another way; ask them again if it still matters.";

const MAX_ROW_CHARS = 20_000;
const MAX_AUDIT_CHARS = 500;

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A value as one line of a card. */
export function shown(v: unknown): string {
  if (v === null || v === undefined || v === "") return "None";
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (Array.isArray(v)) return v.length === 0 ? "None" : v.map(shown).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  const text = String(v);
  return text.length > MAX_ROW_CHARS ? `${text.slice(0, MAX_ROW_CHARS)}…` : text;
}

/** A row for something new. */
export function row(label: string, after: unknown): SetupChangeRow {
  return { label, after: shown(after) };
}

/** A row for an edit, or nothing when the value stays the same. */
export function diff(label: string, before: unknown, after: unknown): SetupChangeRow[] {
  const b = shown(before);
  const a = shown(after);
  return a === b ? [] : [{ label, before: b, after: a }];
}

/** "imapHost" as "Imap host", for a field without a title. */
export function words(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One field of a JSON Schema object, as the assistant and the card need it. */
export interface FieldInfo {
  key: string;
  title: string;
  secret: boolean;
  required: boolean;
  hidden: boolean;
  advanced: boolean;
  placeholder?: string;
}

/** The fields of a connector's credentials or config schema, in the form's order. */
export function fieldsOf(
  json: Record<string, unknown>,
  secretFields: readonly string[],
): FieldInfo[] {
  const props = (json.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(props)
    .map(([key, p], i) => ({
      key,
      title: typeof p.title === "string" && p.title ? p.title : words(key),
      secret: secretFields.includes(key),
      // A field with a default is filled in when it's left out.
      required: required.has(key) && p.default === undefined,
      hidden: p.hidden === true,
      advanced: p.advanced === true,
      ...(typeof p.placeholder === "string" ? { placeholder: p.placeholder } : {}),
      order: typeof p.order === "number" ? p.order : 1_000 + i,
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...f }) => f);
}

/** Drops secret fields from what the model passed, which must never be used. */
export function withoutSecrets(
  values: Record<string, unknown> | undefined,
  secretFields: readonly string[],
): { kept: Record<string, unknown>; dropped: string[] } {
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(values ?? {})) {
    if (secretFields.includes(k)) dropped.push(k);
    else kept[k] = v;
  }
  return { kept, dropped };
}

/** An error with every secret the user typed taken out, in case something echoed one. */
export function redactSecrets(text: string, secrets: SecretValues): string {
  let out = text;
  for (const v of Object.values(secrets)) {
    if (v.length >= 3 && out.includes(v)) out = out.split(v).join("[redacted]");
  }
  return out;
}

export function secretField(
  key: string,
  label: string,
  required: boolean,
  extra: Partial<Pick<SetupSecretField, "placeholder" | "link">> = {},
): SetupSecretField {
  return { key, label, required, ...extra };
}

async function conversationMode(ctx: AppContext, id: string): Promise<PermissionMode | null> {
  const [conv] = await ctx.db
    .select({ mode: schema.conversations.mode })
    .from(schema.conversations)
    .where(eq(schema.conversations.id, id));
  return conv?.mode ?? null;
}

async function record(
  ctx: AppContext,
  scope: ToolScope,
  p: Proposal,
  entry: { decision: ChangeDecision; ok: boolean; subjectId?: string; error?: string },
) {
  await audit(ctx, {
    workspaceId: scope.workspaceId,
    actorType: "agent",
    verb: "assistant.change",
    subjectType: p.subjectType,
    subjectId: entry.subjectId || p.subjectId || "new",
    details: {
      tool: p.tool,
      conversationId: scope.conversationId,
      summary: p.change.title,
      rows: p.change.rows.map((r) => ({
        label: r.label,
        ...(r.before !== undefined ? { before: r.before.slice(0, MAX_AUDIT_CHARS) } : {}),
        after: r.after.slice(0, MAX_AUDIT_CHARS),
      })),
      // Which secrets the card asked for, never what was typed.
      secretFields: p.change.secrets.map((s) => s.key),
      decision: entry.decision,
      ok: entry.ok,
      ...(entry.error ? { error: entry.error.slice(0, MAX_AUDIT_CHARS) } : {}),
    },
  });
}

/**
 * Proposes a change and applies it as the conversation's mode allows,
 * showing its card in the chat. Returns what the model gets back.
 */
export async function propose(
  ctx: AppContext,
  scope: ToolScope,
  options: CallOptions,
  p: Proposal,
): Promise<Record<string, unknown>> {
  const mode = await conversationMode(ctx, scope.conversationId);
  if (!mode) return { error: "conversation not found" };
  const policy = sendPolicy(mode);
  if (policy === "refuse" && !p.always) {
    await record(ctx, scope, p, { decision: "refused", ok: false });
    return { error: REFUSED };
  }
  const trace = scope.trace;
  let decision: ChangeDecision = "full_access";
  let secrets: SecretValues = {};
  let card: CommandApprovalView | undefined;
  if (policy !== "run" || p.change.secrets.length > 0 || p.always) {
    if (!trace) return { error: "Can't ask the user to approve this from here." };
    const answer = await ctx.commands.change({
      workspaceId: scope.workspaceId,
      conversationId: scope.conversationId,
      change: p.change,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      onChange: (approval) => {
        card = approval;
        trace.toolUpdate(options.toolCallId, { approval });
      },
    });
    if (answer.decision !== "approved") {
      await record(ctx, scope, p, { decision: answer.decision, ok: false });
      return { error: answer.decision === "denied" ? DENIED : EXPIRED };
    }
    decision = "approved";
    secrets = answer.secrets;
  } else {
    // Full access doesn't ask, but the chat still shows what changed.
    card = {
      id: `cap_${randomBytes(12).toString("hex")}`,
      kind: "change",
      state: "approved",
      machine: "",
      summary: p.change.title,
      change: p.change,
    };
    trace?.toolUpdate(options.toolCallId, { approval: card });
  }
  let applied: Applied;
  try {
    applied = await p.apply(secrets);
  } catch (err) {
    applied = { ok: false, error: errorText(err) };
  }
  if (!applied.ok) {
    const error = redactSecrets(applied.error, secrets);
    await record(ctx, scope, p, { decision, ok: false, error });
    return { error };
  }
  await record(ctx, scope, p, { decision, ok: true, subjectId: applied.subjectId });
  const workflow = card?.change?.workflow;
  if (card?.change && workflow) {
    // The card links to the workflow in the editor once it exists.
    trace?.toolUpdate(options.toolCallId, {
      approval: {
        ...card,
        change: { ...card.change, workflow: { ...workflow, workflowId: applied.subjectId } },
      },
    });
  }
  return { applied: true, ...applied.result };
}
