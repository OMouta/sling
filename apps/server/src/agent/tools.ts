import { DELIVERY_KINDS } from "@sling/core";
import { schema } from "@sling/db";
import { tool } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { TaskInputError } from "../tasks/service.ts";
import { runnerViews, taskView } from "../views.ts";

export interface ToolScope {
  workspaceId: string;
  ownerId: string;
  conversationId: string;
}

/**
 * The master agent's tools. Every limit is enforced here and in the task
 * service, not in the prompt: the model can't pick the permission mode, can't
 * reach a machine outside the workspace, and has no shell or file access.
 */
export function agentTools(ctx: AppContext, scope: ToolScope) {
  return {
    list_machines: tool({
      description:
        "List the user's paired machines with their status, repos, Codex readiness, and permission cap.",
      inputSchema: z.object({}),
      execute: async () => {
        const runners = await runnerViews(ctx, scope.workspaceId);
        return runners.map((r) => {
          const codex = r.capabilities.find((c) => c.name === "coding.codex");
          return {
            id: r.id,
            name: r.name,
            online: r.online,
            os: r.os,
            codexReady: codex?.ready ?? false,
            codexDetail: codex?.detail ?? "not reported",
            maxMode: r.maxMode,
            repos: r.repos.map((p) => ({ name: p.name, defaultBranch: p.defaultBranch })),
          };
        });
      },
    }),

    delegate_coding_task: tool({
      description:
        "Start a coding task with Codex on one machine. Runs in the background in a fresh git worktree. Returns the task id right away; you get a [Sling update] when it finishes.",
      inputSchema: z.object({
        machineId: z.string().describe("Machine id from list_machines."),
        repo: z.string().describe("Repo name on that machine."),
        title: z.string().min(3).max(80).describe("Short title, used for the branch and PR."),
        objective: z
          .string()
          .min(10)
          .describe(
            "Self-contained instructions for Codex: what to change, why, and how to check it. Codex can't see this conversation.",
          ),
        deliver: z
          .enum(DELIVERY_KINDS)
          .default("pr")
          .describe(
            "local: keep the commit on the machine. push: push the branch. pr: push and open a PR.",
          ),
      }),
      execute: async (input) => {
        // The mode always comes from the conversation, read at call time.
        const [conv] = await ctx.db
          .select({ mode: schema.conversations.mode })
          .from(schema.conversations)
          .where(eq(schema.conversations.id, scope.conversationId));
        if (!conv) return { error: "conversation not found" };
        try {
          const task = await ctx.tasks.create({
            workspaceId: scope.workspaceId,
            ownerId: scope.ownerId,
            conversationId: scope.conversationId,
            runnerId: input.machineId,
            repoName: input.repo,
            title: input.title,
            objective: input.objective,
            mode: conv.mode,
            deliver: input.deliver,
          });
          return {
            taskId: task.id,
            branch: task.branch,
            mode: task.mode,
            deliver: task.deliver,
            state: task.state,
          };
        } catch (err) {
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
          machine: t.runnerName,
          repo: t.repoName,
          branch: t.branch,
          mode: t.mode,
          summaryFromCodex: t.summary,
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
