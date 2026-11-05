import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { NodeError, SLING_EVENTS } from "@sling/workflow";
import { z } from "zod";
import { approvalView } from "../../views.ts";
import { approvalObject } from "../sling-events.ts";
import { defineNode } from "../types.ts";

export const approvalNode = defineNode({
  type: "human.approval",
  version: 1,
  title: "Approval",
  description:
    "Asks you to approve before the run goes on. The request shows up under Approvals, and in Discord if an Approval notifications workflow is enabled.",
  category: "human",
  configSchema: z.object({
    title: z
      .string()
      .min(1)
      .max(200)
      .describe("What you're asked to approve. May be an expression."),
    timeoutHours: z
      .number()
      .min(0.05)
      .max(24 * 30)
      .default(24)
      .describe("After this many hours the request expires and the run leaves through expired."),
  }),
  expressionFields: ["title"],
  inputs: [{ name: "summary", type: "json", description: "Details shown with the request." }],
  outputs: [{ name: "approval", type: "approval", description: "The approval request." }],
  execInput: true,
  execOutputs: [{ name: "approved" }, { name: "rejected" }, { name: "expired" }],
  idempotent: false,
  run: async (ctx, { inputs, config }) => {
    const app = ctx.services.app;
    const id = newId("apv");
    await app.db.insert(schema.approvals).values({
      id,
      workspaceId: ctx.workspaceId,
      ownerId: ctx.ownerId,
      kind: "workflow",
      title: config.title,
      payload: { summary: inputs.summary ?? null, workflowId: ctx.workflowId, nodeId: ctx.nodeId },
      runId: ctx.runId,
      expiresAt: new Date(Date.now() + config.timeoutHours * 60 * 60 * 1000),
    });
    const view = await approvalView(app, id);
    if (!view) throw new NodeError("The approval wasn't saved", { code: "approval_failed" });
    app.hub.publish(ctx.workspaceId, { type: "approval.updated", approval: view });
    const approval = approvalObject(app, view);
    await app.events.emit({
      type: SLING_EVENTS.approvalRequested,
      workspaceId: ctx.workspaceId,
      payload: { approval },
      dedupeKey: `approval:${id}`,
    });
    return { wait: { kind: "approval", approvalId: id }, outputs: { approval } };
  },
  resume: async (_ctx, { resolution }) => {
    if (resolution.kind !== "approval")
      throw new NodeError("Unexpected wake-up", { code: "bad_resume" });
    return { exec: resolution.state };
  },
});
