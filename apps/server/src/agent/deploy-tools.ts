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

/**
 * Runs a check now: a deploy target's site, or any other check, by name. The
 * assistant names a check; it never gives a URL or a command of its own.
 */
export function runCheckTool(ctx: AppContext, scope: ToolScope) {
  return tool({
    description:
      "Run one of the user's checks now, by its name: a deploy target's site, a command on a machine, or an email reply that's due. Returns what it saw and whether it's up. For a site that deploys, also the repo, how it deploys, and its last deploy. You can't check a URL or run a command of your own with it.",
    inputSchema: z.object({
      target: z
        .string()
        .min(1)
        .max(200)
        .describe("The check's name or id, such as a deploy target's name."),
    }),
    execute: async ({ target }) => {
      const found = await ctx.checks.find(scope.workspaceId, target);
      if (!found) {
        const names = (await ctx.checks.list(scope.workspaceId)).map((c) => c.name);
        return {
          error: `No check called ${target}. Checks: ${names.join(", ") || "none yet; the user adds them on the Checks page"}.`,
        };
      }
      const view = await ctx.checks.run(scope.workspaceId, found.id);
      const r = view?.lastResult;
      if (!view || !r) return { error: "The check went away while it ran." };
      const base = {
        check: view.name,
        kind: view.kind,
        state: view.state,
        message: r.message,
        failedRunsInARow: view.failures,
      };
      if (r.detail.kind === "command") {
        return {
          ...base,
          passed: r.passed,
          machine: view.runnerName,
          exitCode: r.detail.exitCode,
          output: r.detail.output,
          timedOut: r.detail.timedOut,
          ...(r.detail.error ? { error: r.detail.error } : {}),
        };
      }
      if (r.detail.kind === "reply") {
        return { ...base, met: r.passed, reply: r.detail.match, deadline: view.deadline };
      }
      const config = view.config.kind === "site" ? view.config : null;
      const d = view.deploy;
      return {
        ...base,
        target: view.name,
        up: r.passed,
        failedChecksInARow: view.failures,
        checks: r.detail.checks.map((c) => ({
          url: c.url,
          ok: c.ok,
          status: c.status,
          ms: c.ms,
          error: c.error,
        })),
        hasVersionUrl: Boolean(config?.versionUrl),
        ...(d
          ? {
              repo: d.remoteKey,
              method: d.method,
              lastDeploy: d.lastDeploy
                ? {
                    taskId: d.lastDeploy.taskId,
                    task: d.lastDeploy.taskTitle,
                    commit: d.lastDeploy.commitSha,
                    at: d.lastDeploy.at,
                    state: d.lastDeploy.state,
                  }
                : null,
            }
          : {}),
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
