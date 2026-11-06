import { DELIVERY_KINDS, HARNESSES, PERMISSION_MODES } from "@sling/core";
import { schema } from "@sling/db";
import { NodeError } from "@sling/workflow";
import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { resolveProvider } from "../../agent/tools.ts";
import { ENVIRONMENTS } from "../../routing/router.ts";
import { TaskInputError } from "../../tasks/service.ts";
import { defineNode } from "../types.ts";

export const delegateNode = defineNode({
  type: "agent.delegate_coding_task",
  version: 1,
  title: "Delegate coding task",
  description:
    "Starts a coding task on the machine Sling picks, or in a sandbox, and waits until it finishes, needs approval, or is delivered. A deploy is delivered once its site has been checked.",
  category: "agent",
  configSchema: z.object({
    machine: z
      .string()
      .optional()
      .describe(
        "Name or ID of a machine. With the environment set to auto it's a preference; with machine it's the only one allowed. Leave empty to let Sling pick.",
      ),
    environment: z
      .enum(ENVIRONMENTS)
      .optional()
      .describe(
        "auto picks a machine and asks to use a sandbox when none can take it. machine never uses a sandbox. sandbox always does. Defaults to machine when a machine is set, otherwise auto.",
      ),
    repo: z.string().min(1).describe("Repo name, or its remote such as github.com/owner/name."),
    title: z
      .string()
      .min(3)
      .max(80)
      .describe("Short title, used for the branch and pull request. May be an expression."),
    objective: z
      .string()
      .optional()
      .describe(
        "What the coding agent should do, when the objective input has no edge. It sees nothing else, so be specific. May be an expression.",
      )
      .meta({ widget: "textarea" }),
    deliver: z
      .enum(DELIVERY_KINDS)
      .default("pr")
      .describe(
        "local keeps the commit where it ran, push pushes the branch, pr also opens a pull request. deploy also merges it once approved, deploys it through the repo's deploy target, and checks the site; the repo needs a deploy target.",
      ),
    mode: z
      .enum(PERMISSION_MODES)
      .optional()
      .describe("Permission mode for the task. Defaults to the workspace's default mode."),
    harness: z
      .enum(HARNESSES)
      .optional()
      .describe("Coding agent to run. Defaults to the workspace's default agent."),
    labels: z
      .array(z.string().min(1).max(64))
      .optional()
      .describe("Labels the machine must have, for example ios."),
    providerInstallationId: z
      .string()
      .optional()
      .describe("Name or ID of the sandbox provider to use. Defaults to the first enabled one."),
  }),
  expressionFields: ["title", "objective"],
  inputs: [
    {
      name: "objective",
      type: "string",
      required: true,
      description: "Instructions for the coding agent.",
    },
  ],
  outputs: [{ name: "task", type: "task", description: "The task and how it settled." }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: false,
  run: async (ctx, { inputs, config }) => {
    const app = ctx.services.app;
    let machineId: string | null = null;
    if (config.machine) {
      const [runner] = await app.db
        .select({ id: schema.runners.id })
        .from(schema.runners)
        .where(
          and(
            eq(schema.runners.workspaceId, ctx.workspaceId),
            isNull(schema.runners.revokedAt),
            eq(schema.runners.ephemeral, false),
            or(eq(schema.runners.id, config.machine), eq(schema.runners.name, config.machine)),
          ),
        );
      if (!runner) {
        throw new NodeError(`No machine called ${config.machine}`, { code: "no_machine" });
      }
      machineId = runner.id;
    }
    let mode = config.mode;
    if (!mode) {
      const [ws] = await app.db
        .select({ mode: schema.workspaces.defaultMode })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, ctx.workspaceId));
      mode = ws?.mode ?? "auto";
    }
    try {
      const { task } = await app.tasks.create({
        workspaceId: ctx.workspaceId,
        ownerId: ctx.ownerId,
        conversationId: null,
        repo: config.repo,
        title: config.title,
        objective: String(inputs.objective),
        mode,
        deliver: config.deliver,
        environment: config.environment ?? (machineId ? "machine" : "auto"),
        machineId,
        harness: config.harness ?? null,
        labels: config.labels ?? [],
        providerInstallationId: await resolveProvider(
          app,
          ctx.workspaceId,
          config.providerInstallationId,
        ),
      });
      return {
        wait: { kind: "task", taskId: task.id },
        outputs: { task: { id: task.id, title: task.title, state: task.state } },
      };
    } catch (err) {
      if (err instanceof TaskInputError) throw new NodeError(err.message, { code: "task_refused" });
      throw err;
    }
  },
  resume: async (_ctx, { resolution }) => {
    if (resolution.kind !== "task")
      throw new NodeError("Unexpected wake-up", { code: "bad_resume" });
    return { exec: "next", outputs: { task: resolution.task } };
  },
});

export const assistantNode = defineNode({
  type: "agent.assistant",
  version: 1,
  title: "Assistant",
  description:
    "Runs the Sling assistant for one turn in a conversation: it reads the history, can delegate coding work to your machines within the conversation's mode, and saves its reply.",
  category: "agent",
  configSchema: z.object({
    message: z
      .string()
      .optional()
      .describe(
        "A new user message to add before the turn, when the message input has no edge. Leave empty for web chat, whose messages are already saved. May be an expression.",
      ),
  }),
  expressionFields: ["message"],
  inputs: [
    {
      name: "conversation",
      type: "conversation",
      required: true,
      description: "The conversation.",
    },
    {
      name: "message",
      type: "string",
      description:
        "A message from an outside channel to add as the user's turn. Web chat messages are already saved, so leave this unconnected there.",
    },
  ],
  outputs: [{ name: "reply", type: "string", description: "The assistant's reply text." }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  // A re-run checks whether the interrupted turn already started a task, and says so instead.
  idempotent: true,
  run: async (ctx, { inputs }) => {
    const app = ctx.services.app;
    const ref = inputs.conversation as { id?: string } | null;
    const [conv] = await app.db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, String(ref?.id ?? "")),
          eq(schema.conversations.workspaceId, ctx.workspaceId),
        ),
      );
    if (!conv) throw new NodeError("The conversation doesn't exist", { code: "no_conversation" });
    const message = typeof inputs.message === "string" ? inputs.message.trim() : "";
    if (message) await app.agent.addUserMessage(conv, message, { once: ctx.attempt > 1 });
    const { reply } = await app.agent.runTurn(conv.id, {
      resumed: ctx.attempt > 1,
      signal: ctx.signal,
    });
    return { exec: "next", outputs: { reply } };
  },
});

export const agentNodes = [delegateNode, assistantNode];
