import { randomBytes } from "node:crypto";
import type {
  CommandApprovalView,
  PermissionMode,
  RuleOfferView,
  SetupChangeView,
} from "@sling/core";
import { schema } from "@sling/db";
import { create, EnvelopeSchema, type ExecResult } from "@sling/runner-protocol";
import { and, eq, lt } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { modeToProto } from "../runners/convert.ts";
import type { RunnerSession } from "../runners/gateway.ts";

/** How long a command, a send, or a setup change waits for the user to approve it. */
export const APPROVAL_WAIT_MS = 5 * 60_000;
/** Longest secret a setup change takes from its card. */
export const MAX_SECRET_LENGTH = 4_096;
/** Extra time past a command's own timeout before Sling stops waiting for the machine. */
const ANSWER_GRACE_MS = 15_000;

export interface CommandRequest {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  mode: PermissionMode;
  sandboxed: boolean;
}

export interface CommandResult {
  /** Null when the command never ran or was killed. */
  exitCode: number | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  /** Why it didn't run. Empty when it ran. */
  error: string;
  durationMs: number;
  sandboxed: boolean;
  cwd: string;
}

export type Decision = "approved" | "denied" | "expired";

/** What the user typed into a change's card. Never log it, store it, or hand it to a model. */
export type SecretValues = Record<string, string>;

/** The user's answer to a setup change: approved ones carry the secrets the card asked for. */
export type ChangeDecision =
  | { decision: "approved"; secrets: SecretValues }
  | { decision: "denied" | "expired" };

/** Why the server didn't take an answer. */
export type DecideResult = "ok" | "gone" | "bad_secrets" | "missing_secrets";

interface Pending {
  runnerId: string;
  resolve: (r: CommandResult) => void;
  reject: (err: Error) => void;
}

interface Approval {
  workspaceId: string;
  conversationId: string;
  kind: CommandApprovalView["kind"];
  /** When it expires, in ms. */
  expiresAt: number;
  /** For a change: the secret fields its card shows. Null for commands and sends, which take none. */
  secrets: { key: string; required: boolean }[] | null;
  settle: (d: Decision, secrets?: SecretValues) => void;
}

/** Why an approval expired: nobody answered, its turn stopped, or Sling restarted while it waited. */
export type ExpiredReason = "timeout" | "stopped" | "restart";

/** How a chat's approval went, as stored. */
export interface ApprovalOutcome {
  workspaceId: string;
  conversationId: string;
  kind: CommandApprovalView["kind"];
  state: "pending" | "approved" | "denied" | "expired";
  reason: ExpiredReason | null;
}

/** Keep the outcomes of chat approvals this long, for late answers and the audit of a chat. */
const OUTCOME_DAYS = 30;

function toResult(r: ExecResult): CommandResult {
  return {
    exitCode: r.exitCode ?? null,
    output: r.output,
    truncated: r.truncated,
    timedOut: r.timedOut,
    error: r.error.slice(0, 1000),
    durationMs: Number(r.durationMs),
    sandboxed: r.sandboxed,
    cwd: r.cwd,
  };
}

/**
 * The assistant's shell commands: sends each to its machine and waits for
 * the answer. It also holds what waits in a chat for the user's approval: a
 * command that wants to leave the sandbox, or a send such as an email. The
 * wait lives as long as the turn that asked, so a restart ends it; each
 * approval's outcome is stored, so a late answer can say why it came late.
 */
export class Commands {
  readonly #ctx: AppContext;
  readonly #pending = new Map<string, Pending>();
  readonly #approvals = new Map<string, Approval>();
  /** How long an approval waits for the user before it expires. Tests shorten it. */
  approvalWaitMs = APPROVAL_WAIT_MS;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  /** Runs a command on a machine. Rejects when the machine can't be reached or doesn't answer. */
  run(runnerId: string, req: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    const requestId = `exe_${randomBytes(12).toString("hex")}`;
    return new Promise<CommandResult>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(
        () => {
          done();
          reject(new Error("The machine didn't answer in time."));
        },
        req.timeoutSeconds * 1000 + ANSWER_GRACE_MS,
      );
      const onAbort = () => {
        done();
        reject(new Error("Stopped."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(requestId, {
        runnerId,
        resolve: (r) => {
          done();
          resolve(r);
        },
        reject: (err) => {
          done();
          reject(err);
        },
      });
      const sent = this.#ctx.runners.send(
        runnerId,
        create(EnvelopeSchema, {
          body: {
            case: "execRequest",
            value: {
              requestId,
              command: req.command,
              cwd: req.cwd,
              timeoutSeconds: req.timeoutSeconds,
              mode: modeToProto(req.mode),
              sandboxed: req.sandboxed,
            },
          },
        }),
      );
      if (!sent) this.#pending.get(requestId)?.reject(new Error("The machine is offline."));
    });
  }

  /** An answer from a Runner. Only the machine a command went to may answer it. */
  handleResult(session: RunnerSession, r: ExecResult) {
    const p = this.#pending.get(r.requestId);
    if (!p || p.runnerId !== session.runnerId) return;
    p.resolve(toResult(r));
  }

  runnerDisconnected(runnerId: string) {
    for (const p of [...this.#pending.values()]) {
      if (p.runnerId === runnerId) p.reject(new Error("The machine disconnected."));
    }
  }

  /**
   * Waits for the user to approve a command or a send. `onChange` hears the
   * approval's state as it changes, first "pending", for the chat to show.
   */
  async approval(
    opts: {
      workspaceId: string;
      conversationId: string;
      signal?: AbortSignal;
      onChange: (view: CommandApprovalView) => void;
    } & (
      | { kind?: "command"; machine: string }
      | {
          kind: "send";
          /** What would go out, as the user sees it. */
          summary: string;
          /** The rule the card's Always allow would make. */
          ruleOffer?: RuleOfferView;
        }
    ),
  ): Promise<Decision> {
    const view = (id: string, state: CommandApprovalView["state"]): CommandApprovalView =>
      opts.kind === "send"
        ? {
            id,
            kind: "send",
            state,
            machine: "",
            summary: opts.summary,
            ...(opts.ruleOffer ? { ruleOffer: opts.ruleOffer } : {}),
          }
        : { id, kind: "command", state, machine: opts.machine, summary: "" };
    const { decision } = await this.#wait(opts, null, view);
    return decision;
  }

  /**
   * Waits for the user to apply or cancel a change to Sling's setup. The card
   * shows the change and an input for each of its secret fields; an approval
   * comes back with what was typed there, which never passes through the
   * model or the trace.
   */
  async change(opts: {
    workspaceId: string;
    conversationId: string;
    change: SetupChangeView;
    signal?: AbortSignal;
    onChange: (view: CommandApprovalView) => void;
  }): Promise<ChangeDecision> {
    const view = (id: string, state: CommandApprovalView["state"]): CommandApprovalView => ({
      id,
      kind: "change",
      state,
      machine: "",
      summary: opts.change.title,
      change: opts.change,
    });
    const secrets = opts.change.secrets.map((s) => ({ key: s.key, required: s.required }));
    const { decision, secrets: typed } = await this.#wait(opts, secrets, view);
    return decision === "approved"
      ? { decision, secrets: typed ?? {} }
      : { decision: decision === "denied" ? "denied" : "expired" };
  }

  async #wait(
    opts: {
      workspaceId: string;
      conversationId: string;
      signal?: AbortSignal;
      onChange: (view: CommandApprovalView) => void;
    },
    secrets: Approval["secrets"],
    view: (id: string, state: CommandApprovalView["state"]) => CommandApprovalView,
  ): Promise<{ decision: Decision; secrets?: SecretValues }> {
    const id = `cap_${randomBytes(12).toString("hex")}`;
    const kind = view(id, "pending").kind;
    const expiresAt = Date.now() + this.approvalWaitMs;
    // The card shows at once; its record is written alongside, and how it
    // ended is written only after that, so the outcome always lands on it.
    const stored = this.#ctx.db
      .insert(schema.chatApprovals)
      .values({
        id,
        workspaceId: opts.workspaceId,
        conversationId: opts.conversationId,
        kind,
        expiresAt: new Date(expiresAt),
      })
      .then(
        () => true,
        (err) => {
          this.#ctx.log.error({ err, id }, "couldn't store a chat approval");
          return false;
        },
      );
    let reason: ExpiredReason | null = null;
    const out = await new Promise<{ decision: Decision; secrets?: SecretValues }>((resolve) => {
      const settle = (d: Decision, typed?: SecretValues) => {
        clearTimeout(timer);
        this.#approvals.delete(id);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(typed ? { decision: d, secrets: typed } : { decision: d });
      };
      const timer = setTimeout(() => {
        reason = "timeout";
        settle("expired");
      }, this.approvalWaitMs);
      const onAbort = () => {
        reason = "stopped";
        settle("expired");
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.#approvals.set(id, {
        workspaceId: opts.workspaceId,
        conversationId: opts.conversationId,
        kind,
        expiresAt,
        secrets,
        settle,
      });
      opts.onChange(view(id, "pending"));
    });
    if (await stored) {
      await this.#ctx.db
        .update(schema.chatApprovals)
        .set({ state: out.decision, reason, decidedAt: new Date() })
        .where(and(eq(schema.chatApprovals.id, id), eq(schema.chatApprovals.state, "pending")))
        .catch((err) =>
          this.#ctx.log.error({ err, id }, "couldn't store a chat approval's outcome"),
        );
    }
    opts.onChange(view(id, out.decision));
    return out;
  }

  /** How an approval went, from what was stored. Null for an ID Sling never asked. */
  async outcome(id: string): Promise<ApprovalOutcome | null> {
    const a = schema.chatApprovals;
    const [row] = await this.#ctx.db
      .select({
        workspaceId: a.workspaceId,
        conversationId: a.conversationId,
        kind: a.kind,
        state: a.state,
        reason: a.reason,
      })
      .from(a)
      .where(eq(a.id, id));
    return row ?? null;
  }

  /**
   * Ends every approval that was waiting when Sling stopped. Their turns are
   * gone, so nothing they asked for can happen; a late answer hears why.
   */
  async expireInterrupted(): Promise<number> {
    const a = schema.chatApprovals;
    const ended = await this.#ctx.db
      .update(a)
      .set({ state: "expired", reason: "restart", decidedAt: new Date() })
      .where(eq(a.state, "pending"))
      .returning({ id: a.id });
    return ended.length;
  }

  /** Forgets outcomes older than a month, in the daily prune. */
  async pruneOutcomes(): Promise<number> {
    const a = schema.chatApprovals;
    const gone = await this.#ctx.db
      .delete(a)
      .where(lt(a.createdAt, new Date(Date.now() - OUTCOME_DAYS * 24 * 60 * 60_000)))
      .returning({ id: a.id });
    return gone.length;
  }

  /** What waits under this ID, while it waits. */
  waiting(
    id: string,
  ): Pick<Approval, "workspaceId" | "conversationId" | "kind" | "expiresAt"> | null {
    const a = this.#approvals.get(id);
    return a
      ? {
          workspaceId: a.workspaceId,
          conversationId: a.conversationId,
          kind: a.kind,
          expiresAt: a.expiresAt,
        }
      : null;
  }

  /** Conversations with a command, a send, or a change waiting for the user's answer. */
  waitingConversations(workspaceId: string): Set<string> {
    return new Set(
      [...this.#approvals.values()]
        .filter((a) => a.workspaceId === workspaceId)
        .map((a) => a.conversationId),
    );
  }

  /**
   * The user's answer. Only a change takes secrets, only the keys its card
   * asked for, and approving it needs every required one. `gone` when there's
   * no such approval waiting in this conversation.
   */
  decide(
    workspaceId: string,
    conversationId: string,
    id: string,
    decision: "approve" | "deny",
    secrets?: Record<string, string>,
  ): DecideResult {
    const a = this.#approvals.get(id);
    if (!a || a.workspaceId !== workspaceId || a.conversationId !== conversationId) return "gone";
    if (decision === "deny") {
      a.settle("denied");
      return "ok";
    }
    if (!a.secrets) {
      if (secrets && Object.keys(secrets).length > 0) return "bad_secrets";
      a.settle("approved");
      return "ok";
    }
    const asked = new Map(a.secrets.map((s) => [s.key, s.required]));
    const typed: SecretValues = {};
    for (const [k, v] of Object.entries(secrets ?? {})) {
      if (!asked.has(k) || typeof v !== "string" || v.length > MAX_SECRET_LENGTH) {
        return "bad_secrets";
      }
      if (v !== "") typed[k] = v;
    }
    for (const [k, required] of asked) {
      if (required && !typed[k]?.trim()) return "missing_secrets";
    }
    a.settle("approved", typed);
    return "ok";
  }
}
