import { randomBytes } from "node:crypto";
import { type AssistantChoice, canChatOn, type Harness, isCliProvider } from "@sling/core";
import { schema } from "@sling/db";
import { type ChatEvent, create, EnvelopeSchema } from "@sling/runner-protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import type { RunnerSession } from "../runners/gateway.ts";
import type { TraceRecorder } from "./trace.ts";
import { cliToolFinished, cliToolStarted } from "./web.ts";

/** A turn runs at most this long before it's given up. */
const TURN_TIMEOUT_MS = 10 * 60_000;

export interface CliTurnResult {
  text: string;
  sessionId: string;
  runnerId: string;
  usage: { input: number; output: number };
}

/** What a turn's tool token may act for. */
export interface ToolGrant {
  turnId: string;
  workspaceId: string;
  ownerId: string;
  conversationId: string;
  /** The only tools this turn may call: its personality's. */
  tools: ReadonlySet<string>;
  /** Tools for the user's apps, built when the turn started. */
  appTools: Readonly<Record<string, unknown>>;
  expiresAt: number;
}

interface Pending {
  runnerId: string;
  onDelta: (text: string) => void;
  onTool: (name: string) => void;
  trace: TraceRecorder | undefined;
  resolve: (r: CliTurnResult) => void;
  reject: (err: Error) => void;
  token: string;
}

export class NoChatMachine extends Error {
  constructor(label: string) {
    super(
      `No machine has ${label} ready to chat. Start sling-runner on a machine where ${label} is logged in, or pick another model.`,
    );
  }
}

/**
 * Assistant turns that run on a coding agent's CLI, on one of the user's
 * machines and its own login. The Runner runs the CLI with no file or shell
 * tools; Sling's tools reach it through `sling-runner mcp`, which calls back
 * here with the turn's token.
 */
export class CliChat {
  readonly #ctx: AppContext;
  readonly #turns = new Map<string, Pending>();
  readonly #grants = new Map<string, ToolGrant>();

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  /** The machine a turn runs on: the one holding the session, else any with the CLI ready. */
  async pickMachine(
    workspaceId: string,
    harness: Harness,
    prefer: string | null,
  ): Promise<string | null> {
    const rows = await this.#ctx.db
      .select({ id: schema.runners.id, capabilities: schema.runners.capabilities })
      .from(schema.runners)
      .where(
        and(
          eq(schema.runners.workspaceId, workspaceId),
          eq(schema.runners.ephemeral, false),
          isNull(schema.runners.revokedAt),
        ),
      );
    const ready = rows.filter(
      (r) => this.#ctx.runners.isOnline(r.id) && canChatOn(r.capabilities, harness),
    );
    return ready.find((r) => r.id === prefer)?.id ?? ready[0]?.id ?? null;
  }

  async run(opts: {
    workspaceId: string;
    ownerId: string;
    conversationId: string;
    choice: AssistantChoice;
    label: string;
    instructions: string;
    /** Tool names the turn may call. */
    tools: readonly string[];
    /** Tools for the user's apps, served alongside Sling's own. */
    appTools?: Record<string, unknown>;
    prompt: string;
    history: string;
    session: { harness: Harness; runnerId: string; sessionId: string } | null;
    signal?: AbortSignal;
    onDelta: (text: string) => void;
    onTool?: (name: string) => void;
    /** Collects the turn's thinking, and its tool calls as Sling serves them. */
    trace?: TraceRecorder;
    /** The CLI's own web search and page reading. */
    web?: boolean;
    /** How long the turn may run. Ten minutes when absent. */
    timeoutMs?: number;
  }): Promise<CliTurnResult> {
    const timeoutMs = opts.timeoutMs ?? TURN_TIMEOUT_MS;
    const harness = opts.choice.provider;
    if (!isCliProvider(harness)) throw new Error("not a CLI provider");
    const sameAgent = opts.session?.harness === harness ? opts.session : null;
    const runnerId = await this.pickMachine(opts.workspaceId, harness, sameAgent?.runnerId ?? null);
    if (!runnerId) throw new NoChatMachine(opts.label);

    const turnId = `ctn_${randomBytes(12).toString("hex")}`;
    const token = randomBytes(32).toString("base64url");
    this.#grants.set(token, {
      turnId,
      workspaceId: opts.workspaceId,
      ownerId: opts.ownerId,
      conversationId: opts.conversationId,
      tools: new Set(opts.tools),
      appTools: opts.appTools ?? {},
      expiresAt: Date.now() + timeoutMs,
    });
    const resume = sameAgent && sameAgent.runnerId === runnerId ? sameAgent.sessionId : "";

    return new Promise<CliTurnResult>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.#turns.delete(turnId);
        // Calls already in flight finish; later ones are refused.
        setTimeout(() => this.#grants.delete(token), 30_000).unref?.();
        opts.signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        this.cancel(turnId);
        done();
        reject(new Error("The machine didn't finish the turn in time."));
      }, timeoutMs);
      const onAbort = () => {
        this.cancel(turnId);
        done();
        reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("aborted"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.#turns.set(turnId, {
        runnerId,
        token,
        onDelta: opts.onDelta,
        onTool: opts.onTool ?? (() => {}),
        trace: opts.trace,
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
            case: "chatTurn",
            value: {
              turnId,
              harness,
              model: opts.choice.model,
              effort: opts.choice.effort ?? "",
              fast: opts.choice.fast,
              instructions: opts.instructions,
              prompt: opts.prompt,
              sessionId: resume,
              toolsUrl: `${this.#ctx.config.publicUrl.origin}/api/agent/tools`,
              toolsToken: token,
              history: resume ? "" : opts.history,
              web: opts.web ?? false,
            },
          },
        }),
      );
      if (!sent) this.#turns.get(turnId)?.reject(new NoChatMachine(opts.label));
    });
  }

  cancel(turnId: string) {
    const t = this.#turns.get(turnId);
    if (!t) return;
    this.#ctx.runners.send(
      t.runnerId,
      create(EnvelopeSchema, { body: { case: "chatCancel", value: { turnId } } }),
    );
  }

  /** Events from a Runner. Only the machine a turn was sent to may answer it. */
  handleEvent(session: RunnerSession, ev: ChatEvent) {
    const t = this.#turns.get(ev.turnId);
    if (!t || t.runnerId !== session.runnerId) return;
    switch (ev.kind.case) {
      case "delta":
        if (ev.kind.value.text) t.onDelta(ev.kind.value.text);
        return;
      case "toolUse":
        // Sling records its own tools when it serves them, and the CLI's here.
        if (ev.kind.value.builtin) cliToolStarted(t.trace, ev.kind.value);
        else t.onTool(ev.kind.value.name);
        return;
      case "toolResult":
        cliToolFinished(t.trace, ev.kind.value);
        return;
      case "thinking":
        t.trace?.thinking(ev.kind.value.text);
        return;
      case "done": {
        const d = ev.kind.value;
        if (d.error) {
          t.reject(new Error(d.error));
          return;
        }
        t.resolve({
          text: d.text,
          sessionId: d.sessionId,
          runnerId: t.runnerId,
          usage: { input: Number(d.inputTokens), output: Number(d.outputTokens) },
        });
        return;
      }
      default:
        return;
    }
  }

  /** A machine went away: its turns can't finish. */
  runnerDisconnected(runnerId: string) {
    for (const t of [...this.#turns.values()]) {
      if (t.runnerId === runnerId) t.reject(new Error("The machine disconnected during the turn."));
    }
  }

  /** Where a turn's tool calls are recorded, while the turn runs. */
  traceFor(turnId: string): TraceRecorder | undefined {
    return this.#turns.get(turnId)?.trace;
  }

  /** The grant for a tool call, or null when the token is unknown or expired. */
  grant(token: string): ToolGrant | null {
    const g = this.#grants.get(token);
    if (!g) return null;
    if (g.expiresAt < Date.now()) {
      this.#grants.delete(token);
      return null;
    }
    return g;
  }
}
