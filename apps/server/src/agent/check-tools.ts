/**
 * The assistant's tools for checks: run_check runs one now, and save_check
 * adds or changes one through a setup card. A check's URLs, command, and
 * mailbox are set on the card or by the user, so the card always shows them.
 */
import {
  CHECK_INTERVAL_SECONDS,
  CHECK_KINDS,
  type CheckConfig,
  type CheckInput,
  type CheckPatch,
  type CheckView,
  type SetupChangeRow,
} from "@sling/core";
import { schema } from "@sling/db";
import { type Tool, tool } from "ai";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { dayAndTimeIn } from "../checks/alerts.ts";
import type { AppContext } from "../context.ts";
import type { Actor } from "../http/session.ts";
import { workspaceTimeZone } from "../timezone.ts";
import { type CallOptions, diff, errorText, propose, row } from "./setup-change.ts";
import type { ToolScope } from "./tools.ts";

function actorOf(scope: ToolScope): Actor {
  return { workspaceId: scope.workspaceId, userId: scope.ownerId, email: "" };
}

const KIND_LABEL = { site: "Site", command: "Command", reply: "Reply" } as const;

function every(seconds: number): string {
  if (seconds < 60) return `Every ${seconds} s`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "Every hour" : `Every ${seconds / 3600} h`;
  const m = Math.round(seconds / 60);
  return m === 1 ? "Every minute" : `Every ${m} min`;
}

/** What a check watches, as the rows of a card. */
function configRows(config: CheckConfig): SetupChangeRow[] {
  if (config.kind === "site") {
    return [
      ...config.checks.map((c, i) =>
        row(
          config.checks.length === 1 ? "URL" : `URL ${i + 1}`,
          `${c.url}${c.status ? `, answers ${c.status}` : ""}${c.contains ? `, contains “${c.contains}”` : ""}`,
        ),
      ),
      ...(config.versionUrl ? [row("Version URL", config.versionUrl)] : []),
    ];
  }
  if (config.kind === "command") {
    return [
      row("Command", config.command),
      ...(config.contains ? [row("Output contains", config.contains)] : []),
      row("Time limit", `${config.timeoutSeconds} s`),
    ];
  }
  return [
    ...(config.from ? [row("From", config.from)] : []),
    ...(config.subject ? [row("Subject", config.subject)] : []),
    ...(config.inReplyTo ? [row("In reply to", config.inReplyTo)] : []),
    ...(config.folder ? [row("Folder", config.folder)] : []),
  ];
}

/** A check as a tool result tells the model about it. */
export function checkSummary(view: CheckView) {
  const r = view.lastResult;
  return {
    check: view.name,
    kind: view.kind,
    state: view.state,
    enabled: view.enabled,
    lastResult: r ? { at: r.at, passed: r.passed, message: r.message } : null,
    ...(view.deploy ? { deploysRepo: view.deploy.remoteKey } : {}),
  };
}

async function machineByName(ctx: AppContext, workspaceId: string, want: string) {
  const runners = await ctx.db
    .select({ id: schema.runners.id, name: schema.runners.name })
    .from(schema.runners)
    .where(
      and(
        eq(schema.runners.workspaceId, workspaceId),
        isNull(schema.runners.revokedAt),
        eq(schema.runners.ephemeral, false),
      ),
    );
  const w = want.trim().toLowerCase();
  const hit = runners.find((r) => r.id === want.trim() || r.name.toLowerCase() === w);
  return hit
    ? { runner: hit }
    : {
        error: `No machine called ${want}. Machines: ${runners.map((r) => r.name).join(", ") || "none"}.`,
      };
}

async function mailboxByName(ctx: AppContext, workspaceId: string, want: string | undefined) {
  const accounts = await ctx.db
    .select({ id: schema.connectorInstallations.id, name: schema.connectorInstallations.name })
    .from(schema.connectorInstallations)
    .where(
      and(
        eq(schema.connectorInstallations.workspaceId, workspaceId),
        eq(schema.connectorInstallations.connectorId, "email"),
      ),
    );
  if (!want) {
    const [only] = accounts;
    if (accounts.length === 1 && only) return { account: only };
    return {
      error:
        accounts.length === 0
          ? "The user has no email account in Sling. They add one under Connectors."
          : `Pass mailbox: ${accounts.map((a) => a.name).join(", ")}.`,
    };
  }
  const w = want.trim().toLowerCase();
  const hit = accounts.find((a) => a.id === want.trim() || a.name.toLowerCase() === w);
  return hit
    ? { account: hit }
    : {
        error: `No email account called ${want}. Accounts: ${accounts.map((a) => a.name).join(", ") || "none"}.`,
      };
}

const UrlSchema = z.object({
  url: z.string().min(1).max(2000),
  status: z.number().int().min(100).max(599).nullable().optional(),
  contains: z.string().max(500).nullable().optional(),
});

/** Adds a check Sling runs on its own, or changes one. */
export function saveCheckTool(ctx: AppContext, scope: ToolScope): Tool {
  return tool({
    description:
      "Add a check that Sling runs on its own, or change one. site: URLs that should answer (1 to 5), every minute. command: a command on one of the user's machines that should exit 0, run in that machine's read-only sandbox every 5 minutes, with no network. reply: an email expected by a deadline, looked for every 5 minutes. When a check goes down or a reply is missed, the user gets a push. A site that deploys is changed with save_deploy_target. Call it as soon as you know what to change: Sling shows the user the exact change to apply or cancel, unless the conversation's mode applies it at once.",
    inputSchema: z.object({
      check: z
        .string()
        .max(200)
        .optional()
        .describe("An existing check's name or id, to change it. Leave it out to add one."),
      name: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .optional()
        .describe("Such as Website, Backup, or Reply from Jo."),
      kind: z.enum(CHECK_KINDS).optional().describe("For a new check."),
      urls: z.array(UrlSchema).min(1).max(5).optional().describe("site: the pages to check."),
      versionUrl: z.string().max(2000).nullable().optional(),
      command: z.string().max(4000).optional().describe("command: what to run."),
      machine: z.string().max(200).optional().describe("command: the machine's name or id."),
      contains: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("command: text the output must contain."),
      timeoutSeconds: z.number().int().min(1).max(300).optional(),
      mailbox: z
        .string()
        .max(200)
        .optional()
        .describe("reply: the email account's name. Left out, the user's only one."),
      from: z
        .string()
        .max(320)
        .nullable()
        .optional()
        .describe("reply: who it's from, an address or a name."),
      subject: z.string().max(500).nullable().optional().describe("reply: words in its subject."),
      inReplyTo: z
        .string()
        .max(998)
        .nullable()
        .optional()
        .describe("reply: the Message-ID of the email it answers."),
      deadline: z
        .string()
        .max(40)
        .optional()
        .describe("reply: when it's missed, as an ISO time with its offset."),
      everyMinutes: z.number().min(0.5).max(1440).optional(),
      enabled: z.boolean().optional(),
      notify: z.boolean().optional().describe("Push to the user when it changes. On by default."),
    }),
    execute: async (input, options: CallOptions) => {
      const timeZone = await workspaceTimeZone(ctx, scope.workspaceId);
      const intervalSeconds =
        input.everyMinutes !== undefined ? Math.round(input.everyMinutes * 60) : undefined;
      const existing = input.check ? await ctx.checks.find(scope.workspaceId, input.check) : null;
      if (input.check && !existing) {
        const names = (await ctx.checks.list(scope.workspaceId)).map((c) => c.name);
        return { error: `No check called ${input.check}. Checks: ${names.join(", ") || "none"}.` };
      }
      const kind = existing?.kind ?? input.kind;
      if (!kind) return { error: "A new check needs kind: site, command, or reply." };
      if (existing && input.kind && input.kind !== existing.kind) {
        return { error: "A check's kind can't change. Add a new check instead." };
      }

      // What it watches: the stored config, with what the call changes.
      const before = existing?.config;
      let config: CheckConfig;
      if (kind === "site") {
        const prior = before?.kind === "site" ? before : null;
        const checks = input.urls?.map((u) => ({
          url: u.url,
          status: u.status ?? null,
          contains: u.contains || null,
        }));
        if (!checks && !prior) return { error: "A site check needs urls." };
        config = {
          kind: "site",
          checks: checks ?? prior?.checks ?? [],
          versionUrl:
            input.versionUrl !== undefined ? input.versionUrl : (prior?.versionUrl ?? null),
        };
      } else if (kind === "command") {
        const prior = before?.kind === "command" ? before : null;
        const command = input.command ?? prior?.command;
        if (!command) return { error: "A command check needs command." };
        config = {
          kind: "command",
          command,
          contains: input.contains !== undefined ? input.contains : (prior?.contains ?? null),
          timeoutSeconds: input.timeoutSeconds ?? prior?.timeoutSeconds ?? 60,
        };
      } else {
        const prior = before?.kind === "reply" ? before : null;
        config = {
          kind: "reply",
          from: input.from !== undefined ? input.from : (prior?.from ?? null),
          subject: input.subject !== undefined ? input.subject : (prior?.subject ?? null),
          inReplyTo: input.inReplyTo !== undefined ? input.inReplyTo : (prior?.inReplyTo ?? null),
          folder: prior?.folder ?? null,
        };
        if (!config.from && !config.subject && !config.inReplyTo) {
          return { error: "A reply check needs from, subject, or inReplyTo." };
        }
      }

      let runnerId = existing?.runnerId ?? null;
      let machineName = "";
      if (kind === "command" && (input.machine || !existing)) {
        if (!input.machine) return { error: "A command check needs machine." };
        const m = await machineByName(ctx, scope.workspaceId, input.machine);
        if ("error" in m) return { error: m.error };
        runnerId = m.runner.id;
        machineName = m.runner.name;
      }
      let installationId = existing?.installationId ?? null;
      let mailboxName = "";
      if (kind === "reply" && (input.mailbox || !existing)) {
        const m = await mailboxByName(ctx, scope.workspaceId, input.mailbox);
        if ("error" in m) return { error: m.error };
        installationId = m.account.id;
        mailboxName = m.account.name;
      }
      if (kind === "reply" && !existing && !input.deadline) {
        return { error: "A reply check needs a deadline." };
      }
      const deadline = input.deadline ? new Date(input.deadline) : null;
      if (deadline && Number.isNaN(deadline.getTime())) {
        return { error: "deadline must be an ISO time, such as 2026-11-13T17:00:00+00:00." };
      }

      const name = input.name ?? existing?.name;
      if (!name) return { error: "A new check needs a name." };
      const interval = intervalSeconds ?? existing?.intervalSeconds ?? CHECK_INTERVAL_SECONDS[kind];

      if (!existing) {
        const body: CheckInput = {
          name,
          config,
          intervalSeconds: interval,
          ...(runnerId ? { runnerId } : {}),
          ...(installationId ? { installationId } : {}),
          ...(deadline ? { deadline: deadline.toISOString() } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.notify !== undefined ? { notify: input.notify } : {}),
        };
        const rows: SetupChangeRow[] = [
          row("Name", name),
          row("Kind", KIND_LABEL[kind]),
          ...configRows(config),
          ...(kind === "command"
            ? [row("Machine", machineName), row("Runs", "In the read-only sandbox")]
            : []),
          ...(kind === "reply" ? [row("Mailbox", mailboxName)] : []),
          ...(deadline ? [row("Deadline", dayAndTimeIn(deadline.toISOString(), timeZone))] : []),
          row("Checks", every(interval)),
          ...(input.notify === false ? [row("Push", "Off")] : []),
        ];
        return propose(ctx, scope, options, {
          tool: "save_check",
          subjectType: "check",
          subjectId: "",
          change: {
            title: `Add check ${name}?`,
            doing: `Adding ${name}`,
            done: `Added ${name}`,
            rows,
            secrets: [],
          },
          apply: async () => {
            try {
              const view = await ctx.checks.create(actorOf(scope), body);
              return { ok: true, subjectId: view.id, result: checkSummary(view) };
            } catch (err) {
              return { ok: false, error: errorText(err) };
            }
          },
        });
      }

      const patch: CheckPatch = {
        ...(input.name ? { name: input.name } : {}),
        ...(JSON.stringify(config) !== JSON.stringify(existing.config) ? { config } : {}),
        ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
        ...(kind === "command" && runnerId !== existing.runnerId ? { runnerId } : {}),
        ...(kind === "reply" && installationId !== existing.installationId
          ? { installationId }
          : {}),
        ...(deadline ? { deadline: deadline.toISOString() } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.notify !== undefined ? { notify: input.notify } : {}),
      };
      if (Object.keys(patch).length === 0) return { error: "Nothing to change." };
      const was = (await ctx.checks.get(scope.workspaceId, existing.id)) as CheckView;
      const beforeRows = new Map(configRows(existing.config).map((r) => [r.label, r.after]));
      const afterRows = configRows(config);
      const rows: SetupChangeRow[] = [
        ...diff("Name", existing.name, name),
        ...afterRows.flatMap((r) => diff(r.label, beforeRows.get(r.label) ?? null, r.after)),
        ...[...beforeRows.keys()]
          .filter((l) => !afterRows.some((r) => r.label === l))
          .flatMap((l) => diff(l, beforeRows.get(l), "Removed")),
        ...(patch.runnerId ? diff("Machine", was.runnerName, machineName) : []),
        ...(patch.installationId ? diff("Mailbox", was.installationName, mailboxName) : []),
        ...(patch.deadline
          ? diff(
              "Deadline",
              was.deadline ? dayAndTimeIn(was.deadline, timeZone) : null,
              dayAndTimeIn(patch.deadline, timeZone),
            )
          : []),
        ...diff("Checks", every(existing.intervalSeconds), every(interval)),
        ...(input.enabled !== undefined ? diff("On", existing.enabled, input.enabled) : []),
        ...(input.notify !== undefined ? diff("Push", existing.notify, input.notify) : []),
      ];
      return propose(ctx, scope, options, {
        tool: "save_check",
        subjectType: "check",
        subjectId: existing.id,
        change: {
          title: `Change ${existing.name}?`,
          doing: `Changing ${existing.name}`,
          done: `Changed ${existing.name}`,
          rows,
          secrets: [],
        },
        apply: async () => {
          try {
            const view = await ctx.checks.update(actorOf(scope), existing.id, patch);
            if (!view) return { ok: false, error: "That check went away." };
            return { ok: true, subjectId: view.id, result: checkSummary(view) };
          } catch (err) {
            return { ok: false, error: errorText(err) };
          }
        },
      });
    },
  });
}
