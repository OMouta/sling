/**
 * `save_rule`: the assistant makes a rule the user asked for. It always
 * shows its card, in every mode, Full access included, because a rule
 * outlives the chat that made it. Nothing is saved until Apply.
 */
import {
  MODE_POLICY,
  modeWithinCap,
  type PermissionMode,
  type RuleInput,
  type SetupChangeRow,
  START_RULE_EVENTS,
  START_RULE_MODES,
  type StartRuleMode,
} from "@sling/core";
import { schema } from "@sling/db";
import { type Tool, tool } from "ai";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { type CallOptions, propose, row } from "../agent/setup-change.ts";
import type { ToolScope } from "../agent/tools.ts";
import type { AppContext } from "../context.ts";
import { keyFromInput } from "../routing/router.ts";
import { RuleInputError } from "./service.ts";
import { defaultStartMessage } from "./start.ts";

/** What the prompt says about rules, in the setup section. */
export const RULES_NOTE =
  "- save_rule makes a standing answer. When the user says to stop asking before something, such as adding calendar events or emailing someone at a company, make an allow rule for that tool and pin only what they named. When they want work to start on its own when a check changes, make a start rule. Its card always shows, in every mode, and nothing changes until they apply it. Rules never cover merges, deploys, commands outside the sandbox, or setup changes, so don't offer one for those.";

const EVENT_LABEL = {
  down: "It goes down",
  up: "It comes back up",
  met: "Its reply arrives",
  missed: "Its deadline passes",
} as const;

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A node type as its tool's name, as the app tools name them: dots become underscores. */
const toolName = (type: string) => type.replace(/\./g, "_");

/** A flagged node that sends, by its tool name or its type. */
function sendingNode(ctx: AppContext, name: string) {
  const want = name.trim();
  for (const spec of ctx.registry.specs()) {
    if (!spec.assistant?.sends || spec.trigger || !spec.connector) continue;
    if (spec.type === want || toolName(spec.type) === want) return ctx.registry.latest(spec.type);
  }
  return undefined;
}

function sendingTools(ctx: AppContext): string[] {
  const names = new Set<string>();
  for (const spec of ctx.registry.specs()) {
    if (spec.assistant?.sends && !spec.trigger && spec.connector) names.add(toolName(spec.type));
  }
  return [...names].sort();
}

/** A repo the user named, as a rule pins it: `host/owner/name`. */
async function repoKey(ctx: AppContext, workspaceId: string, input: string): Promise<string> {
  const key = keyFromInput(input);
  if (key) return key;
  const want = input
    .trim()
    .replace(/\.git$/i, "")
    .toLowerCase();
  const [machine, sandbox] = await Promise.all([
    ctx.db
      .select({ name: schema.repos.name, key: schema.repos.remoteKey })
      .from(schema.repos)
      .where(and(eq(schema.repos.workspaceId, workspaceId), isNull(schema.repos.removedAt))),
    ctx.db
      .select({ key: schema.sandboxRepos.remoteKey })
      .from(schema.sandboxRepos)
      .where(eq(schema.sandboxRepos.workspaceId, workspaceId)),
  ]);
  const keys = new Set<string>();
  for (const r of [...machine, ...sandbox]) {
    if (!r.key) continue;
    const name = "name" in r ? r.name.toLowerCase() : "";
    if (r.key === want || r.key.endsWith(`/${want}`) || name === want) keys.add(r.key);
  }
  if (keys.size === 1) return [...keys][0] as string;
  throw new RuleInputError(
    keys.size > 1
      ? `${input} could be ${[...keys].join(" or ")}. Pass the full repo, as host/owner/name.`
      : `No repo ${input}. Pass it as host/owner/name, such as github.com/acme/site.`,
  );
}

const SaveRuleInput = z.object({
  kind: z
    .enum(["allow", "start"])
    .describe("allow: skip the question for an action. start: open a chat when a check changes."),
  action: z
    .string()
    .max(200)
    .optional()
    .describe(
      "allow: the tool the rule covers, by name: one of your app tools that sends, such as email_send or calendar_create_event, run_workflow, or a task's push or open_pr.",
    ),
  account: z
    .string()
    .max(200)
    .optional()
    .describe("allow: one account, by name, when the user means only that one. Left out, any."),
  match: z
    .record(z.string().max(100), z.string().max(500))
    .optional()
    .describe(
      'allow: the arguments the rule pins, such as {"to": "*@acme.com"} or {"calendar": "Work"}. A value matches exactly, or as a suffix after a leading *. Arguments left out are free. run_workflow pins {"workflow": its name}, and push and open_pr pin {"repo": "owner/name"}.',
    ),
  check: z
    .string()
    .max(200)
    .optional()
    .describe("start: the check, by name. Left out, every check."),
  on: z
    .enum(START_RULE_EVENTS)
    .optional()
    .describe("start: down or up for a site or command check, met or missed for a reply check."),
  personality: z
    .string()
    .max(200)
    .optional()
    .describe("start: who answers in the chat, by name. Left out, the default personality."),
  message: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "start: the chat's first message. {check} becomes the check's name and {results} what its last run saw, which the chat also gets in full. Left out, it asks to find out why.",
    ),
  mode: z
    .enum(START_RULE_MODES)
    .optional()
    .describe("start: the chat's mode. Left out, the workspace's default, at most Auto."),
});

type SaveRuleArgs = z.infer<typeof SaveRuleInput>;

/** The rule the model described, with names turned into IDs, and the card's rows. */
async function resolve(
  ctx: AppContext,
  scope: ToolScope,
  input: SaveRuleArgs,
): Promise<{ rule: RuleInput; rows: SetupChangeRow[] }> {
  if (input.kind === "allow") {
    const raw = input.action?.trim() ?? "";
    if (!raw) throw new RuleInputError("Pass action, the tool the rule covers.");
    const node =
      raw === "run_workflow" || raw === "push" || raw === "open_pr"
        ? undefined
        : sendingNode(ctx, raw);
    const action = node?.type ?? raw;
    if (!node && action !== "run_workflow" && action !== "push" && action !== "open_pr") {
      throw new RuleInputError(
        `${raw} can't have an allow rule. Rules cover ${[...sendingTools(ctx), "run_workflow", "push", "open_pr"].join(", ")}, never merges, deploys, commands, or setup changes.`,
      );
    }
    const rows: SetupChangeRow[] = [];
    let installationId: string | null = null;
    if (input.account?.trim()) {
      if (!node?.connector) throw new RuleInputError(`${raw} doesn't use an account.`);
      const accounts = await ctx.db
        .select({
          id: schema.connectorInstallations.id,
          name: schema.connectorInstallations.name,
        })
        .from(schema.connectorInstallations)
        .where(
          and(
            eq(schema.connectorInstallations.workspaceId, scope.workspaceId),
            eq(schema.connectorInstallations.connectorId, node.connector),
          ),
        )
        .orderBy(asc(schema.connectorInstallations.createdAt));
      const want = input.account.trim();
      const picked = accounts.find((a) => a.id === want || sameName(a.name, want));
      if (!picked) {
        throw new RuleInputError(
          `No account called ${want} for ${raw}. Accounts: ${accounts.map((a) => a.name).join(", ") || "none"}.`,
        );
      }
      installationId = picked.id;
      rows.push(row("Account", picked.name));
    }
    const match: Record<string, string> = {};
    for (const [field, value] of Object.entries(input.match ?? {})) {
      if (action === "run_workflow" && field === "workflow") {
        const [wf] = await ctx.db
          .select({ id: schema.workflows.id, name: schema.workflows.name })
          .from(schema.workflows)
          .where(eq(schema.workflows.workspaceId, scope.workspaceId))
          .then((list) => list.filter((w) => w.id === value.trim() || sameName(w.name, value)));
        if (!wf) throw new RuleInputError(`No workflow called ${value}.`);
        match.workflow = wf.id;
        rows.push(row("Workflow", wf.name));
      } else if ((action === "push" || action === "open_pr") && field === "repo") {
        match.repo = await repoKey(ctx, scope.workspaceId, value);
        rows.push(row("Repo", match.repo));
      } else {
        match[field] = value;
        rows.push(row(field, value === "" ? "Left out" : value));
      }
    }
    return {
      rule: {
        kind: "allow",
        action,
        installationId,
        match,
        conversationId: scope.conversationId,
      },
      rows,
    };
  }

  const on = input.on ?? "down";
  const rows: SetupChangeRow[] = [];
  let checkId: string | null = null;
  if (input.check?.trim()) {
    const checks = await ctx.db
      .select({ id: schema.checks.id, name: schema.checks.name })
      .from(schema.checks)
      .where(eq(schema.checks.workspaceId, scope.workspaceId))
      .orderBy(asc(schema.checks.name));
    const want = input.check.trim();
    const picked = checks.find((c) => c.id === want || sameName(c.name, want));
    if (!picked) {
      throw new RuleInputError(
        `No check called ${want}. Checks: ${checks.map((c) => c.name).join(", ") || "none yet"}.`,
      );
    }
    checkId = picked.id;
    rows.push(row("Check", picked.name));
  } else {
    rows.push(row("Check", "Every check"));
  }
  rows.push(row("When", EVENT_LABEL[on]));
  let personalityId: string | null = null;
  if (input.personality?.trim()) {
    const list = await ctx.db
      .select({ id: schema.personalities.id, name: schema.personalities.name })
      .from(schema.personalities)
      .where(
        and(
          eq(schema.personalities.workspaceId, scope.workspaceId),
          isNull(schema.personalities.archivedAt),
        ),
      );
    const want = input.personality.trim();
    const picked = list.find((p) => p.id === want || sameName(p.name, want));
    if (!picked) {
      throw new RuleInputError(
        `No personality called ${want}. Personalities: ${list.map((p) => p.name).join(", ")}.`,
      );
    }
    personalityId = picked.id;
    rows.push(row("Who answers", picked.name));
  }
  const mode = input.mode ?? (await defaultStartMode(ctx, scope.workspaceId));
  rows.push(row("Mode", MODE_POLICY[mode].label));
  const message = input.message?.trim() || defaultStartMessage(on);
  rows.push(row("First message", message));
  return {
    rule: {
      kind: "start",
      checkId,
      on,
      personalityId,
      message,
      mode,
      conversationId: scope.conversationId,
    },
    rows,
  };
}

/** The workspace's default mode, at most Auto. */
async function defaultStartMode(ctx: AppContext, workspaceId: string): Promise<StartRuleMode> {
  const [ws] = await ctx.db
    .select({ mode: schema.workspaces.defaultMode })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  const mode: PermissionMode = ws?.mode ?? "auto";
  return modeWithinCap(mode, "auto") ? (mode as StartRuleMode) : "auto";
}

export function saveRuleTool(ctx: AppContext, scope: ToolScope): Tool {
  return tool({
    description:
      'Save a standing answer the user asked for. An allow rule lets a send from chat, a workflow run, or a task\'s push or pull request go without asking in Supervised and Auto, such as "stop asking before adding calendar events". A start rule opens a chat and runs its first turn when a check changes, such as "when Website goes down, have Incident look into it". The user always sees a card first, in every mode, and nothing is saved until they apply it.',
    inputSchema: SaveRuleInput,
    execute: async (input, options: CallOptions) => {
      let resolved: Awaited<ReturnType<typeof resolve>>;
      let summary: string;
      try {
        resolved = await resolve(ctx, scope, input);
        summary = await ctx.rules.describe(scope.workspaceId, resolved.rule);
      } catch (err) {
        if (err instanceof RuleInputError) return { error: err.message };
        throw err;
      }
      return propose(ctx, scope, options, {
        tool: "save_rule",
        subjectType: "rule",
        subjectId: "",
        always: true,
        change: {
          title: resolved.rule.kind === "allow" ? "Always allow this?" : "Start work on its own?",
          doing: "Saving the rule",
          done: "Saved the rule",
          rows: [row("Rule", summary), ...resolved.rows],
          secrets: [],
        },
        apply: async () => {
          try {
            const rule = await ctx.rules.create(
              { workspaceId: scope.workspaceId, userId: scope.ownerId, email: "" },
              resolved.rule,
            );
            return {
              ok: true,
              subjectId: rule.id,
              result: {
                rule: { id: rule.id, summary: rule.summary },
                link: new URL("/approvals?tab=rules", ctx.config.publicUrl).toString(),
              },
            };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      });
    },
  });
}
