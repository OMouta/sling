import { MODE_POLICY } from "@sling/core";
import { schema } from "@sling/db";
import { tool } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { currentSteps, DeployLaterError } from "../tasks/service.ts";
import { taskView } from "../views.ts";
import type { ToolScope } from "./tools.ts";

/** Each repo's deploy target name, by remote key. */
export async function deployTargetNames(
  ctx: AppContext,
  workspaceId: string,
): Promise<Map<string, string>> {
  const rows = await ctx.db
    .select({ remoteKey: schema.deployTargets.remoteKey, name: schema.deployTargets.name })
    .from(schema.deployTargets)
    .where(eq(schema.deployTargets.workspaceId, workspaceId));
  return new Map(rows.map((r) => [r.remoteKey, r.name]));
}

/** Runs a target's checks now. The assistant names a target; it never gives a URL. */
export function runCheckTool(ctx: AppContext, scope: ToolScope) {
  return tool({
    description:
      "Run a deploy target's health checks now. Returns what each check answered, whether the site is up, the target's last deploy, and how it deploys. Name the target as the user or list_machines does. You can't check a URL of your own.",
    inputSchema: z.object({
      target: z.string().min(1).max(200).describe("The deploy target's name or id."),
    }),
    execute: async ({ target }) => {
      const row = await ctx.deploys.find(scope.workspaceId, target);
      if (!row) {
        const names = (await ctx.deploys.rows(scope.workspaceId)).map((r) => r.name);
        return {
          error: `No deploy target called ${target}. Targets: ${names.join(", ") || "none yet; the user adds them on the Deploys page"}.`,
        };
      }
      const view = await ctx.deploys.check(scope.workspaceId, row.id);
      if (!view?.lastCheck) return { error: "The target went away while it was being checked." };
      return {
        target: view.name,
        repo: view.remoteKey,
        method: view.method,
        up: view.lastCheck.up,
        failedChecksInARow: view.lastCheck.failures,
        checks: view.lastCheck.results.map((r) => ({
          url: r.url,
          ok: r.ok,
          status: r.status,
          ms: r.ms,
          error: r.error,
        })),
        hasVersionUrl: Boolean(view.versionUrl),
        lastDeploy: view.lastDeploy
          ? {
              taskId: view.lastDeploy.taskId,
              task: view.lastDeploy.taskTitle,
              commit: view.lastDeploy.commitSha,
              at: view.lastDeploy.at,
              state: view.lastDeploy.state,
            }
          : null,
      };
    },
  });
}

/** Adds merge, deploy, and verify to a task whose PR is open. */
export function deployTaskTool(ctx: AppContext, scope: ToolScope) {
  return tool({
    description:
      "Deploy a finished task whose pull request is open: Sling merges it, deploys the merged commit through the repo's deploy target, and checks the site. The user approves first, as the task's mode says. You get a [Sling update] when it waits for approval and when verify finishes.",
    inputSchema: z.object({ taskId: z.string().min(1).max(100) }),
    execute: async ({ taskId }) => {
      const [conv] = await ctx.db
        .select({ mode: schema.conversations.mode })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, scope.conversationId));
      if (!conv) return { error: "conversation not found" };
      if (!MODE_POLICY[conv.mode].writes) {
        return {
          error: `This conversation is ${MODE_POLICY[conv.mode].label}, so it can't deploy. The user can switch the mode in the app.`,
        };
      }
      try {
        await ctx.tasks.deployLater(scope.workspaceId, taskId, scope.ownerId);
      } catch (err) {
        if (err instanceof DeployLaterError) return { error: err.message };
        throw err;
      }
      const t = await taskView(ctx, taskId);
      if (!t) return { error: "no such task" };
      const steps = currentSteps(t.actions).filter((a) =>
        ["merge", "deploy", "verify"].includes(a.kind),
      );
      return {
        taskId: t.id,
        target: steps[0]?.targetName ?? null,
        steps: steps.map((a) => ({ step: a.kind, state: a.state, message: a.message })),
        ...(steps.some((a) => a.state === "awaiting_approval")
          ? {
              waitingForApproval: "The user approves the deploy in the app before anything merges.",
            }
          : {}),
      };
    },
  });
}
