/**
 * Running each kind of check once: a site's URLs, a command in the read-only
 * sandbox on a machine, and a search of a mailbox for a reply.
 */
import type {
  CommandCheckConfig,
  ReplyCheckConfig,
  ReplyMatch,
  SiteCheckConfig,
} from "@sling/core";
import { type RunnerCapability, schema } from "@sling/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { probe, runChecks, showsCommit, statusMatches } from "../deploys/checks.ts";
import { latestSpec, nodeContext, scrub } from "./node-context.ts";
import { type RunOutcome, siteMessage } from "./state.ts";

export type CheckRow = typeof schema.checks.$inferSelect;

/** Longest command output kept with a result. */
export const OUTPUT_KEPT = 4_000;
/** How long a mailbox search may take. */
const SEARCH_TIMEOUT_MS = 30_000;

/** Runs a site check's URLs, and its version URL when there's a commit to look for. */
export async function runSite(
  config: SiteCheckConfig,
  opts: { expectSha?: string | null; signal?: AbortSignal } = {},
): Promise<RunOutcome> {
  const started = performance.now();
  const sha = opts.expectSha ?? null;
  const signal = opts.signal ? { signal: opts.signal } : {};
  const [checks, version] = await Promise.all([
    runChecks(config.checks, signal),
    sha && config.versionUrl
      ? probe(config.versionUrl, { readBody: true, ...signal })
      : Promise.resolve(null),
  ]);
  const versionSeen =
    version === null
      ? null
      : version.ok && statusMatches(version.status, null) && showsCommit(version.body, sha ?? "");
  const passed = checks.every((c) => c.ok);
  return {
    passed,
    counted: true,
    message: siteMessage(checks, versionSeen),
    ms: Math.round(performance.now() - started),
    detail: { kind: "site", checks, versionSeen },
  };
}

function capability(caps: RunnerCapability[], name: string) {
  return caps.find((c) => c.name === name);
}

/**
 * Why a machine can't run a command check, or null when it can: it needs
 * commands on, and a sandbox, since a check never runs outside it.
 */
export function commandRefusal(runner: { name: string; capabilities: RunnerCapability[] }) {
  const shell = capability(runner.capabilities, "shell");
  if (!shell) return `The Runner on ${runner.name} is too old to run commands.`;
  if (!shell.ready) return `Commands are off on ${runner.name}.`;
  const sandbox = capability(runner.capabilities, "shell.sandbox");
  if (!sandbox?.ready) {
    return `${runner.name} can't sandbox commands${sandbox?.detail ? `: ${sandbox.detail}` : ""}.`;
  }
  return null;
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Runs a command check on its machine, in the read-only sandbox. */
export async function runCommand(
  ctx: AppContext,
  check: Pick<CheckRow, "runnerId"> & { config: CommandCheckConfig },
): Promise<RunOutcome> {
  const config = check.config;
  const notRun = (error: string): RunOutcome => ({
    passed: false,
    counted: false,
    message: `Didn't run: ${error}`,
    ms: 0,
    detail: { kind: "command", exitCode: null, output: "", timedOut: false, error },
  });
  if (!check.runnerId) return notRun("no machine is set to run it");
  const [runner] = await ctx.db
    .select({
      name: schema.runners.name,
      capabilities: schema.runners.capabilities,
      revokedAt: schema.runners.revokedAt,
    })
    .from(schema.runners)
    .where(eq(schema.runners.id, check.runnerId));
  if (!runner || runner.revokedAt) return notRun("its machine was removed");
  if (!ctx.runners.isOnline(check.runnerId)) return notRun(`${runner.name} is offline`);
  const refused = commandRefusal(runner);
  if (refused) return notRun(refused.replace(/\.$/, ""));
  const started = performance.now();
  let result: Awaited<ReturnType<AppContext["commands"]["run"]>>;
  try {
    result = await ctx.commands.run(check.runnerId, {
      command: config.command,
      cwd: "",
      timeoutSeconds: config.timeoutSeconds,
      mode: "read-only",
      sandboxed: true,
    });
  } catch (err) {
    return notRun(err instanceof Error ? err.message.replace(/\.$/, "") : String(err));
  }
  const ms = Math.round(performance.now() - started);
  if (result.error) return notRun(result.error.replace(/\.$/, ""));
  const output =
    result.output.length > OUTPUT_KEPT ? result.output.slice(-OUTPUT_KEPT) : result.output;
  const detail = {
    kind: "command" as const,
    exitCode: result.exitCode,
    output,
    timedOut: result.timedOut,
    error: null,
  };
  if (result.timedOut) {
    return {
      passed: false,
      counted: true,
      message: `Timed out after ${config.timeoutSeconds} s`,
      ms,
      detail,
    };
  }
  if (result.exitCode !== 0) {
    const line = result.output.trim().split("\n").at(-1)?.trim().slice(0, 160);
    return {
      passed: false,
      counted: true,
      message: `Exited ${result.exitCode ?? "without a code"}${line ? `: ${line}` : ""}`,
      ms,
      detail,
    };
  }
  if (config.contains && !result.output.includes(config.contains)) {
    return {
      passed: false,
      counted: true,
      message: `The output doesn't contain "${config.contains.slice(0, 80)}"`,
      ms,
      detail,
    };
  }
  return {
    passed: true,
    counted: true,
    message: `Exited 0 in ${seconds(result.durationMs || ms)}`,
    ms,
    detail,
  };
}

/** What a reply check asks the mailbox. */
export interface ReplyQuery {
  workspaceId: string;
  ownerId: string;
  installationId: string;
  config: ReplyCheckConfig;
  /** Only mail that arrived after the check was made counts. */
  since: Date;
}

/** An email the search found, as much of it as a reply check looks at. */
export interface FoundMail extends ReplyMatch {
  inReplyTo?: string | null;
  references?: string[] | string | null;
}

/** Searches a mailbox. Sling's own uses the email connector's `email.search`. */
export type MailSearch = (q: ReplyQuery) => Promise<{ messages: FoundMail[] } | { error: string }>;

function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(strings);
  return typeof v === "string" ? [v] : [];
}

const bare = (id: string) => id.trim().replace(/^<|>$/g, "").toLowerCase();

/** Whether a found email answers the check: its thread, when it names one. */
export function answers(mail: FoundMail, config: ReplyCheckConfig): boolean {
  if (!config.inReplyTo) return true;
  const want = bare(config.inReplyTo);
  const refs = [...strings(mail.inReplyTo), ...strings(mail.references)].flatMap((r) =>
    r.split(/\s+/),
  );
  return refs.some((r) => bare(r) === want);
}

/** A sender's clock can run behind, and a Date header has no milliseconds. */
const CLOCK_SKEW_MS = 60_000;

/** One message from `email.search`, with its sender as text. */
function foundMail(v: unknown): FoundMail | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const from = m.from as { name?: unknown; address?: unknown } | string | null | undefined;
  const sender =
    typeof from === "string"
      ? from
      : typeof from?.address === "string"
        ? typeof from.name === "string" && from.name
          ? `${from.name} <${from.address}>`
          : from.address
        : "";
  return {
    id: String(m.id ?? ""),
    from: sender,
    subject: String(m.subject ?? ""),
    date: String(m.date ?? ""),
    inReplyTo: typeof m.inReplyTo === "string" ? m.inReplyTo : null,
    ...(m.references !== undefined ? { references: m.references as string[] | string } : {}),
  };
}

/** Searches through the `email.search` node of the account's connector. */
export function nodeMailSearch(ctx: AppContext): MailSearch {
  return async (q) => {
    const spec = latestSpec(ctx, "email.search");
    if (!spec?.run) return { error: "This server can't search email." };
    const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
    const { context, secrets } = nodeContext(ctx, spec, {
      workspaceId: q.workspaceId,
      ownerId: q.ownerId,
      installationId: q.installationId,
      key: `check:${q.installationId}`,
      attempt: 1,
      signal,
    });
    // IMAP searches by day, in the server's own zone, so ask from the day
    // before and keep only what arrived after the check was made.
    const dayBefore = new Date(q.since.getTime() - 86_400_000).toISOString().slice(0, 10);
    const config: Record<string, unknown> = {
      installationId: q.installationId,
      since: dayBefore,
      limit: 50,
      ...(q.config.from ? { from: q.config.from } : {}),
      ...(q.config.subject ? { subject: q.config.subject } : {}),
      ...(q.config.folder ? { folder: q.config.folder } : {}),
    };
    try {
      const result = await spec.run(context, { config, inputs: {} });
      if ("wait" in result) return { error: "The email search didn't finish." };
      const list = result.outputs?.messages;
      const messages = (Array.isArray(list) ? list : [])
        .map(foundMail)
        .filter(
          (m): m is FoundMail =>
            m !== null && Date.parse(m.date) >= q.since.getTime() - CLOCK_SKEW_MS,
        );
      return { messages };
    } catch (err) {
      return { error: scrub(err instanceof Error ? err.message : String(err), secrets) };
    }
  };
}

/** Looks for a reply in the check's mailbox. */
export async function runReply(search: MailSearch, q: ReplyQuery): Promise<RunOutcome> {
  const started = performance.now();
  const found = await search(q);
  const ms = Math.round(performance.now() - started);
  if ("error" in found) {
    return {
      passed: false,
      counted: false,
      message: `Couldn't search the mailbox: ${found.error.replace(/\.$/, "")}`,
      ms,
      detail: { kind: "reply", match: null, error: found.error },
    };
  }
  const hit = found.messages.find((m) => answers(m, q.config));
  if (!hit) {
    return {
      passed: false,
      counted: true,
      message: "No reply yet",
      ms,
      detail: { kind: "reply", match: null, error: null },
    };
  }
  const match = {
    id: String(hit.id ?? ""),
    from: String(hit.from ?? ""),
    subject: String(hit.subject ?? ""),
    date: String(hit.date ?? ""),
  };
  return {
    passed: true,
    counted: true,
    message: `${match.from || "Someone"} replied${match.subject ? `: ${match.subject}` : ""}`.slice(
      0,
      300,
    ),
    ms,
    detail: { kind: "reply", match, error: null },
  };
}
