import { z } from "zod";
import { defineNode } from "../types.ts";

/** Pushes a notification to the devices of the workflow's owner. */
export const notifyNode = defineNode({
  type: "app.notify",
  version: 1,
  title: "Notify my devices",
  description:
    "Sends a push notification to every device you turned notifications on for under Settings. Tapping it opens the page you give.",
  category: "action",
  configSchema: z.object({
    title: z.string().min(1).max(120).describe("The notification's title. May be an expression."),
    body: z
      .string()
      .max(400)
      .default("")
      .describe("The text under the title. May be an expression.")
      .meta({ widget: "textarea" }),
    open: z
      .string()
      .max(2000)
      .default("/")
      .describe(
        "The page a tap opens, as a path such as /c/<chat id>, or /?draft=…&personality=… for a new chat with a draft. May be an expression.",
      ),
    urgency: z
      .enum(["normal", "high"])
      .default("normal")
      .describe("high wakes a phone that's saving power. Use it for alerts."),
    ttlMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(60)
      .describe("How long the push service keeps trying to deliver it to a device that's off."),
  }),
  expressionFields: ["title", "body", "open"],
  inputs: [],
  outputs: [
    { name: "delivered", type: "number", description: "How many devices took the notification." },
  ],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: false,
  run: async (ctx, { config }) => {
    const open = String(config.open || "/");
    const url = open.startsWith("/") ? open : "/";
    const delivered = await ctx.services.app.push.notify(
      ctx.workspaceId,
      ctx.ownerId,
      {
        title: String(config.title).slice(0, 120),
        body: String(config.body ?? "").slice(0, 400),
        url,
        tag: `run:${ctx.runId}:${ctx.nodeId}`,
      },
      { urgency: config.urgency, ttlSeconds: config.ttlMinutes * 60 },
    );
    return { exec: "next", outputs: { delivered } };
  },
});

export const appNodes = [notifyNode];
