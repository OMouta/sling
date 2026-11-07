import type { DeployCheckResult } from "@sling/core";
import type { DeployLastCheck } from "@sling/db";
import { NodeError } from "@sling/workflow";
import { z } from "zod";
import { downReason } from "../../deploys/checks.ts";
import type { CheckOutcome } from "../../deploys/service.ts";
import { workspaceTimeZone } from "../../timezone.ts";
import { defineNode } from "../types.ts";

/** Failed checks in a row before a target counts as down. One pass brings it back up. */
export const DOWN_AFTER_FAILURES = 2;

export function isDown(c: DeployLastCheck | null): boolean {
  return (c?.failures ?? 0) >= DOWN_AFTER_FAILURES;
}

export interface TargetChange {
  target: string;
  up: boolean;
  wasUp: boolean;
  results: DeployCheckResult[];
  /** When the target started answering this way, as an ISO time. */
  since: string;
  /** "502", or the error when nothing answered. Empty once it's back up. */
  reason: string;
  /** `since` as HH:MM in the workspace's time zone. */
  sinceTime: string;
}

/** Targets that went down or came back up between their last check and this one. */
export function changesOf(outcomes: CheckOutcome[], timeZone: string): TargetChange[] {
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const out: TargetChange[] = [];
  for (const o of outcomes) {
    const wasUp = !isDown(o.before);
    const up = !isDown(o.after);
    if (wasUp === up) continue;
    const since = o.after.since ?? o.after.at;
    out.push({
      target: o.target.name,
      up,
      wasUp,
      results: o.after.results,
      since,
      reason: up ? "" : downReason(o.after.results),
      sinceTime: clock.format(new Date(since)),
    });
  }
  return out;
}

export const deploysCheckNode = defineNode({
  type: "deploys.check",
  version: 1,
  title: "Check deploy targets",
  description: `Runs the site check of every deploy target, or of the one named, now. Outputs the targets that went down or came back up since this step last ran: down after ${DOWN_AFTER_FAILURES} failed checks in a row, back up after one pass. Sling runs checks on its own, so a new workflow starts from Check changed instead.`,
  category: "action",
  configSchema: z.object({
    target: z
      .string()
      .max(200)
      .optional()
      .describe("A deploy target's name. Leave empty to check every target."),
  }),
  inputs: [],
  outputs: [
    {
      name: "changed",
      type: "list<json>",
      description:
        "Targets that went down or came back up: target, up, wasUp, results, since, reason, and sinceTime.",
    },
    {
      name: "targets",
      type: "list<json>",
      description: "Every target checked: name, up, failures, and results.",
    },
  ],
  execInput: true,
  execOutputs: [{ name: "next" }],
  // Checks are GETs, so running it again only checks again.
  idempotent: true,
  run: async (ctx, { config }) => {
    const app = ctx.services.app;
    const name = config.target?.trim();
    let rows = await app.deploys.rows(ctx.workspaceId);
    if (name) {
      const one = await app.deploys.find(ctx.workspaceId, name);
      if (!one) {
        throw new NodeError(`No deploy target called ${name}`, { code: "no_target" });
      }
      rows = [one];
    }
    const outcomes = await Promise.all(rows.map((t) => app.deploys.checkTarget(t)));
    const views = await app.deploys.views(outcomes.map((o) => o.target));
    for (const v of views) {
      app.hub.publish(ctx.workspaceId, { type: "deploy_target.updated", target: v });
    }
    const changed = changesOf(outcomes, await workspaceTimeZone(app, ctx.workspaceId));
    return {
      exec: "next",
      outputs: {
        changed,
        targets: outcomes.map((o) => ({
          name: o.target.name,
          up: o.after.up,
          failures: o.after.failures,
          results: o.after.results,
        })),
      },
    };
  },
});

export const deployNodes = [deploysCheckNode];
