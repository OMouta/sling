import {
  AGENT_MODEL_PATTERN,
  DELIVERY_KINDS,
  HARNESSES,
  MODE_POLICY,
  type PermissionMode,
  type PersonalityTool,
  type RoutingView,
  type RunnerView,
} from "@sling/core";
import { schema } from "@sling/db";
import { tool } from "ai";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { ENVIRONMENTS } from "../routing/router.ts";
import { type CreatedTask, TaskInputError, TaskRoutingError } from "../tasks/service.ts";
import { runnerViews, taskPlace, taskView } from "../views.ts";
import { APPROVAL_WAIT_MS, type CommandResult } from "./commands.ts";
import { checkDeployTargetTool, deployTargetNames, deployTaskTool } from "./deploy-tools.ts";
import type { TraceRecorder } from "./trace.ts";

export interface ToolScope {
  workspaceId: string;
  ownerId: string;
  conversationId: string;
  /** The reply being written, where a command waiting on approval shows. */
  trace?: TraceRecorder | undefined;
}

/** What a tool call gets besides its input. */
interface CallOptions {
  toolCallId: string;
  abortSignal?: AbortSignal;
}

const cap = (r: RunnerView, name: string) => r.capabilities.find((c) => c.name === name);

/** The online machine a command runs on, or why there isn't one. */
export function pickCommandMachine(
  runners: RunnerView[],
  want: string | undefined,
): { runner: RunnerView } | { error: string } {
  const online = runners.filter((r) => r.online);
  const name = want?.trim().toLowerCase();
  if (name) {
    const r = runners.find((x) => x.id === want?.trim() || x.name.toLowerCase() === name);
    if (!r) {
      return {
        error: `No machine named ${want}. Machines: ${runners.map((x) => x.name).join(", ") || "none"}.`,
      };
    }
    if (!r.online) return { error: `${r.name} is offline.` };
    return { runner: r };
  }
  const [only] = online;
  if (online.length === 1 && only) return { runner: only };
  if (online.length === 0) {
    return {
      error:
        runners.length === 0
          ? "The user has no machines paired with Sling."
          : `No machine is online. ${runners.map((r) => r.name).join(", ")} ${runners.length === 1 ? "is" : "are"} offline.`,
    };
  }
  return {
    error: `${online.length} machines are online: ${online.map((r) => r.name).join(", ")}. Pass machine with the one to use, or ask the user.`,
  };
}

/**
 * Where a command runs. In Full access, outside the sandbox. Otherwise in the
 * read-only sandbox, unless the assistant asks to leave it, which the user
 * approves first. Read-only never leaves it, and neither does a machine whose
 * max mode is below Full access, which refuses to.
 */
export function commandPlan(
  mode: PermissionMode,
  runner: RunnerView,
  outsideSandbox: boolean,
): { sandboxed: boolean; ask: boolean } | { error: string } {
  const shell = cap(runner, "shell");
  if (!shell) {
    return {
      error: `The Runner on ${runner.name} is too old to run commands. Update sling-runner there.`,
    };
  }
  if (!shell.ready) return { error: `Commands are off on ${runner.name}. ${shell.detail}`.trim() };
  const sandbox = cap(runner, "shell.sandbox");
  const canSandbox = sandbox?.ready ?? false;
  const noSandbox = `${runner.name} can't sandbox commands: ${sandbox?.detail || "no sandbox found"}`;
  const fullMachine = runner.maxMode === "full-access";
  const capped = `${runner.name} runs commands only in its read-only sandbox, because its max mode is ${MODE_POLICY[runner.maxMode].label}.`;

  if (mode === "read-only") {
    if (outsideSandbox) {
      return {
        error:
          "This conversation is Read-only, so commands can't write files or use the network. The user can switch the mode in the app.",
      };
    }
    return canSandbox ? { sandboxed: true, ask: false } : { error: `${noSandbox}.` };
  }
  if (!(outsideSandbox || !canSandbox)) {
    return { sandboxed: !(mode === "full-access" && fullMachine), ask: false };
  }
  if (!fullMachine) return { error: canSandbox ? capped : `${noSandbox}, and ${capped}` };
  return { sandboxed: false, ask: mode !== "full-access" };
}

/** Finds a sandbox provider installation by ID or name. Null leaves the choice to the router. */
export async function resolveProvider(
  ctx: AppContext,
  workspaceId: string,
  idOrName: string | null | undefined,
): Promise<string | null> {
  const want = idOrName?.trim();
  if (!want) return null;
  const [row] = await ctx.db
    .select({ id: schema.connectorInstallations.id })
    .from(schema.connectorInstallations)
    .where(
      and(
        eq(schema.connectorInstallations.workspaceId, workspaceId),
        or(
          eq(schema.connectorInstallations.id, want),
          eq(schema.connectorInstallations.name, want),
        ),
      ),
    );
  // An unknown name goes to the router as is, which explains there's no such provider.
  return row?.id ?? want;
}

/** What a tool result says about where a task went. */
export function routingSummary(routing: RoutingView) {
  return {
    reason: routing.reason,
    considered: routing.considered.map((c) => `${c.runnerName}: ${c.reason}`),
  };
}

function created(c: CreatedTask) {
  const target = c.routing.target;
  return {
    taskId: c.task.id,
    branch: c.task.branch,
    mode: c.task.mode,
    deliver: c.task.deliver,
    state: c.task.state,
    agent: c.task.harness,
    environment: c.task.environment,
    machine: target?.kind === "machine" ? target.runnerName : null,
    sandboxProvider: target?.kind === "sandbox" ? target.providerName : null,
    routing: routingSummary(c.routing),
    ...(c.approvalId
      ? {
          waitingForApproval:
            "No machine can take it. It runs in a sandbox only if the user approves, in the app or wherever they get approvals.",
        }
      : {}),
  };
}

/** The tools each personality tool group gives the assistant. */
export const TOOLS_BY_GROUP: Record<PersonalityTool, readonly string[]> = {
  commands: ["list_machines", "run_command"],
  coding: ["list_machines", "delegate_coding_task", "get_task", "cancel_task"],
  // Also every connector action flagged for the assistant, added per turn.
  apps: ["run_workflow"],
  deploys: ["list_machines", "check_deploy_target", "deploy_task"],
};

/** Tool names a personality with these groups may call. */
export function allowedTools(groups: readonly PersonalityTool[]): Set<string> {
  return new Set(groups.flatMap((g) => TOOLS_BY_GROUP[g] ?? []));
}

/**
 * The assistant's tools. With `allowed`, only those: a personality's limits
 * are enforced here, never left to the prompt.
 */
export function agentTools(ctx: AppContext, scope: ToolScope, allowed?: ReadonlySet<string>) {
  // Without the deploy tools, delegate_coding_task doesn't offer the deploy delivery either.
  const all = allTools(ctx, scope, !allowed || allowed.has("deploy_task"));
  if (!allowed) return all;
  return Object.fromEntries(Object.entries(all).filter(([name]) => allowed.has(name))) as Partial<
    typeof all
  >;
}

function allTools(ctx: AppContext, scope: ToolScope, canDeploy: boolean) {
  const deliveries = canDeploy ? DELIVERY_KINDS : DELIVERY_KINDS.filter((d) => d !== "deploy");
  return {
    list_machines: tool({
      description:
        "List the user's paired machines: whether each is online, its repos, labels, which coding agents are ready, and its permission cap. You don't need this to delegate, because Sling picks the machine. Use it to answer questions about machines, or to find the id of a machine the user names.",
      inputSchema: z.object({}),
      execute: async () => {
        const [runners, targets] = await Promise.all([
          runnerViews(ctx, scope.workspaceId),
          deployTargetNames(ctx, scope.workspaceId),
        ]);
        const allowed = new Set(
          (
            await ctx.db
              .select({ key: schema.sandboxRepos.remoteKey })
              .from(schema.sandboxRepos)
              .where(eq(schema.sandboxRepos.workspaceId, scope.workspaceId))
          ).map((r) => r.key),
        );
        return runners.map((r) => {
          const agents = Object.fromEntries(
            HARNESSES.map((h) => {
              const cap = r.capabilities.find((c) => c.name === `coding.${h}`);
              return [
                h,
                cap
                  ? {
                      ready: cap.ready,
                      detail: cap.detail,
                      models: (cap.models ?? []).map((m) => m.id),
                    }
                  : { ready: false, detail: "not installed", models: [] },
              ];
            }),
          );
          return {
            id: r.id,
            name: r.name,
            online: r.online,
            os: r.os,
            labels: r.labels,
            agents,
            maxMode: r.maxMode,
            repos: r.repos.map((p) => ({
              name: p.name,
              defaultBranch: p.defaultBranch,
              remote: p.remoteKey,
              allowedInSandboxes: p.remoteKey ? allowed.has(p.remoteKey) : false,
              deployTarget: (p.remoteKey && targets.get(p.remoteKey)) || null,
            })),
          };
        });
      },
    }),

    delegate_coding_task: tool({
      description:
        "Start a coding task. Sling routes it: a machine that's online, has the repo, has the coding agent ready, and allows this conversation's mode, or, when none can, a sandbox the user approves. It runs in the background in a fresh git worktree. Returns right away with the task id and why it went where it did; you get a [Sling update] when it finishes.",
      inputSchema: z.object({
        repo: z.string().min(1).describe("Repo name, or its remote such as github.com/owner/name."),
        title: z.string().min(3).max(80).describe("Short title, used for the branch and PR."),
        objective: z
          .string()
          .min(10)
          .describe(
            "Self-contained instructions for the coding agent: what to change, why, and how to check it. It can't see this conversation.",
          ),
        deliver: z
          .enum(deliveries as [string, ...string[]])
          .default("pr")
          .describe(
            canDeploy
              ? 'local: keep the commit where it ran. push: push the branch. pr: push and open a PR. deploy: open a PR, then merge it, deploy it through the repo\'s deploy target, and check the site, once the user approves the deploy. Use "deploy" only when the user wants the change live or the site is down, and only for a repo with a deploy target.'
              : "local: keep the commit where it ran. push: push the branch. pr: push and open a PR.",
          ),
        machineId: z
          .string()
          .optional()
          .describe("Only when the user names a machine: its id from list_machines."),
        environment: z
          .enum(ENVIRONMENTS)
          .default("auto")
          .describe(
            "auto: Sling picks a machine, and asks the user about a sandbox if none can take it. machine: the user's machines only. sandbox: a fresh sandbox, only when the user asks for one.",
          ),
        harness: z
          .enum(HARNESSES)
          .optional()
          .describe(
            "The coding agent: codex or claude-code. Pick the one that suits the task, or the one the user names. Leave it out for the workspace default.",
          ),
        model: z
          .string()
          .regex(AGENT_MODEL_PATTERN)
          .optional()
          .describe(
            "The agent's model, one of the ids listed for it in your instructions or by list_machines. Leave it out for the agent's own default.",
          ),
        effort: z
          .enum(["low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe(
            "Reasoning effort for the agent. Higher for hard or wide changes, lower for small edits. Leave it out for the model's default.",
          ),
        labels: z
          .array(z.string().min(1).max(64))
          .max(16)
          .optional()
          .describe(
            'Labels the machine must have, when the work needs one, for example ["ios"] for an iOS build.',
          ),
        providerInstallationId: z
          .string()
          .optional()
          .describe("Only when the user names a sandbox provider: its name or id."),
      }),
      execute: async (input) => {
        // The mode always comes from the conversation, read at call time.
        const [conv] = await ctx.db
          .select({ mode: schema.conversations.mode })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, scope.conversationId));
        if (!conv) return { error: "conversation not found" };
        try {
          const result = await ctx.tasks.create({
            workspaceId: scope.workspaceId,
            ownerId: scope.ownerId,
            conversationId: scope.conversationId,
            repo: input.repo,
            title: input.title,
            objective: input.objective,
            mode: conv.mode,
            deliver: input.deliver as (typeof DELIVERY_KINDS)[number],
            environment: input.environment,
            machineId: input.machineId ?? null,
            harness: input.harness ?? null,
            // A model or effort the assistant picked replaces the conversation's default.
            ...(input.harness && (input.model || input.effort)
              ? {
                  agent: {
                    harness: input.harness,
                    model: input.model ?? null,
                    effort: input.effort ?? null,
                    fast: false,
                  },
                }
              : {}),
            labels: input.labels ?? [],
            providerInstallationId: await resolveProvider(
              ctx,
              scope.workspaceId,
              input.providerInstallationId,
            ),
          });
          return created(result);
        } catch (err) {
          if (err instanceof TaskRoutingError) {
            return {
              error: err.message,
              reasons: err.reasons,
              routing: routingSummary(err.routing),
            };
          }
          if (err instanceof TaskInputError) return { error: err.message };
          throw err;
        }
      },
    }),

    get_task: tool({
      description: "Get the current state of a task, its summary, and delivery steps.",
      inputSchema: z.object({ taskId: z.string() }),
      execute: async ({ taskId }) => {
        const [row] = await ctx.db
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, scope.workspaceId)));
        if (!row) return { error: "no such task" };
        const t = await taskView(ctx, taskId);
        if (!t) return { error: "no such task" };
        return {
          state: t.state,
          title: t.title,
          agent: t.harness,
          runsOn: taskPlace(t),
          environment: t.environment.kind,
          sandboxState: t.environment.sandboxState,
          routing: t.routing?.reason ?? null,
          repo: t.repoName,
          branch: t.branch,
          mode: t.mode,
          summaryFromAgent: t.summary,
          error: t.error,
          diffStats: t.diffStats,
          machineOffline: t.runnerOffline,
          delivery: t.actions.map((a) => ({
            step: a.kind,
            state: a.state,
            url: a.url,
            message: a.message,
          })),
        };
      },
    }),

    run_command: tool({
      description:
        "Run a shell command on one of the user's machines, as the user, and get its output. Use it to look around a machine: list or read files, search, check versions, disk space, processes, git status or log. It runs in the user's shell, in their home directory unless you pass cwd, and stops anything it leaves running when it ends. By default it runs in a read-only sandbox that can read any file but can't write files or use the network. Set outsideSandbox only when the command must change files or reach the network; outside Full access the user approves it in the chat first. In Full access commands always run outside the sandbox. Changing code in a repo still goes to delegate_coding_task.",
      inputSchema: z.object({
        command: z.string().min(1).max(16_000).describe("The command, as typed in a terminal."),
        machine: z
          .string()
          .optional()
          .describe("The machine's name or id. Leave it out when only one machine is online."),
        cwd: z
          .string()
          .max(1024)
          .optional()
          .describe(
            "Where to run it: an absolute path or one starting with ~/. Defaults to the home directory.",
          ),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(300)
          .default(60)
          .describe("Stop it after this many seconds."),
        outsideSandbox: z
          .boolean()
          .default(false)
          .describe("True only when the command must write files or use the network."),
      }),
      execute: async (input, options: CallOptions) => {
        const [conv] = await ctx.db
          .select({ mode: schema.conversations.mode })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, scope.conversationId));
        if (!conv) return { error: "conversation not found" };
        const picked = pickCommandMachine(await runnerViews(ctx, scope.workspaceId), input.machine);
        if ("error" in picked) return picked;
        const { runner } = picked;
        const plan = commandPlan(conv.mode, runner, input.outsideSandbox);
        if ("error" in plan) return plan;

        if (plan.ask) {
          const trace = scope.trace;
          if (!trace) return { error: "Can't ask the user to approve a command from here." };
          const decision = await ctx.commands.approval({
            workspaceId: scope.workspaceId,
            conversationId: scope.conversationId,
            machine: runner.name,
            ...(options.abortSignal ? { signal: options.abortSignal } : {}),
            onChange: (approval) => trace.toolUpdate(options.toolCallId, { approval }),
          });
          await audit(ctx, {
            workspaceId: scope.workspaceId,
            actorType: "user",
            actorId: scope.ownerId,
            verb: `command.${decision}`,
            subjectType: "runner",
            subjectId: runner.id,
            details: { conversationId: scope.conversationId, command: input.command.slice(0, 500) },
          });
          if (decision === "denied") {
            return {
              error:
                "The user declined to run this outside the sandbox. Don't try another way around it; ask what they'd like instead.",
            };
          }
          if (decision === "expired") {
            return {
              error: `The user didn't answer within ${APPROVAL_WAIT_MS / 60_000} minutes, so it didn't run.`,
            };
          }
        }

        let result: CommandResult;
        try {
          result = await ctx.commands.run(
            runner.id,
            {
              command: input.command,
              cwd: input.cwd ?? "",
              timeoutSeconds: input.timeoutSeconds,
              mode: conv.mode,
              sandboxed: plan.sandboxed,
            },
            options.abortSignal,
          );
        } catch (err) {
          return { machine: runner.name, error: err instanceof Error ? err.message : String(err) };
        }
        await audit(ctx, {
          workspaceId: scope.workspaceId,
          actorType: "agent",
          verb: "command.run",
          subjectType: "runner",
          subjectId: runner.id,
          details: {
            conversationId: scope.conversationId,
            command: input.command.slice(0, 500),
            sandboxed: result.sandboxed,
            exitCode: result.exitCode,
            error: result.error || undefined,
          },
        });
        if (result.error) return { machine: runner.name, error: result.error };
        return {
          machine: runner.name,
          cwd: result.cwd,
          sandboxed: result.sandboxed,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          durationMs: result.durationMs,
          output: result.output,
        };
      },
    }),

    check_deploy_target: checkDeployTargetTool(ctx, scope),
    deploy_task: deployTaskTool(ctx, scope),

    cancel_task: tool({
      description: "Cancel a queued or running task. Only do this when the user asks.",
      inputSchema: z.object({ taskId: z.string() }),
      execute: async ({ taskId }) => {
        const t = await ctx.tasks.cancel(scope.workspaceId, taskId, scope.ownerId);
        return t ? { ok: true } : { error: "no such task" };
      },
    }),
  };
}
