import { DELIVERY_KINDS, HARNESSES, type RoutingView } from "@sling/core";
import { schema } from "@sling/db";
import { tool } from "ai";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { ENVIRONMENTS } from "../routing/router.ts";
import { type CreatedTask, TaskInputError, TaskRoutingError } from "../tasks/service.ts";
import { runnerViews, taskPlace, taskView } from "../views.ts";

export interface ToolScope {
  workspaceId: string;
  ownerId: string;
  conversationId: string;
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

export function agentTools(ctx: AppContext, scope: ToolScope) {
  return {
    list_machines: tool({
      description:
        "List the user's paired machines: whether each is online, its repos, labels, which coding agents are ready, and its permission cap. You don't need this to delegate, because Sling picks the machine. Use it to answer questions about machines, or to find the id of a machine the user names.",
      inputSchema: z.object({}),
      execute: async () => {
        const runners = await runnerViews(ctx, scope.workspaceId);
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
                  ? { ready: cap.ready, detail: cap.detail }
                  : { ready: false, detail: "not installed" },
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
          .enum(DELIVERY_KINDS)
          .default("pr")
          .describe(
            "local: keep the commit where it ran. push: push the branch. pr: push and open a PR.",
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
            "Only when the user names the coding agent: codex or claude-code. Otherwise the workspace default is used.",
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
            deliver: input.deliver,
            environment: input.environment,
            machineId: input.machineId ?? null,
            harness: input.harness ?? null,
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
