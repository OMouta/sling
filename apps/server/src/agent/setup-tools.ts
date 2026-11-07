/**
 * The assistant's tools for changing Sling's own setup: deploy targets,
 * connector accounts, workflows, personalities, and workspace settings.
 * Each one checks what it can first, then proposes the change through
 * `propose`, which shows it in the chat and applies it as the mode allows.
 * They call the same functions the routes do, with the same checks.
 */
import {
  cloneUrlFor,
  DEPLOY_METHODS,
  type DeployCheck,
  type DeployTargetView,
  GLYPH_SHAPES,
  type InstallationView,
  MERGE_METHODS,
  MODE_POLICY,
  PERMISSION_MODES,
  PERSONALITY_COLORS,
  PERSONALITY_TOOL_INFO,
  PERSONALITY_TOOLS,
  type PersonalityTool,
  type SetupChangeRow,
  type SetupSecretField,
} from "@sling/core";
import { schema } from "@sling/db";
import { validate, type WorkflowDefinition, WorkflowDefinitionSchema } from "@sling/workflow";
import { type Tool, tool } from "ai";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { TargetInput, TargetPatch } from "../deploys/service.ts";
import type { Actor } from "../http/session.ts";
import {
  createPersonality,
  listPersonalities,
  PersonalityFields,
  PersonalityPatch,
  type PersonalityRow,
  toPersonalityView,
  updatePersonality,
} from "../personalities/service.ts";
import { keyFromInput } from "../routing/router.ts";
import {
  allowLocalCloneUrls,
  allowSandboxRepo,
  checkCloneUrl,
  removeSandboxRepo,
  SandboxRepoInput,
  SandboxSettingsPatch,
  updateSandboxSettings,
} from "../sandboxes/manage.ts";
import { resolveSettings } from "../sandboxes/settings.ts";
import {
  NotificationsPatch,
  notificationsOf,
  setChatDefaults,
  setDefaultMode,
  setNotifications,
  setTimeZone,
} from "../settings.ts";
import { isTimeZone, workspaceTimeZone } from "../timezone.ts";
import { runnerViews } from "../views.ts";
import {
  connectorLog,
  createInstallation,
  freeInstallationName,
  InstallationError,
  issuesOf,
  testConnection,
  updateInstallation,
} from "../workflows/connectors/manage.ts";
import { runSetup } from "../workflows/connectors/setup.ts";
import { toJsonSchema } from "../workflows/registry.ts";
import type { InstallationRow, WorkflowRow } from "../workflows/views.ts";
import { modelCatalog } from "./catalog.ts";
import { AssistantChoiceSchema, chatDefaults } from "./chat-settings.ts";
import {
  type Applied,
  type CallOptions,
  diff,
  errorText,
  fieldsOf,
  propose,
  redactSecrets,
  row,
  secretField,
  withoutSecrets,
} from "./setup-change.ts";
import { connectorFields, currentDefinition, readSetupTool } from "./setup-read.ts";
import type { ToolScope } from "./tools.ts";

/** The setup tools, by name. Their group is `setup`. */
export const SETUP_TOOLS = [
  "read_setup",
  "save_deploy_target",
  "save_app_account",
  "add_workflow",
  "change_workflow",
  "save_personality",
  "change_settings",
] as const;

const ASKS =
  " Call it as soon as you know what to change: Sling shows the user the exact change to apply or cancel, unless the conversation's mode applies it at once.";

function actorOf(scope: ToolScope): Actor {
  return { workspaceId: scope.workspaceId, userId: scope.ownerId, email: "" };
}

function failed(err: unknown): Applied {
  return { ok: false, error: errorText(err) };
}

function zodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "value"}: ${i.message}`)
    .join("; ");
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// ------------------------------------------------------------- deploy targets

const METHOD_LABEL = { merge: "On merge", command: "Command", hook: "Deploy hook" } as const;
const MERGE_LABEL = { squash: "Squash", merge: "Merge commit", rebase: "Rebase" } as const;

function checkText(c: { url: string; status?: number | null; contains?: string | null }): string {
  const status = c.status ? `answers ${c.status}` : "answers 200–399";
  return `${c.url}, ${status}${c.contains ? `, contains “${c.contains}”` : ""}`;
}

function checkRows(before: DeployCheck[] | null, after: DeployCheck[] | undefined) {
  if (!after) return [];
  const out: SetupChangeRow[] = [];
  const n = Math.max(before?.length ?? 0, after.length);
  for (let i = 0; i < n; i++) {
    const label = n === 1 ? "Health check" : `Health check ${i + 1}`;
    const b = before?.[i];
    const a = after[i];
    if (!before) {
      if (a) out.push(row(label, checkText(a)));
      continue;
    }
    out.push(...diff(label, b ? checkText(b) : null, a ? checkText(a) : "Removed"));
  }
  return out;
}

const CheckSchema = z.object({
  url: z.string().min(1).max(2000),
  status: z.number().int().min(100).max(599).nullable().optional(),
  contains: z.string().max(500).nullable().optional(),
});

function saveDeployTarget(ctx: AppContext, scope: ToolScope): Tool {
  return tool({
    description: `Add a deploy target, or change one. A target is a repo Sling knows how to deploy and check: how it deploys, and the health checks that say the site works. A deploy hook's URL and a header's value are secrets: the user types them on the card, so never ask for them in the chat.${ASKS}`,
    inputSchema: z.object({
      target: z
        .string()
        .max(200)
        .optional()
        .describe("An existing target's name or id, to change it. Leave it out to add one."),
      name: z.string().trim().min(1).max(80).optional().describe("Such as Website or API."),
      repo: z
        .string()
        .max(300)
        .optional()
        .describe("The repo's remote, such as github.com/owner/site, from read_setup."),
      method: z
        .enum(DEPLOY_METHODS)
        .optional()
        .describe(
          "merge: the host deploys when the default branch changes (Vercel, Netlify, Railway, Render, Fly, Cloudflare Pages). command: the deploy command set on one of the user's machines runs. hook: Sling calls the host's deploy hook.",
        ),
      machine: z
        .string()
        .max(200)
        .optional()
        .describe(
          "With command: the machine's name or id. Left out, the one machine with a deploy command for the repo.",
        ),
      mergeMethod: z.enum(MERGE_METHODS).optional(),
      hookMethod: z.enum(["POST", "GET"]).optional(),
      hookHeader: z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe(
          "With hook: a header to send, such as Authorization. Its value is typed on the card. null drops it.",
        ),
      newHookUrl: z
        .boolean()
        .optional()
        .describe("Changing a hook target: true when the user has a new hook URL."),
      checks: z.array(CheckSchema).min(1).max(5).optional(),
      versionUrl: z.string().max(2000).nullable().optional(),
      settleSeconds: z.number().int().min(0).optional(),
      timeoutSeconds: z.number().int().optional(),
    }),
    execute: async (input, options: CallOptions) => {
      const runners = await runnerViews(ctx, scope.workspaceId);
      const machineOf = (want: string | undefined, remote: string | null) => {
        if (want) {
          const w = want.trim().toLowerCase();
          const r = runners.find((x) => x.id === want.trim() || x.name.toLowerCase() === w);
          return r
            ? { runner: r }
            : {
                error: `No machine called ${want}. Machines: ${runners.map((x) => x.name).join(", ") || "none"}.`,
              };
        }
        const withCommand = runners.filter((r) =>
          r.repos.some((p) => p.remoteKey === remote && p.deployCommand.trim()),
        );
        const [only] = withCommand;
        if (withCommand.length === 1 && only) return { runner: only };
        return {
          error:
            withCommand.length === 0
              ? `No machine has a deploy command for ${remote}. The user sets one there with sling-runner repo set <repo> deploy-command "…".`
              : `Pass machine: ${withCommand.map((r) => r.name).join(", ")} can deploy it.`,
        };
      };
      const commandOn = (runnerId: string | null, remote: string) =>
        runners
          .find((r) => r.id === runnerId)
          ?.repos.find((p) => p.remoteKey === remote)
          ?.deployCommand.trim() ?? "";

      if (!input.target) {
        // ------------------------------------------------ a new target
        if (!input.name || !input.repo || !input.method || !input.checks) {
          return { error: "A new target needs name, repo, method, and checks." };
        }
        let runnerId: string | null = null;
        let machineName = "";
        if (input.method === "command") {
          const m = machineOf(input.machine, keyFromInput(input.repo));
          if ("error" in m) return { error: m.error };
          runnerId = m.runner.id;
          machineName = m.runner.name;
        }
        const fields = {
          name: input.name,
          remoteKey: input.repo,
          method: input.method,
          ...(input.mergeMethod ? { mergeMethod: input.mergeMethod } : {}),
          runnerId,
          checks: input.checks,
          ...(input.versionUrl !== undefined ? { versionUrl: input.versionUrl } : {}),
          ...(input.settleSeconds !== undefined ? { settleSeconds: input.settleSeconds } : {}),
          ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
        };
        const parsed = TargetInput.safeParse(fields);
        if (!parsed.success) return { error: zodIssues(parsed.error) };
        let remote: string;
        try {
          remote = await ctx.deploys.precheck(scope.workspaceId, parsed.data);
        } catch (err) {
          return { error: errorText(err) };
        }
        const header = input.hookHeader?.trim() || null;
        const secrets: SetupSecretField[] =
          input.method === "hook"
            ? [
                secretField("hookUrl", "Deploy hook URL", true, { placeholder: "https://…" }),
                ...(header ? [secretField("hookHeaderValue", `${header} header`, true)] : []),
              ]
            : [];
        const command = input.method === "command" ? commandOn(runnerId, remote) : "";
        const rows: SetupChangeRow[] = [
          row("Name", input.name),
          row("Repo", remote),
          row("Deploys", METHOD_LABEL[input.method]),
          ...(input.method === "command"
            ? [row("Machine", machineName), row("Command", command || "Not set there yet")]
            : []),
          ...(input.method === "hook"
            ? [row("Hook", `${input.hookMethod ?? "POST"}${header ? `, with ${header}` : ""}`)]
            : []),
          row("Merge with", MERGE_LABEL[parsed.data.mergeMethod ?? "squash"]),
          ...checkRows(
            null,
            parsed.data.checks.map((c) => ({
              url: c.url,
              status: c.status ?? null,
              contains: c.contains ?? null,
            })),
          ),
          ...(parsed.data.versionUrl ? [row("Version URL", parsed.data.versionUrl)] : []),
          ...(input.settleSeconds !== undefined
            ? [row("Waits before checking", `${input.settleSeconds}s`)]
            : []),
          ...(input.timeoutSeconds !== undefined
            ? [row("Gives up after", `${input.timeoutSeconds}s`)]
            : []),
        ];
        return propose(ctx, scope, options, {
          tool: "save_deploy_target",
          subjectType: "deploy_target",
          subjectId: "",
          change: {
            title: `Add deploy target ${input.name}?`,
            doing: `Adding ${input.name}`,
            done: `Added ${input.name}`,
            rows,
            secrets,
          },
          apply: async (typed) => {
            const body = {
              ...parsed.data,
              ...(input.method === "hook"
                ? {
                    hook: {
                      url: typed.hookUrl,
                      httpMethod: input.hookMethod ?? "POST",
                      ...(header ? { headerName: header, headerValue: typed.hookHeaderValue } : {}),
                    },
                  }
                : {}),
            };
            const checked = TargetInput.safeParse(body);
            if (!checked.success) return { ok: false, error: zodIssues(checked.error) };
            try {
              const view = await ctx.deploys.create(actorOf(scope), checked.data);
              return { ok: true, subjectId: view.id, result: { target: targetSummary(view) } };
            } catch (err) {
              return failed(err);
            }
          },
        });
      }

      // -------------------------------------------------- changing a target
      const target = await ctx.deploys.find(scope.workspaceId, input.target);
      if (!target) {
        const names = (await ctx.deploys.rows(scope.workspaceId)).map((r) => r.name);
        return {
          error: `No deploy target called ${input.target}. Targets: ${names.join(", ") || "none"}.`,
        };
      }
      const before = await ctx.deploys.view(scope.workspaceId, target.id);
      if (!before) return { error: "That target went away." };
      const method = input.method ?? target.method;
      let runnerId = method === "command" ? target.runnerId : null;
      let machineName = method === "command" ? (before.runnerName ?? "") : "";
      if (method === "command" && (input.machine || target.method !== "command")) {
        const m = machineOf(input.machine, keyFromInput(input.repo ?? target.remoteKey));
        if ("error" in m) return { error: m.error };
        runnerId = m.runner.id;
        machineName = m.runner.name;
      }
      const patch: z.infer<typeof TargetPatch> = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.repo !== undefined ? { remoteKey: input.repo } : {}),
        ...(input.method !== undefined ? { method: input.method } : {}),
        ...(input.mergeMethod !== undefined ? { mergeMethod: input.mergeMethod } : {}),
        ...(method === "command" && runnerId !== target.runnerId ? { runnerId } : {}),
        ...(input.checks !== undefined ? { checks: input.checks } : {}),
        ...(input.versionUrl !== undefined ? { versionUrl: input.versionUrl } : {}),
        ...(input.settleSeconds !== undefined ? { settleSeconds: input.settleSeconds } : {}),
        ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
      };
      const parsed = TargetPatch.safeParse(patch);
      if (!parsed.success) return { error: zodIssues(parsed.error) };
      const name = parsed.data.name ?? target.name;
      let remote = target.remoteKey;
      try {
        remote = await ctx.deploys.precheck(
          scope.workspaceId,
          { name, remoteKey: parsed.data.remoteKey ?? target.remoteKey, method, runnerId },
          target.id,
        );
      } catch (err) {
        return { error: errorText(err) };
      }
      const hadHook = target.method === "hook" && Boolean(target.hookCredentialId);
      const header = input.hookHeader === undefined ? undefined : input.hookHeader?.trim() || null;
      const needsUrl = method === "hook" && (!hadHook || input.newHookUrl === true);
      const secrets: SetupSecretField[] = [
        ...(needsUrl
          ? [secretField("hookUrl", "Deploy hook URL", true, { placeholder: "https://…" })]
          : []),
        ...(method === "hook" && header
          ? [secretField("hookHeaderValue", `${header} header`, true)]
          : []),
      ];
      const hookBefore = before.hook
        ? hookLine(
            before.hook.httpMethod,
            before.hook.host,
            before.hook.hasHeader ? "a header" : null,
          )
        : null;
      const hookAfter =
        method === "hook"
          ? hookLine(
              input.hookMethod ?? before.hook?.httpMethod ?? "POST",
              needsUrl ? null : (before.hook?.host ?? null),
              header === undefined ? (before.hook?.hasHeader ? "a header" : null) : header,
            )
          : null;
      const rows: SetupChangeRow[] = [
        ...diff("Name", target.name, name),
        ...diff("Repo", target.remoteKey, remote),
        ...diff("Deploys", METHOD_LABEL[target.method], METHOD_LABEL[method]),
        ...(method === "command" ? diff("Machine", before.runnerName, machineName) : []),
        ...diff("Hook", hookBefore, hookAfter),
        ...(parsed.data.mergeMethod
          ? diff(
              "Merge with",
              MERGE_LABEL[target.mergeMethod],
              MERGE_LABEL[parsed.data.mergeMethod],
            )
          : []),
        ...checkRows(
          target.checks,
          parsed.data.checks?.map((c) => ({
            url: c.url,
            status: c.status ?? null,
            contains: c.contains ?? null,
          })),
        ),
        ...(parsed.data.versionUrl !== undefined
          ? diff("Version URL", target.versionUrl, parsed.data.versionUrl)
          : []),
        ...(parsed.data.settleSeconds !== undefined
          ? diff(
              "Waits before checking",
              `${target.settleSeconds}s`,
              `${parsed.data.settleSeconds}s`,
            )
          : []),
        ...(parsed.data.timeoutSeconds !== undefined
          ? diff("Gives up after", `${target.timeoutSeconds}s`, `${parsed.data.timeoutSeconds}s`)
          : []),
      ];
      if (rows.length === 0 && secrets.length === 0) {
        return { error: `Nothing to change: ${target.name} already looks like that.` };
      }
      return propose(ctx, scope, options, {
        tool: "save_deploy_target",
        subjectType: "deploy_target",
        subjectId: target.id,
        change: {
          title: `Change deploy target ${target.name}?`,
          doing: `Changing ${target.name}`,
          done: `Changed ${name}`,
          rows,
          secrets,
        },
        apply: async (typed) => {
          const hook =
            method === "hook" && (typed.hookUrl || header !== undefined || input.hookMethod)
              ? {
                  ...(typed.hookUrl ? { url: typed.hookUrl } : {}),
                  ...(input.hookMethod ? { httpMethod: input.hookMethod } : {}),
                  ...(header !== undefined ? { headerName: header } : {}),
                  ...(typed.hookHeaderValue ? { headerValue: typed.hookHeaderValue } : {}),
                }
              : undefined;
          const checked = TargetPatch.safeParse({ ...parsed.data, ...(hook ? { hook } : {}) });
          if (!checked.success) return { ok: false, error: zodIssues(checked.error) };
          try {
            const view = await ctx.deploys.update(actorOf(scope), target.id, checked.data);
            return { ok: true, subjectId: view.id, result: { target: targetSummary(view) } };
          } catch (err) {
            return failed(err);
          }
        },
      });
    },
  });
}

/** "POST to api.render.com, with Authorization". No host means the URL typed on the card. */
function hookLine(method: string, host: string | null, header: string | null): string {
  return `${method} to ${host ?? "the new URL"}${header ? `, with ${header}` : ""}`;
}

function targetSummary(t: DeployTargetView) {
  return {
    id: t.id,
    name: t.name,
    repo: t.remoteKey,
    method: t.method,
    ...(t.runnerName ? { machine: t.runnerName } : {}),
    ...(t.hook ? { hook: { method: t.hook.httpMethod, host: t.hook.host } } : {}),
    checks: t.checks.map((c) => c.url),
  };
}

// ------------------------------------------------------------- app accounts

async function findInstallation(
  ctx: AppContext,
  workspaceId: string,
  want: string,
): Promise<InstallationRow | { error: string }> {
  const rows = await ctx.db
    .select()
    .from(schema.connectorInstallations)
    .where(eq(schema.connectorInstallations.workspaceId, workspaceId))
    .orderBy(asc(schema.connectorInstallations.createdAt));
  const found = rows.find((r) => r.id === want.trim()) ?? rows.find((r) => sameName(r.name, want));
  return (
    found ?? {
      error: `No account called ${want}. Accounts: ${rows.map((r) => r.name).join(", ") || "none yet"}.`,
    }
  );
}

function accountSummary(i: InstallationView) {
  return { id: i.id, name: i.name, connector: i.connectorId, enabled: i.enabled };
}

function saveAppAccount(ctx: AppContext, scope: ToolScope): Tool {
  return tool({
    description: `Connect an app account to Sling, such as a mailbox, a calendar, or a Discord bot, or change one. For a new account, pass the connector and what isn't secret, such as the email address: Sling looks up the rest it can, such as the mail servers, then runs a connection test. Passwords, app passwords, and tokens are typed by the user on the card. Never ask for them in the chat or pass them here.${ASKS}`,
    inputSchema: z.object({
      account: z
        .string()
        .max(200)
        .optional()
        .describe(
          "An existing account's name or id, to change it. Leave it out to connect a new one.",
        ),
      connector: z
        .string()
        .max(100)
        .optional()
        .describe(
          "For a new account: the connector's id from read_setup, such as email or calendar.",
        ),
      name: z.string().trim().min(1).max(120).optional(),
      credentials: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Fields that aren't secret, by key, such as fromAddress. Never a password or token.",
        ),
      config: z.record(z.string(), z.unknown()).optional().describe("Settings, by key."),
      enabled: z.boolean().optional(),
      newSecrets: z
        .boolean()
        .optional()
        .describe(
          "Changing an account: true when the user has a new password or token to type in.",
        ),
    }),
    execute: async (input, options: CallOptions) => {
      if (input.account) return changeAccount(ctx, scope, input.account, input, options);
      if (!input.connector)
        return { error: "Pass connector for a new account, or account to change one." };
      const connector = ctx.registry.connector(input.connector);
      if (!connector) {
        return {
          error: `No connector ${input.connector}. Connectors: ${ctx.registry
            .connectors()
            .map((c) => c.id)
            .join(", ")}.`,
        };
      }
      const fields = connectorFields(ctx, connector);
      const secretKeys = fields.credentials.filter((f) => f.secret).map((f) => f.key);
      const typed = withoutSecrets(input.credentials, secretKeys);
      if (typed.dropped.length > 0) {
        // A secret the model passed is never used, and doesn't stay in the chat's record.
        scope.trace?.toolUpdate(options.toolCallId, {
          input: { ...input, credentials: typed.kept },
        });
      }
      const typedConfig = input.config ?? {};
      const lookup = await runSetup(connector, {
        credentials: typed.kept,
        config: typedConfig,
        log: connectorLog(ctx, connector.id),
      });
      const found = withoutSecrets(
        lookup.credentials as Record<string, unknown> | undefined,
        secretKeys,
      ).kept;
      const credentials = { ...found, ...typed.kept };
      const config = { ...(lookup.config ?? {}), ...typedConfig };
      const notes = lookup.notes ?? [];
      const problem = notes.find((n) => n.tone === "error");
      if (problem) return { error: problem.text };
      // Everything but the secrets has to be right before the card asks for them.
      const creds = connector.credentialsSchema.safeParse(credentials);
      const missing = creds.success
        ? []
        : creds.error.issues.filter((i) => !secretKeys.includes(String(i.path[0])));
      if (missing.length > 0) {
        const titles = [
          ...new Set(
            missing.map(
              (i) =>
                fields.credentials.find((f) => f.key === i.path[0])?.title ?? String(i.path[0]),
            ),
          ),
        ];
        const warn = notes.filter((n) => n.tone === "warn").map((n) => n.text);
        return {
          error: `${[...warn, `Needs ${titles.join(", ")}.`].join(" ")} Ask the user for ${titles.length === 1 ? "it" : "them"}.`,
        };
      }
      const conf = connector.configSchema.safeParse(config);
      if (!conf.success) return { error: `Config: ${zodIssues(conf.error)}` };
      const name =
        input.name ??
        lookup.name ??
        (await freeInstallationName(ctx, scope.workspaceId, connector.name));
      const secrets = fields.credentials
        .filter((f) => f.secret)
        .map((f) => {
          const note = notes.find((n) => n.field === f.key);
          return secretField(f.key, f.title, f.required, {
            ...(note
              ? { placeholder: note.text }
              : f.placeholder
                ? { placeholder: f.placeholder }
                : {}),
            ...(note?.link ? { link: note.link } : {}),
          });
        });
      const rows: SetupChangeRow[] = [row("App", connector.name), row("Name", name)];
      for (const f of fields.credentials) {
        if (f.secret || f.hidden) continue;
        const v = credentials[f.key];
        if (v !== undefined && v !== "") rows.push(row(f.title, v));
      }
      // As it will be saved, defaults filled in.
      const saved = conf.data as Record<string, unknown>;
      for (const f of fields.config) {
        if (f.hidden) continue;
        const v = saved[f.key];
        if (v !== undefined) rows.push(row(f.title, v));
      }
      if (input.enabled === false) rows.push(row("On", false));
      const foundText = notes
        .filter((n) => n.tone === "ok" && n.field !== undefined && !secretKeys.includes(n.field))
        .map((n) => n.text);
      return propose(ctx, scope, options, {
        tool: "save_app_account",
        subjectType: "installation",
        subjectId: "",
        change: {
          title: `Connect ${name}?`,
          doing: `Connecting ${name}`,
          done: `Connected ${name}`,
          rows,
          secrets,
        },
        apply: async (typedSecrets) => {
          const full = connector.credentialsSchema.safeParse({ ...credentials, ...typedSecrets });
          if (!full.success) return { ok: false, error: `Credentials: ${issuesOf(full.error)}` };
          const test = await testConnection(ctx, connector, full.data, conf.data);
          if (!test.ok) {
            return {
              ok: false,
              error: `The connection test failed: ${redactSecrets(test.error, typedSecrets)}`,
            };
          }
          try {
            const view = await createInstallation(ctx, actorOf(scope), {
              connectorId: connector.id,
              name,
              credentials: full.data as Record<string, unknown>,
              config: conf.data as Record<string, unknown>,
              enabled: input.enabled ?? true,
              check: false,
            });
            return {
              ok: true,
              subjectId: view.id,
              result: {
                account: accountSummary(view),
                ...(test.detail ? { test: redactSecrets(test.detail, typedSecrets) } : {}),
                ...(foundText.length ? { found: foundText } : {}),
              },
            };
          } catch (err) {
            return failed(err);
          }
        },
      });
    },
  });
}

async function changeAccount(
  ctx: AppContext,
  scope: ToolScope,
  want: string,
  input: {
    name?: string | undefined;
    credentials?: Record<string, unknown> | undefined;
    config?: Record<string, unknown> | undefined;
    enabled?: boolean | undefined;
    newSecrets?: boolean | undefined;
  },
  options: CallOptions,
) {
  const found = await findInstallation(ctx, scope.workspaceId, want);
  if ("error" in found) return found;
  const inst = found;
  const connector = ctx.registry.connector(inst.connectorId);
  if (!connector) return { error: `The ${inst.connectorId} connector isn't available.` };
  const fields = connectorFields(ctx, connector);
  const secretFields = fields.credentials.filter((f) => f.secret);
  const typed = withoutSecrets(
    input.credentials,
    secretFields.map((f) => f.key),
  );
  if (typed.dropped.length > 0) {
    scope.trace?.toolUpdate(options.toolCallId, {
      input: { account: want, ...input, credentials: typed.kept },
    });
  }
  const config = input.config ? { ...inst.config, ...input.config } : null;
  if (config) {
    const parsed = connector.configSchema.safeParse(config);
    if (!parsed.success) return { error: `Config: ${zodIssues(parsed.error)}` };
  }
  const name = input.name ?? inst.name;
  const rows: SetupChangeRow[] = [...diff("Name", inst.name, name)];
  for (const [k, v] of Object.entries(typed.kept)) {
    // Stored credentials are never read back, so only the new value shows.
    rows.push(row(fields.credentials.find((f) => f.key === k)?.title ?? k, v));
  }
  if (config) {
    for (const f of fields.config) rows.push(...diff(f.title, inst.config[f.key], config[f.key]));
  }
  if (input.enabled !== undefined) rows.push(...diff("On", inst.enabled, input.enabled));
  const secrets = input.newSecrets
    ? secretFields.map((f) =>
        secretField(
          f.key,
          `New ${f.title.toLowerCase()}`,
          secretFields.length === 1,
          f.placeholder ? { placeholder: f.placeholder } : {},
        ),
      )
    : [];
  if (rows.length === 0 && secrets.length === 0) {
    return { error: `Nothing to change: ${inst.name} already looks like that.` };
  }
  const onlyToggle = rows.length === 1 && input.enabled !== undefined && secrets.length === 0;
  const verb = onlyToggle ? (input.enabled ? "Turn on" : "Turn off") : "Change";
  const doing = onlyToggle ? (input.enabled ? "Turning on" : "Turning off") : "Changing";
  const done = onlyToggle ? (input.enabled ? "Turned on" : "Turned off") : "Changed";
  return propose(ctx, scope, options, {
    tool: "save_app_account",
    subjectType: "installation",
    subjectId: inst.id,
    change: {
      title: `${verb} ${inst.name}?`,
      doing: `${doing} ${inst.name}`,
      done: `${done} ${name}`,
      rows,
      secrets,
    },
    apply: async (typedSecrets) => {
      const credentials = { ...typed.kept, ...typedSecrets };
      try {
        const view = await updateInstallation(ctx, actorOf(scope), inst, {
          ...(input.name ? { name: input.name } : {}),
          ...(Object.keys(credentials).length ? { credentials } : {}),
          ...(config ? { config } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          check: true,
        });
        return { ok: true, subjectId: view.id, result: { account: accountSummary(view) } };
      } catch (err) {
        const test = err instanceof InstallationError && err.check === "failed";
        const error = redactSecrets(errorText(err), typedSecrets);
        return { ok: false, error: test ? `The connection test failed: ${error}` : error };
      }
    },
  });
}

// ------------------------------------------------------------- workflows

async function findWorkflow(
  ctx: AppContext,
  workspaceId: string,
  want: string,
): Promise<WorkflowRow | { error: string }> {
  const rows = await ctx.db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.workspaceId, workspaceId))
    .orderBy(asc(schema.workflows.name));
  const found = rows.find((r) => r.id === want.trim()) ?? rows.find((r) => sameName(r.name, want));
  return (
    found ?? {
      error: `No workflow called ${want}. Workflows: ${rows.map((r) => r.name).join(", ") || "none yet"}.`,
    }
  );
}

function workflowLink(ctx: AppContext, id: string) {
  return new URL(`/workflows/${id}`, ctx.config.publicUrl).toString();
}

function addWorkflow(ctx: AppContext, scope: ToolScope): Tool {
  return tool({
    description: `Add a workflow from one of the templates read_setup lists, with the user's accounts filled in. It's published, and on unless enabled is false.${ASKS}`,
    inputSchema: z.object({
      template: z.string().min(1).max(200).describe("The template's key or name."),
      name: z.string().trim().min(1).max(120).optional().describe("Left out, the template's name."),
      accounts: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'The account each of the template\'s account slots uses, by placeholder, such as {"$discord": "Sling bot"}. A slot with only one matching account uses it.',
        ),
      enabled: z.boolean().default(true),
    }),
    execute: async (input, options: CallOptions) => {
      const templates = ctx.workflows.availableTemplates();
      const t =
        templates.find((x) => x.key === input.template.trim()) ??
        templates.find((x) => sameName(x.name, input.template));
      if (!t) {
        return {
          error: `No template ${input.template}. Templates: ${templates.map((x) => x.name).join(", ")}.`,
        };
      }
      const accounts = await ctx.db
        .select()
        .from(schema.connectorInstallations)
        .where(eq(schema.connectorInstallations.workspaceId, scope.workspaceId))
        .orderBy(asc(schema.connectorInstallations.createdAt));
      const bindings: Record<string, string> = {};
      const rows: SetupChangeRow[] = [row("Template", t.name), row("Name", input.name ?? t.name)];
      for (const b of t.bindings) {
        const mine = accounts.filter((a) => a.connectorId === b.connectorId);
        const want = input.accounts?.[b.placeholder];
        const picked = want
          ? mine.find((a) => a.id === want.trim() || sameName(a.name, want))
          : mine.length === 1
            ? mine[0]
            : undefined;
        if (!picked) {
          return {
            error: want
              ? `No ${b.connectorId} account called ${want} for ${b.label}. ${b.connectorId} accounts: ${mine.map((a) => a.name).join(", ") || "none"}.`
              : mine.length === 0
                ? `${t.name} needs a ${b.connectorId} account for ${b.label}, and there's none yet. Connect one first with save_app_account.`
                : `Pass accounts["${b.placeholder}"] for ${b.label}: one of ${mine.map((a) => a.name).join(", ")}.`,
          };
        }
        bindings[b.placeholder] = picked.id;
        rows.push(row(b.label, picked.name));
      }
      rows.push(row("On", input.enabled));
      const name = input.name ?? t.name;
      return propose(ctx, scope, options, {
        tool: "add_workflow",
        subjectType: "workflow",
        subjectId: "",
        change: {
          title: `Add workflow ${name}?`,
          doing: `Adding ${name}`,
          done: `Added ${name}`,
          rows,
          secrets: [],
        },
        apply: async () => {
          try {
            const actor = actorOf(scope);
            let wf = await ctx.workflows.install(
              actor,
              t.key,
              bindings,
              input.name ? { name: input.name } : {},
            );
            if (input.enabled && !wf.enabled)
              wf = (await ctx.workflows.setEnabled(actor, wf, true)) ?? wf;
            if (!input.enabled && wf.enabled)
              wf = (await ctx.workflows.setEnabled(actor, wf, false)) ?? wf;
            return {
              ok: true,
              subjectId: wf.id,
              result: {
                workflow: { id: wf.id, name: wf.name, enabled: wf.enabled },
                link: workflowLink(ctx, wf.id),
              },
            };
          } catch (err) {
            return failed(err);
          }
        },
      });
    },
  });
}

function changeWorkflow(ctx: AppContext, scope: ToolScope): Tool {
  return tool({
    description: `Turn one of the user's workflows on or off, rename it, or change its steps' settings, which publishes a new version. read_setup with workflow set shows its steps and their settings.${ASKS}`,
    inputSchema: z.object({
      workflow: z.string().min(1).max(200).describe("The workflow's name or id."),
      name: z.string().trim().min(1).max(120).optional(),
      enabled: z.boolean().optional(),
      steps: z
        .array(
          z.object({
            step: z.string().min(1).max(200).describe("The step's id or label."),
            settings: z
              .record(z.string(), z.unknown())
              .describe(
                "The settings to change, by key. The rest stay. An account field takes the account's name.",
              ),
          }),
        )
        .max(20)
        .optional(),
    }),
    execute: async (input, options: CallOptions) => {
      const found = await findWorkflow(ctx, scope.workspaceId, input.workflow);
      if ("error" in found) return found;
      const wf = found;
      const rows: SetupChangeRow[] = [];
      let definition: WorkflowDefinition | null = null;
      if (input.steps?.length) {
        if (wf.draftDirty && wf.activeVersionId) {
          return {
            error: `${wf.name} has unpublished changes in the editor. The user publishes or discards them there first.`,
          };
        }
        const base = await currentDefinition(ctx, wf);
        const accounts = await ctx.db
          .select()
          .from(schema.connectorInstallations)
          .where(eq(schema.connectorInstallations.workspaceId, scope.workspaceId));
        const nodes = base.nodes.map((n) => ({ ...n, config: { ...n.config } }));
        for (const change of input.steps) {
          const node =
            nodes.find((n) => n.id === change.step.trim()) ??
            nodes.find((n) => n.label !== undefined && sameName(n.label, change.step));
          if (!node) {
            return {
              error: `No step ${change.step} in ${wf.name}. Steps: ${nodes.map((n) => `${n.label ?? n.type} (${n.id})`).join(", ")}.`,
            };
          }
          const spec = ctx.registry.get(node.type, node.version);
          if (!spec) return { error: `This server doesn't have the ${node.type} step anymore.` };
          const fields = fieldsOf(toJsonSchema(spec.configSchema), []);
          const installationFields = new Set(spec.installationFields ?? []);
          const label = node.label ?? spec.title;
          for (const [key, value] of Object.entries(change.settings)) {
            const field = fields.find((f) => f.key === key);
            if (!field) {
              return {
                error: `${label} has no setting ${key}. Its settings: ${fields.map((f) => f.key).join(", ")}.`,
              };
            }
            let next = value;
            let display = value;
            if (installationFields.has(key)) {
              const want = String(value);
              const acc = accounts.find(
                (a) =>
                  a.connectorId === spec.connector && (a.id === want || sameName(a.name, want)),
              );
              if (!acc) return { error: `No ${spec.connector} account called ${want}.` };
              next = acc.id;
              display = acc.name;
            }
            const was = node.config[key];
            const wasShown = installationFields.has(key)
              ? (accounts.find((a) => a.id === was)?.name ?? was)
              : was;
            node.config[key] = next;
            rows.push(...diff(`${label}: ${field.title}`, wasShown, display));
          }
          const parsed = spec.configSchema.safeParse(node.config);
          if (!parsed.success) return { error: `${label}: ${zodIssues(parsed.error)}` };
        }
        definition = { ...base, nodes, ...(input.name ? { name: input.name } : {}) };
        const issues = validate(definition, ctx.registry);
        if (issues.length > 0)
          return { error: `That wouldn't publish: ${issues.map((i) => i.message).join("; ")}` };
      }
      const name = input.name ?? wf.name;
      rows.unshift(...diff("Name", wf.name, name));
      if (input.enabled !== undefined) {
        if (input.enabled && !wf.activeVersionId && !definition) {
          return {
            error: `${wf.name} has no published version yet, so it can't be turned on. The user publishes it in the editor.`,
          };
        }
        rows.push(...diff("On", wf.enabled, input.enabled));
      }
      if (rows.length === 0)
        return { error: `Nothing to change: ${wf.name} already looks like that.` };
      const onlyToggle =
        rows.length === 1 && input.enabled !== undefined && rows[0]?.label === "On";
      const [verb, doing, done] = onlyToggle
        ? input.enabled
          ? ["Turn on", "Turning on", "Turned on"]
          : ["Turn off", "Turning off", "Turned off"]
        : ["Change", "Changing", "Changed"];
      return propose(ctx, scope, options, {
        tool: "change_workflow",
        subjectType: "workflow",
        subjectId: wf.id,
        change: {
          title: `${verb} workflow ${wf.name}?`,
          doing: `${doing} ${wf.name}`,
          done: `${done} ${name}`,
          rows,
          secrets: [],
        },
        apply: async () => {
          const actor = actorOf(scope);
          try {
            let current = (await ctx.workflows.get(scope.workspaceId, wf.id)) ?? wf;
            let version: number | null = null;
            const renameOnly = !definition && input.name !== undefined && input.name !== wf.name;
            if (definition || (renameOnly && !current.draftDirty)) {
              const def = definition ?? { ...WorkflowDefinitionSchema.parse(current.draft), name };
              current = await ctx.workflows.saveDraft(current, def);
              const published = await ctx.workflows.publish(actor, current, "Changed from chat");
              if (!published.ok) {
                return {
                  ok: false,
                  error: `It didn't publish: ${published.issues.map((i) => i.message).join("; ")}`,
                };
              }
              version = published.version;
              current = (await ctx.workflows.get(scope.workspaceId, wf.id)) ?? current;
            } else if (renameOnly) {
              current = await ctx.workflows.update(actor, current, { name });
            }
            if (input.enabled !== undefined && input.enabled !== current.enabled) {
              current = (await ctx.workflows.setEnabled(actor, current, input.enabled)) ?? current;
            }
            return {
              ok: true,
              subjectId: wf.id,
              result: {
                workflow: { id: current.id, name: current.name, enabled: current.enabled },
                ...(version ? { version } : {}),
                link: workflowLink(ctx, wf.id),
              },
            };
          } catch (err) {
            return failed(err);
          }
        },
      });
    },
  });
}

// ------------------------------------------------------------- personalities

function toolsText(tools: readonly PersonalityTool[]): string {
  return tools.length ? tools.map((t) => PERSONALITY_TOOL_INFO[t].label).join(", ") : "None";
}

function savePersonality(ctx: AppContext, scope: ToolScope): Tool {
  return tool({
    description: `Add a personality, or change one: its name, the line under it, its instructions, the tool groups it may use, and its look (color and shape).${ASKS}`,
    inputSchema: z.object({
      personality: z
        .string()
        .max(200)
        .optional()
        .describe("An existing personality's name or id, to change it. Leave it out to add one."),
      name: z.string().optional(),
      description: z.string().optional().describe("One short line under the name."),
      instructions: z.string().optional().describe("Who it is and how it answers."),
      tools: z.array(z.enum(PERSONALITY_TOOLS)).optional(),
      color: z.enum(PERSONALITY_COLORS).optional(),
      shape: z.enum(GLYPH_SHAPES).optional(),
    }),
    execute: async (input, options: CallOptions) => {
      const all = await listPersonalities(ctx.db, scope.workspaceId);
      if (!input.personality) {
        const usedColors = new Set(all.map((p) => p.color));
        const usedShapes = new Set(all.map((p) => p.shape));
        const parsed = PersonalityFields.safeParse({
          name: input.name,
          description: input.description ?? "",
          instructions: input.instructions,
          tools: input.tools ?? [],
          color: input.color ?? PERSONALITY_COLORS.find((c) => !usedColors.has(c)) ?? "blue",
          shape: input.shape ?? GLYPH_SHAPES.find((s) => !usedShapes.has(s)) ?? "drift",
        });
        if (!parsed.success) return { error: zodIssues(parsed.error) };
        const p = parsed.data;
        return propose(ctx, scope, options, {
          tool: "save_personality",
          subjectType: "personality",
          subjectId: "",
          change: {
            title: `Add personality ${p.name}?`,
            doing: `Adding ${p.name}`,
            done: `Added ${p.name}`,
            rows: [
              row("Name", p.name),
              ...(p.description ? [row("Description", p.description)] : []),
              row("Instructions", p.instructions),
              row("Tools", toolsText(p.tools)),
              row("Look", `${p.color}, ${p.shape}`),
            ],
            secrets: [],
          },
          apply: async () => {
            const created = await createPersonality(ctx, actorOf(scope), p);
            return {
              ok: true,
              subjectId: created.id,
              result: { personality: personalitySummary(created) },
            };
          },
        });
      }
      const want = input.personality;
      const current =
        all.find((p) => p.id === want.trim()) ?? all.find((p) => sameName(p.name, want));
      if (!current) {
        return {
          error: `No personality called ${want}. Personalities: ${all.map((p) => p.name).join(", ")}.`,
        };
      }
      const parsed = PersonalityPatch.safeParse({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.shape !== undefined ? { shape: input.shape } : {}),
      });
      if (!parsed.success) return { error: zodIssues(parsed.error) };
      const b = parsed.data;
      const rows = [
        ...diff("Name", current.name, b.name ?? current.name),
        ...diff("Description", current.description, b.description ?? current.description),
        ...diff("Instructions", current.instructions, b.instructions ?? current.instructions),
        ...diff("Tools", toolsText(current.tools), toolsText(b.tools ?? current.tools)),
        ...diff(
          "Look",
          `${current.color}, ${current.shape}`,
          `${b.color ?? current.color}, ${b.shape ?? current.shape}`,
        ),
      ];
      if (rows.length === 0)
        return { error: `Nothing to change: ${current.name} already looks like that.` };
      const name = b.name ?? current.name;
      return propose(ctx, scope, options, {
        tool: "save_personality",
        subjectType: "personality",
        subjectId: current.id,
        change: {
          title: `Change personality ${current.name}?`,
          doing: `Changing ${current.name}`,
          done: `Changed ${name}`,
          rows,
          secrets: [],
        },
        apply: async () => {
          const updated = await updatePersonality(ctx, actorOf(scope), current, b);
          if (!updated) return { ok: false, error: "That personality went away." };
          return {
            ok: true,
            subjectId: updated.id,
            result: { personality: personalitySummary(updated) },
          };
        },
      });
    },
  });
}

function personalitySummary(p: PersonalityRow) {
  const v = toPersonalityView(p);
  return { id: v.id, name: v.name, tools: v.tools, color: v.color, shape: v.shape };
}

// ------------------------------------------------------------- settings

const NOTIFY_LABEL = {
  approvals: "Push for approvals",
  tasks: "Push for finished tasks",
  replies: "Push for replies",
} as const;

function changeSettings(ctx: AppContext, scope: ToolScope): Tool {
  return tool({
    description: `Change workspace settings: the time zone, the mode new chats start in, the model new chats use, which push notifications the user gets, sandbox limits, and which repos may run in sandboxes. read_setup shows what they are now and the models to pick from.${ASKS}`,
    inputSchema: z.object({
      timeZone: z.string().max(64).optional().describe("An IANA time zone, such as Europe/Lisbon."),
      defaultMode: z.enum(PERMISSION_MODES).optional().describe("The mode new chats start in."),
      chatModel: z
        .object({
          provider: z.string().max(40),
          model: z
            .string()
            .max(200)
            .describe("A model id from read_setup, or empty for a CLI's own default."),
          effort: z.string().max(20).nullable().optional(),
        })
        .optional()
        .describe("The model new chats use."),
      notifications: NotificationsPatch.optional(),
      sandboxes: SandboxSettingsPatch.pick({
        concurrentLimit: true,
        lifetimeMinutes: true,
        monthlyMinutesBudget: true,
      }).optional(),
      allowInSandboxes: z
        .array(
          z.object({
            repo: z.string().max(300).describe("Such as github.com/owner/name."),
            defaultBranch: z.string().max(200).optional(),
            network: z.boolean().optional(),
          }),
        )
        .max(20)
        .optional(),
      removeFromSandboxes: z.array(z.string().max(300)).max(20).optional(),
    }),
    execute: async (input, options: CallOptions) => {
      const owner = { workspaceId: scope.workspaceId, userId: scope.ownerId };
      const rows: SetupChangeRow[] = [];
      const steps: (() => Promise<unknown>)[] = [];
      const [ws] = await ctx.db
        .select({
          defaultMode: schema.workspaces.defaultMode,
          sandboxSettings: schema.workspaces.sandboxSettings,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, scope.workspaceId));

      if (input.timeZone !== undefined) {
        if (!isTimeZone(input.timeZone))
          return { error: `${input.timeZone} isn't a time zone this server knows.` };
        const zone = input.timeZone;
        rows.push(...diff("Time zone", await workspaceTimeZone(ctx, scope.workspaceId), zone));
        steps.push(() => setTimeZone(ctx, owner, zone));
      }
      if (input.defaultMode !== undefined) {
        const mode = input.defaultMode;
        rows.push(
          ...diff(
            "New chats start in",
            MODE_POLICY[ws?.defaultMode ?? "auto"].label,
            MODE_POLICY[mode].label,
          ),
        );
        steps.push(() => setDefaultMode(ctx, owner, mode));
      }
      if (input.chatModel) {
        const choice = AssistantChoiceSchema.safeParse({
          provider: input.chatModel.provider,
          model: input.chatModel.model,
          effort: input.chatModel.effort ?? null,
          fast: false,
        });
        if (!choice.success) return { error: zodIssues(choice.error) };
        const catalog = await modelCatalog(ctx, scope.workspaceId);
        const provider = catalog.assistant.find((p) => p.provider === choice.data.provider);
        if (!provider?.connected) {
          return {
            error: `${input.chatModel.provider} isn't set up. Models can come from: ${
              catalog.assistant
                .filter((p) => p.connected)
                .map((p) => p.provider)
                .join(", ") || "nothing yet"
            }.`,
          };
        }
        if (
          choice.data.model &&
          provider.models.length > 0 &&
          !provider.models.some((m) => m.id === choice.data.model)
        ) {
          return { error: `${provider.label} has no model ${choice.data.model}.` };
        }
        const current = (await chatDefaults(ctx, scope.workspaceId)).assistant;
        const label = (c: { provider: string; model: string; effort: string | null } | null) => {
          if (!c) return "None";
          const p = catalog.assistant.find((x) => x.provider === c.provider)?.label ?? c.provider;
          return `${p}${c.model ? ` ${c.model}` : ""}${c.effort ? `, ${c.effort} effort` : ""}`;
        };
        rows.push(...diff("Chat model", label(current), label(choice.data)));
        steps.push(() => setChatDefaults(ctx, owner, { assistant: choice.data }));
      }
      if (input.notifications) {
        const patch = input.notifications;
        const now = await notificationsOf(ctx, owner);
        for (const k of Object.keys(NOTIFY_LABEL) as (keyof typeof NOTIFY_LABEL)[]) {
          if (patch[k] !== undefined) rows.push(...diff(NOTIFY_LABEL[k], now[k], patch[k]));
        }
        steps.push(() => setNotifications(ctx, owner, patch));
      }
      if (input.sandboxes) {
        const parsed = SandboxSettingsPatch.safeParse(input.sandboxes);
        if (!parsed.success) return { error: zodIssues(parsed.error) };
        const now = resolveSettings(ws?.sandboxSettings);
        const p = parsed.data;
        if (p.concurrentLimit !== undefined)
          rows.push(...diff("Sandboxes at once", now.concurrentLimit, p.concurrentLimit));
        if (p.lifetimeMinutes !== undefined)
          rows.push(
            ...diff("Sandbox lifetime", `${now.lifetimeMinutes} min`, `${p.lifetimeMinutes} min`),
          );
        if (p.monthlyMinutesBudget !== undefined) {
          rows.push(
            ...diff("Sandbox minutes a month", now.monthlyMinutesBudget, p.monthlyMinutesBudget),
          );
        }
        steps.push(() => updateSandboxSettings(ctx, owner, p));
      }
      if (input.allowInSandboxes?.length || input.removeFromSandboxes?.length) {
        const listed = await ctx.db
          .select()
          .from(schema.sandboxRepos)
          .where(eq(schema.sandboxRepos.workspaceId, scope.workspaceId));
        for (const a of input.allowInSandboxes ?? []) {
          const key = keyFromInput(a.repo);
          if (!key)
            return { error: `${a.repo} isn't a repo remote such as github.com/owner/name.` };
          const parsed = SandboxRepoInput.safeParse({
            ...(a.defaultBranch ? { defaultBranch: a.defaultBranch } : {}),
            ...(a.network !== undefined ? { network: a.network } : {}),
          });
          if (!parsed.success) return { error: `${key}: ${zodIssues(parsed.error)}` };
          const checked = checkCloneUrl(cloneUrlFor(key), key, allowLocalCloneUrls(ctx));
          if (!checked.ok) return { error: `${key}: ${checked.error}` };
          const was = listed.find((r) => r.remoteKey === key);
          const text = (b: string, n: boolean) => `${b}${n ? ", with network" : ""}`;
          rows.push(
            ...diff(
              `In sandboxes: ${key}`,
              was ? text(was.defaultBranch, was.network) : "Not allowed",
              text(parsed.data.defaultBranch, parsed.data.network),
            ),
          );
          steps.push(() => allowSandboxRepo(ctx, owner, key, parsed.data));
        }
        for (const r of input.removeFromSandboxes ?? []) {
          const key = keyFromInput(r);
          const was = listed.find((x) => x.remoteKey === key);
          if (!key || !was) {
            return {
              error: `${r} isn't allowed in sandboxes. Allowed: ${listed.map((x) => x.remoteKey).join(", ") || "none"}.`,
            };
          }
          rows.push(...diff(`In sandboxes: ${key}`, "Allowed", "Not allowed"));
          steps.push(() => removeSandboxRepo(ctx, owner, key));
        }
      }
      if (steps.length === 0) return { error: "Pass at least one setting to change." };
      if (rows.length === 0)
        return { error: "Nothing to change: the settings already look like that." };
      return propose(ctx, scope, options, {
        tool: "change_settings",
        subjectType: "workspace",
        subjectId: scope.workspaceId,
        change: {
          title: "Change settings?",
          doing: "Changing settings",
          done: "Changed settings",
          rows,
          secrets: [],
        },
        apply: async () => {
          for (const step of steps) await step();
          return {
            ok: true,
            subjectId: scope.workspaceId,
            result: { changed: rows.map((r) => `${r.label}: ${r.after}`) },
          };
        },
      });
    },
  });
}

/** Every setup tool, by name. */
export function setupTools(ctx: AppContext, scope: ToolScope) {
  return {
    read_setup: readSetupTool(ctx, scope),
    save_deploy_target: saveDeployTarget(ctx, scope),
    save_app_account: saveAppAccount(ctx, scope),
    add_workflow: addWorkflow(ctx, scope),
    change_workflow: changeWorkflow(ctx, scope),
    save_personality: savePersonality(ctx, scope),
    change_settings: changeSettings(ctx, scope),
  } satisfies Record<(typeof SETUP_TOOLS)[number], Tool>;
}
