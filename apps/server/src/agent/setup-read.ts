/**
 * What the assistant reads of Sling's own setup before it changes any of it:
 * deploy targets, connectors and accounts, workflows and templates,
 * personalities, and settings. Reading never asks. No credential is ever
 * read back, secret or not, just as the API never returns one.
 */
import type { AnyConnector } from "@sling/connector-sdk";
import {
  GLYPH_SHAPES,
  PERMISSION_MODES,
  PERSONALITY_COLORS,
  PERSONALITY_TOOL_INFO,
  PERSONALITY_TOOLS,
} from "@sling/core";
import { schema } from "@sling/db";
import { WorkflowDefinitionSchema } from "@sling/workflow";
import { tool } from "ai";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { listPersonalities } from "../personalities/service.ts";
import { resolveSettings } from "../sandboxes/settings.ts";
import { notificationsOf } from "../settings.ts";
import { workspaceTimeZone } from "../timezone.ts";
import { runnerViews } from "../views.ts";
import { toJsonSchema } from "../workflows/registry.ts";
import type { WorkflowRow } from "../workflows/views.ts";
import { modelCatalog } from "./catalog.ts";
import { chatDefaults } from "./chat-settings.ts";
import { type FieldInfo, fieldsOf } from "./setup-change.ts";
import type { ToolScope } from "./tools.ts";

export const SETUP_SECTIONS = [
  "deploy_targets",
  "apps",
  "workflows",
  "personalities",
  "settings",
] as const;

/** Most models listed per provider, so a long list doesn't fill the turn. */
const MAX_MODELS = 40;
const MAX_INSTRUCTIONS = 4_000;

/** A connector's credential and config fields, from the schemas its form uses. */
export function connectorFields(
  ctx: AppContext,
  c: AnyConnector,
): { credentials: FieldInfo[]; config: FieldInfo[] } {
  // Extension connectors use the schemas they described at install.
  const view = ctx.extensions.connectorView(c.id);
  const secrets = view?.secretFields ?? c.secretFields;
  return {
    credentials: fieldsOf(view?.credentialsSchema ?? toJsonSchema(c.credentialsSchema), secrets),
    config: fieldsOf(view?.configSchema ?? toJsonSchema(c.configSchema), []),
  };
}

function fieldSummary(f: FieldInfo) {
  return {
    key: f.key,
    title: f.title,
    ...(f.secret ? { secret: true } : {}),
    ...(f.required ? { required: true } : {}),
    ...(f.advanced ? { advanced: true } : {}),
  };
}

/** The definition a workflow runs: its published one, or its draft before it has one. */
export async function currentDefinition(ctx: AppContext, wf: WorkflowRow) {
  const active = wf.activeVersionId ? await ctx.engine.version(wf.activeVersionId) : null;
  return active?.definition ?? WorkflowDefinitionSchema.parse(wf.draft);
}

async function deployTargets(ctx: AppContext, workspaceId: string) {
  const [targets, runners, sandboxRepos] = await Promise.all([
    ctx.deploys.list(workspaceId),
    runnerViews(ctx, workspaceId),
    ctx.db
      .select({ key: schema.sandboxRepos.remoteKey })
      .from(schema.sandboxRepos)
      .where(eq(schema.sandboxRepos.workspaceId, workspaceId)),
  ]);
  const repos = new Map<
    string,
    { machines: string[]; deployCommands: string[]; sandbox: boolean }
  >();
  const entry = (key: string) => {
    let e = repos.get(key);
    if (!e) {
      e = { machines: [], deployCommands: [], sandbox: false };
      repos.set(key, e);
    }
    return e;
  };
  for (const r of runners) {
    for (const p of r.repos) {
      if (!p.remoteKey) continue;
      const e = entry(p.remoteKey);
      e.machines.push(r.name);
      if (p.deployCommand.trim()) e.deployCommands.push(`${r.name}: ${p.deployCommand}`);
    }
  }
  for (const s of sandboxRepos) entry(s.key).sandbox = true;
  return {
    targets: targets.map((t) => ({
      id: t.id,
      name: t.name,
      repo: t.remoteKey,
      method: t.method,
      mergeMethod: t.mergeMethod,
      ...(t.method === "command" ? { machine: t.runnerName, command: t.command } : {}),
      ...(t.hook
        ? { hook: { method: t.hook.httpMethod, host: t.hook.host, hasHeader: t.hook.hasHeader } }
        : {}),
      checks: t.checks,
      versionUrl: t.versionUrl,
      settleSeconds: t.settleSeconds,
      timeoutSeconds: t.timeoutSeconds,
      up: t.lastCheck?.up ?? null,
    })),
    repos: [...repos.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repo, e]) => ({
        repo,
        machines: e.machines,
        ...(e.deployCommands.length ? { deployCommands: e.deployCommands } : {}),
        allowedInSandboxes: e.sandbox,
        hasTarget: targets.some((t) => t.remoteKey === repo),
      })),
    machines: runners.map((r) => ({ id: r.id, name: r.name, online: r.online })),
  };
}

async function apps(ctx: AppContext, workspaceId: string) {
  const rows = await ctx.db
    .select()
    .from(schema.connectorInstallations)
    .where(eq(schema.connectorInstallations.workspaceId, workspaceId))
    .orderBy(asc(schema.connectorInstallations.createdAt));
  return {
    connectors: ctx.registry.connectors().map((c) => {
      const fields = connectorFields(ctx, c);
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        credentials: fields.credentials.filter((f) => !f.hidden).map(fieldSummary),
        config: fields.config.filter((f) => !f.hidden).map(fieldSummary),
        ...(c.setup ? { findsSettings: true } : {}),
      };
    }),
    accounts: rows.map((i) => ({
      id: i.id,
      name: i.name,
      connector: i.connectorId,
      enabled: i.enabled,
      status: i.status,
      config: i.config,
    })),
  };
}

async function workflows(ctx: AppContext, workspaceId: string, which: string | undefined) {
  const rows = await ctx.db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.workspaceId, workspaceId))
    .orderBy(asc(schema.workflows.name));
  const installations = await ctx.db
    .select({ id: schema.connectorInstallations.id, name: schema.connectorInstallations.name })
    .from(schema.connectorInstallations)
    .where(eq(schema.connectorInstallations.workspaceId, workspaceId));
  const accountName = new Map(installations.map((i) => [i.id, i.name]));
  const want = which?.trim().toLowerCase();
  const list = await Promise.all(
    rows.map(async (w) => {
      const summary = {
        id: w.id,
        name: w.name,
        description: w.description,
        enabled: w.enabled,
        published: Boolean(w.activeVersionId),
        unpublishedChanges: w.draftDirty,
        template: w.templateKey,
      };
      if (!want || (w.id !== which?.trim() && w.name.toLowerCase() !== want)) return summary;
      const def = await currentDefinition(ctx, w);
      return {
        ...summary,
        steps: def.nodes.map((n) => {
          const spec = ctx.registry.get(n.type, n.version);
          const installationFields = new Set(spec?.installationFields ?? []);
          const settings = Object.fromEntries(
            Object.entries(n.config).map(([k, v]) => [
              k,
              installationFields.has(k) && typeof v === "string" ? (accountName.get(v) ?? v) : v,
            ]),
          );
          return {
            id: n.id,
            label: n.label ?? spec?.title ?? n.type,
            type: n.type,
            settings,
            ...(spec
              ? {
                  fields: fieldsOf(toJsonSchema(spec.configSchema), []).map((f) => ({
                    key: f.key,
                    title: f.title,
                    ...(installationFields.has(f.key) ? { account: spec.connector } : {}),
                  })),
                }
              : {}),
          };
        }),
        // As create_workflow and change_workflow take them.
        edges: def.edges.map((e) => ({
          from: `${e.from.node}.${e.from.port}`,
          to: `${e.to.node}.${e.to.port}`,
        })),
      };
    }),
  );
  return {
    workflows: list,
    templates: ctx.workflows.availableTemplates().map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      accounts: t.bindings.map((b) => ({
        placeholder: b.placeholder,
        connector: b.connectorId,
        label: b.label,
      })),
    })),
  };
}

async function personalities(ctx: AppContext, workspaceId: string) {
  const rows = await listPersonalities(ctx.db, workspaceId);
  return {
    personalities: rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      tools: p.tools,
      color: p.color,
      shape: p.shape,
      ...(p.isDefault ? { default: true } : {}),
      ...(p.assistant ? { model: p.assistant } : {}),
      instructions:
        p.instructions.length > MAX_INSTRUCTIONS
          ? `${p.instructions.slice(0, MAX_INSTRUCTIONS)}…`
          : p.instructions,
    })),
    tools: PERSONALITY_TOOLS.map((t) => ({ id: t, label: PERSONALITY_TOOL_INFO[t].label })),
    colors: PERSONALITY_COLORS,
    shapes: GLYPH_SHAPES,
  };
}

async function settings(ctx: AppContext, scope: ToolScope) {
  const [ws] = await ctx.db
    .select({
      defaultMode: schema.workspaces.defaultMode,
      sandboxSettings: schema.workspaces.sandboxSettings,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, scope.workspaceId));
  const [timeZone, defaults, catalog, notifications, sandboxRepos] = await Promise.all([
    workspaceTimeZone(ctx, scope.workspaceId),
    chatDefaults(ctx, scope.workspaceId),
    modelCatalog(ctx, scope.workspaceId),
    notificationsOf(ctx, { workspaceId: scope.workspaceId, userId: scope.ownerId }),
    ctx.db
      .select()
      .from(schema.sandboxRepos)
      .where(eq(schema.sandboxRepos.workspaceId, scope.workspaceId))
      .orderBy(asc(schema.sandboxRepos.remoteKey)),
  ]);
  const sandbox = resolveSettings(ws?.sandboxSettings);
  return {
    timeZone,
    defaultMode: ws?.defaultMode ?? "auto",
    modes: PERMISSION_MODES,
    chatModel: defaults.assistant,
    models: catalog.assistant
      .filter((p) => p.connected)
      .map((p) => ({
        provider: p.provider,
        label: p.label,
        models: p.models.slice(0, MAX_MODELS).map((m) => m.id),
      })),
    notifications,
    sandboxes: {
      concurrentLimit: sandbox.concurrentLimit,
      lifetimeMinutes: sandbox.lifetimeMinutes,
      monthlyMinutesBudget: sandbox.monthlyMinutesBudget,
    },
    allowedInSandboxes: sandboxRepos.map((r) => ({
      repo: r.remoteKey,
      defaultBranch: r.defaultBranch,
      network: r.network,
    })),
  };
}

export function readSetupTool(ctx: AppContext, scope: ToolScope) {
  return tool({
    description:
      "Read Sling's own setup before changing it. deploy_targets: targets, and the repos and machines a target can use. apps: the connectors Sling has, with each one's fields (secret ones are typed by the user on the card, never passed), and the user's accounts. workflows: the user's workflows and the templates to add one from; pass workflow to also get its steps and their settings. personalities: each personality, and the tool groups, colors, and shapes. settings: time zone, default mode, chat model and the models to pick from, notifications, sandbox limits, and the repos allowed in sandboxes.",
    inputSchema: z.object({
      section: z.enum(SETUP_SECTIONS),
      workflow: z
        .string()
        .max(200)
        .optional()
        .describe("With workflows: a workflow's name or id, to get its steps."),
    }),
    execute: async ({ section, workflow }) => {
      switch (section) {
        case "deploy_targets":
          return deployTargets(ctx, scope.workspaceId);
        case "apps":
          return apps(ctx, scope.workspaceId);
        case "workflows":
          return workflows(ctx, scope.workspaceId, workflow);
        case "personalities":
          return personalities(ctx, scope.workspaceId);
        case "settings":
          return settings(ctx, scope);
      }
    },
  });
}
