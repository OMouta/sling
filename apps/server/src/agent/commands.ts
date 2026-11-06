import { randomBytes } from "node:crypto";
import type { CommandApprovalView, PermissionMode } from "@sling/core";
import { create, EnvelopeSchema, type ExecResult } from "@sling/runner-protocol";
import type { AppContext } from "../context.ts";
import { modeToProto } from "../runners/convert.ts";
import type { RunnerSession } from "../runners/gateway.ts";

/** How long a command waits for the user to approve it. */
export const APPROVAL_WAIT_MS = 5 * 60_000;
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

interface Pending {
  runnerId: string;
  resolve: (r: CommandResult) => void;
  reject: (err: Error) => void;
}

interface Approval {
  workspaceId: string;
  conversationId: string;
  settle: (d: Decision) => void;
}

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
 * the answer, and holds the ones waiting for the user's approval. Nothing
 * here is stored: a command lives as long as the turn that asked for it.
 */
export class Commands {
  readonly #ctx: AppContext;
  readonly #pending = new Map<string, Pending>();
  readonly #approvals = new Map<string, Approval>();

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
   * Waits for the user to approve a command. `onChange` hears the approval's
   * state as it changes, first "pending", for the chat to show.
   */
  async approval(opts: {
    workspaceId: string;
    conversationId: string;
    machine: string;
    signal?: AbortSignal;
    onChange: (view: CommandApprovalView) => void;
  }): Promise<Decision> {
    const id = `cap_${randomBytes(12).toString("hex")}`;
    const view = (state: CommandApprovalView["state"]): CommandApprovalView => ({
      id,
      state,
      machine: opts.machine,
    });
    const decision = await new Promise<Decision>((resolve) => {
      const settle = (d: Decision) => {
        clearTimeout(timer);
        this.#approvals.delete(id);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(d);
      };
      const timer = setTimeout(() => settle("expired"), APPROVAL_WAIT_MS);
      const onAbort = () => settle("expired");
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.#approvals.set(id, {
        workspaceId: opts.workspaceId,
        conversationId: opts.conversationId,
        settle,
      });
      opts.onChange(view("pending"));
    });
    opts.onChange(view(decision));
    return decision;
  }

  /** Conversations with a command waiting for the user's answer. */
  waitingConversations(workspaceId: string): Set<string> {
    return new Set(
      [...this.#approvals.values()]
        .filter((a) => a.workspaceId === workspaceId)
        .map((a) => a.conversationId),
    );
  }

  /** The user's answer. False when there's no such approval waiting in this conversation. */
  decide(
    workspaceId: string,
    conversationId: string,
    id: string,
    decision: "approve" | "deny",
  ): boolean {
    const a = this.#approvals.get(id);
    if (!a || a.workspaceId !== workspaceId || a.conversationId !== conversationId) return false;
    a.settle(decision === "approve" ? "approved" : "denied");
    return true;
  }
}
