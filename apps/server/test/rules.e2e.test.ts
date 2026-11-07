/**
 * Rules end to end: real Postgres, the control plane in-process, GreenMail
 * for email, the TypeScript Runner for a task's push and PR, and a scripted
 * mock model that calls the tools. Start rules are driven through
 * `rules.checkChanged`, the way the checks service calls it, with a check
 * row made here.
 *
 * Needs Docker.
 */
import { type AddressInfo, createServer } from "node:net";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type {
  AllowRuleView,
  CheckView,
  CommandApprovalView,
  ConversationView,
  LiveReplyView,
  MessageView,
  PermissionMode,
  RuleView,
  StartRuleView,
  TaskView,
  ToolStep,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { createEmailConnector } from "@sling/integration-email";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { and, asc, eq } from "drizzle-orm";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CheckChange } from "../src/checks/service.ts";
import type { Config } from "../src/config.ts";
import { Rules } from "../src/rules/service.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { FakeRunner } from "./fixtures/fake-runner.ts";

vi.setConfig({ testTimeout: 90_000 });

// ---------------------------------------------------------------- mock model

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function respond(parts: LanguageModelV4StreamPart[], reason: "stop" | "tool-calls") {
  return {
    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
      { type: "stream-start", warnings: [] },
      ...parts,
      { type: "finish", finishReason: { unified: reason, raw: undefined }, usage },
    ]),
  };
}

const text = (t: string) =>
  respond(
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: t },
      { type: "text-end", id: "t" },
    ],
    "stop",
  );

function textOf(m: LanguageModelV4CallOptions["prompt"][number] | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) => ("text" in p && typeof p.text === "string" ? p.text : "")).join("");
}

/** The tool call the assistant makes for the next message. */
const plan: { tool: string; input: Record<string, unknown> }[] = [];
/** What each model call was told: the system prompt and every user-side message. */
const calls: { system: string; users: string[] }[] = [];

const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    const users = options.prompt.filter((m) => m.role === "user").map(textOf);
    calls.push({ system: textOf(options.prompt.find((m) => m.role === "system")), users });
    if (options.prompt.at(-1)?.role === "tool") return text("Done.");
    if (users.at(-1)?.includes("Find out why")) return text("Looking into it.");
    const next = plan.shift();
    if (!next) return text("Nothing to do.");
    return respond(
      [
        {
          type: "tool-call",
          toolCallId: `call_${newId("c")}`,
          toolName: next.tool,
          input: JSON.stringify(next.input),
        },
      ],
      "tool-calls",
    );
  },
});

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let mail: StartedTestContainer;
let server: RunningServer;
let machine: FakeRunner;
let cookie = "";
let origin = "";
let workspaceId = "";
let userId = "";
let emailId = "";

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => ok(port));
    });
  });
}

async function raw(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(server.url + path, {
    method,
    headers: {
      origin,
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.getSetCookie();
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  return res;
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await raw(method, path, body);
  const t = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${t}`);
  return (t ? JSON.parse(t) : null) as T;
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 30_000,
) {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

interface Detail {
  conversation: ConversationView;
  messages: MessageView[];
  live: LiveReplyView | null;
}

const detail = (id: string) => api<Detail>("GET", `/api/conversations/${id}`);

async function conversation(mode: PermissionMode) {
  const conv = await api<{ id: string }>("POST", "/api/conversations");
  await api("PATCH", `/api/conversations/${conv.id}`, { mode });
  return conv.id;
}

/** Sends a message that makes the assistant call `tool`, and resolves with that call's step. */
async function ask(id: string, tool: string, input: Record<string, unknown>): Promise<ToolStep> {
  plan.push({ tool, input });
  const before = (await detail(id)).messages.length;
  await api("POST", `/api/conversations/${id}/messages`, { text: `Please use ${tool}.` });
  const reply = await until("the reply", async () => {
    const d = await detail(id);
    return d.messages.slice(before).find((m) => m.role === "assistant");
  });
  const step = reply.trace?.steps.find((s): s is ToolStep => s.kind === "tool");
  if (!step) throw new Error(`no tool step in: ${reply.text}`);
  return step;
}

/** The live reply's question, once it asks. */
async function pending(id: string): Promise<CommandApprovalView> {
  const step = await until("the question", async () => {
    const live = (await detail(id)).live;
    return live?.steps.find(
      (s): s is ToolStep => s.kind === "tool" && s.approval?.state === "pending",
    );
  });
  if (!step.approval) throw new Error("no approval");
  return step.approval;
}

async function decide(id: string, approval: CommandApprovalView, decision: "approve" | "deny") {
  await api("POST", `/api/conversations/${id}/commands/${approval.id}`, { decision });
}

/** Sends an email from chat, answers its question if it asks, and returns the step. */
async function email(
  mode: PermissionMode,
  to: string,
  answer?: "approve" | "deny",
): Promise<{ step: ToolStep; asked: CommandApprovalView | null }> {
  const id = await conversation(mode);
  const done = ask(id, "email_send", { to, subject: `Hello (${mode})`, text: "Hi." });
  let asked: CommandApprovalView | null = null;
  if (answer) {
    asked = await pending(id);
    await decide(id, asked, answer);
  }
  return { step: await done, asked };
}

const result = (step: ToolStep) =>
  JSON.parse(step.output ?? "null") as { error?: string; output?: Record<string, unknown> };

async function audits(verb: string): Promise<(Record<string, unknown> & { subjectId: string })[]> {
  const rows = await server.ctx.db
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.verb, verb))
    .orderBy(asc(schema.auditEvents.at), asc(schema.auditEvents.id));
  return rows.map((r) => ({ ...(r.details as Record<string, unknown>), subjectId: r.subjectId }));
}

const rules = () => api<RuleView[]>("GET", "/api/rules");
const rule = async (id: string) => (await rules()).find((r) => r.id === id);
const task = (id: string) => api<{ task: TaskView }>("GET", `/api/tasks/${id}`).then((d) => d.task);

beforeAll(async () => {
  [pg, mail] = await Promise.all([
    new PostgreSqlContainer("postgres:18-alpine").start(),
    new GenericContainer("greenmail/standalone:2.1.15")
      .withEnvironment({
        GREENMAIL_OPTS: [
          "-Dgreenmail.setup.test.smtp",
          "-Dgreenmail.setup.test.imap",
          "-Dgreenmail.hostname=0.0.0.0",
          "-Dgreenmail.users.login=email",
          "-Dgreenmail.users=inbox:secret@example.com",
        ].join(" "),
      })
      .withExposedPorts(3025, 3143)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL(origin),
    secretKey: "rules-e2e-secret-key-that-is-long-enough-1",
    host: "127.0.0.1",
    port,
    logLevel: "warn",
    webDist: undefined,
  };
  server = await startServer(config, { model, jobs: false, connectors: [createEmailConnector()] });
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
  const [m] = await server.ctx.db.select().from(schema.workspaceMembers).limit(1);
  if (!m) throw new Error("no workspace");
  workspaceId = m.workspaceId;
  userId = m.userId;

  const host = mail.getHost();
  emailId = (
    await api<{ id: string }>("POST", "/api/installations", {
      connectorId: "email",
      name: "Work",
      credentials: {
        imapHost: host,
        imapPort: mail.getMappedPort(3143),
        imapSecure: false,
        smtpHost: host,
        smtpPort: mail.getMappedPort(3025),
        smtpSecure: false,
        username: "inbox@example.com",
        password: "secret",
        fromAddress: "inbox@example.com",
      },
      config: { folders: ["INBOX"] },
    })
  ).id;

  const { code } = await api<{ code: string }>("POST", "/api/runners/enrollments");
  machine = new FakeRunner({
    url: server.url,
    name: "laptop",
    repos: [{ name: "site", remoteUrl: "https://github.com/acme/site.git", defaultBranch: "main" }],
    harnesses: ["codex"],
  });
  await machine.pair(code);
  await machine.connect();
  // A machine answers a step after a network round trip. The stand-in Runner
  // answers in the same process, which can beat the server marking the step
  // as sent, so its step requests get the round trip here.
  const send = server.ctx.runners.send.bind(server.ctx.runners);
  server.ctx.runners.send = (runnerId, envelope) => {
    if (envelope.body.case !== "actionRequest") return send(runnerId, envelope);
    setTimeout(() => send(runnerId, envelope), 30);
    return true;
  };
}, 180_000);

afterAll(async () => {
  machine?.close();
  await server?.close();
  await Promise.all([pg?.stop(), mail?.stop()]);
});

// ---------------------------------------------------------------- allow rules

describe("allow rules on sends from chat", () => {
  let ruleId = "";

  it("offers Always allow with the rule it would make", async () => {
    const id = await conversation("supervised");
    const done = ask(id, "email_send", {
      to: "Ana <ana@acme.com>",
      subject: "Lunch",
      text: "Moved to 13:00.",
    });
    const asked = await pending(id);
    expect(asked.ruleOffer).toEqual({
      summary: "Email to anyone at acme.com",
      rule: {
        kind: "allow",
        action: "email.send",
        installationId: emailId,
        match: { to: "*@acme.com" },
        conversationId: id,
      },
      streak: 0,
    });
    // Always allow: the card makes the rule, then allows this one.
    const made = await api<AllowRuleView>("POST", "/api/rules", {
      ...asked.ruleOffer?.rule,
      approvalId: asked.id,
    });
    expect(made).toMatchObject({
      kind: "allow",
      summary: "Email to anyone at acme.com",
      action: "email.send",
      installationId: emailId,
      installationName: "Work",
      match: { to: "*@acme.com" },
      createdFrom: { approvalId: asked.id, conversationId: id },
      uses: 0,
      revokedAt: null,
    });
    ruleId = made.id;
    // A second click makes nothing new.
    const again = await api<AllowRuleView>("POST", "/api/rules", asked.ruleOffer?.rule);
    expect(again.id).toBe(ruleId);
    await decide(id, asked, "approve");
    expect((await done).approval?.state).toBe("approved");

    const created = (await audits("rule.created")).filter((a) => a.subjectId === ruleId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: "allow", summary: "Email to anyone at acme.com" });
  });

  it("lets matching sends through in Supervised and Auto", async () => {
    for (const mode of ["supervised", "auto"] as const) {
      const { step } = await email(mode, "bo@acme.com");
      expect(step.approval).toMatchObject({
        kind: "send",
        state: "approved",
        allowedBy: { ruleId, summary: "Email to anyone at acme.com" },
      });
      expect(step.approval?.ruleOffer).toBeUndefined();
      expect(result(step).error).toBeUndefined();
      expect(result(step).output?.messageId).toBeTruthy();
    }
    const actions = (await audits("assistant.action")).filter((a) => a.decision === "rule");
    expect(actions).toHaveLength(2);
    for (const a of actions) expect(a).toMatchObject({ ruleId, nodeType: "email.send", ok: true });
    const used = (await audits("rule.used")).filter((a) => a.subjectId === ruleId);
    expect(used).toHaveLength(2);
    expect(used[0]).toMatchObject({ action: "email.send", installationId: emailId });
    expect((await rule(ruleId))?.uses).toBe(2);
  });

  it("is still refused in Read-only, and Full access doesn't use it", async () => {
    const readOnly = await email("read-only", "bo@acme.com");
    expect(result(readOnly.step).error).toMatch(/Read-only/);
    const full = await email("full-access", "bo@acme.com");
    expect(full.step.approval).toBeUndefined();
    expect(result(full.step).error).toBeUndefined();
    expect((await rule(ruleId))?.uses).toBe(2);
  });

  it("asks for a send it doesn't cover", async () => {
    const other = await email("supervised", "eve@evil.io", "deny");
    expect(other.asked?.ruleOffer?.summary).toBe("Email to anyone at evil.io");
    // Two recipients, one of them outside the rule.
    const mixed = await email("auto", "ana@acme.com, eve@evil.io", "deny");
    expect(mixed.asked?.ruleOffer?.rule.match).toEqual({ to: "*@acme.com, *@evil.io" });
    // A public mail provider pins the address, not everyone there.
    const gmail = await email("supervised", "jo@gmail.com", "deny");
    expect(gmail.asked?.ruleOffer?.summary).toBe("Email to jo@gmail.com");
  });

  it("asks again once it's revoked", async () => {
    const revoked = await api<RuleView>("DELETE", `/api/rules/${ruleId}`);
    expect(revoked.revokedAt).toBeTruthy();
    expect((await audits("rule.revoked")).filter((a) => a.subjectId === ruleId)).toHaveLength(1);
    const { asked } = await email("supervised", "bo@acme.com", "deny");
    expect(asked?.state).toBe("pending");
    // Revoking twice answers with the rule as it is.
    expect((await api<RuleView>("DELETE", `/api/rules/${ruleId}`)).revokedAt).toBe(
      revoked.revokedAt,
    );
    expect((await raw("DELETE", "/api/rules/rul_nope")).status).toBe(404);
  });

  it("says how many times in a row it was allowed, and starts over after a denial", async () => {
    // The last answer above was a denial.
    for (let n = 0; n < 5; n++) {
      const { asked } = await email("supervised", "x@other.org", "approve");
      expect(asked?.ruleOffer?.streak).toBe(n);
    }
    const sixth = await email("auto", "y@other.org", "deny");
    expect(sixth.asked?.ruleOffer?.streak).toBe(5);
    const after = await email("supervised", "x@other.org", "deny");
    expect(after.asked?.ruleOffer?.streak).toBe(0);
  });
});

describe("what never matches", () => {
  it("refuses rules for merges, deploys, commands, setup changes, and saving a rule", async () => {
    for (const action of [
      "merge",
      "deploy",
      "run_command",
      "deploy_task",
      "save_rule",
      "save_deploy_target",
      "change_settings",
      "email.read",
      "nope.send",
    ]) {
      const res = await raw("POST", "/api/rules", { kind: "allow", action });
      expect(res.status, action).toBe(400);
    }
    // Only the fields the node names can be pinned.
    const subject = await raw("POST", "/api/rules", {
      kind: "allow",
      action: "email.send",
      match: { subject: "Invoice" },
    });
    expect(subject.status).toBe(400);
    expect(await subject.text()).toMatch(/can pin to, not subject/);
    const star = await raw("POST", "/api/rules", {
      kind: "allow",
      action: "email.send",
      match: { to: "a*@acme.com" },
    });
    expect(star.status).toBe(400);
  });

  it("never matches a rule for one, even one written straight into the database", async () => {
    for (const action of ["merge", "deploy", "run_command", "save_rule", "change_settings"]) {
      await server.ctx.db.insert(schema.rules).values({
        id: newId("rul"),
        workspaceId,
        ownerId: userId,
        kind: "allow",
        summary: `Forged ${action}`,
        action,
        match: {},
      });
    }
    const fresh = new Rules(server.ctx);
    for (const action of ["merge", "deploy", "run_command", "save_rule", "change_settings"]) {
      for (const mode of ["supervised", "auto", "full-access"] as const) {
        const call = {
          workspaceId,
          ownerId: userId,
          action,
          installationId: null,
          args: {},
          mode,
          conversationId: null,
        };
        expect(await fresh.allowing(call), `${action} in ${mode}`).toBeNull();
        expect(await fresh.offer(call)).toBeNull();
      }
    }
    await server.ctx.db.delete(schema.rules).where(eq(schema.rules.summary, "Forged merge"));
  });
});

describe("allow rules on a task's push and PR", () => {
  async function prTask(title: string) {
    const created = await api<{ id: string }>("POST", "/api/tasks", {
      repo: "site",
      title,
      objective: "Make the footer year dynamic.",
      deliver: "pr",
      mode: "supervised",
    });
    await until("the task to succeed", async () => (await task(created.id)).state === "succeeded");
    return created.id;
  }

  it("lets the push go without asking once Always allow made a rule, and the PR still asks", async () => {
    const first = await prTask("Fix the footer year");
    const waiting = await until("both approvals", async () => {
      const list = await api<
        { id: string; taskId: string; actionKind: string; ruleOffer?: AllowRuleView }[]
      >("GET", "/api/approvals");
      const mine = list.filter((a) => a.taskId === first);
      return mine.length === 2 ? mine : null;
    });
    const push = waiting.find((a) => a.actionKind === "push") as unknown as {
      id: string;
      ruleOffer: { summary: string; rule: Record<string, unknown>; streak: number };
    };
    const pr = waiting.find((a) => a.actionKind === "open_pr") as unknown as typeof push;
    expect(push.ruleOffer).toEqual({
      summary: "Pushing task branches to acme/site",
      rule: {
        kind: "allow",
        action: "push",
        installationId: null,
        match: { repo: "github.com/acme/site" },
        approvalId: push.id,
      },
      streak: 0,
    });
    expect(pr.ruleOffer.summary).toBe("Opening pull requests on acme/site");

    const made = await api<AllowRuleView>("POST", "/api/rules", push.ruleOffer.rule);
    await api("POST", `/api/tasks/${first}/approval`, { decision: "approve" });
    await until("the first task delivered", async () =>
      (await task(first)).actions.every((a) => a.state === "succeeded"),
    );

    const second = await prTask("Fix the header year");
    const t = await until("the push to go and the PR to ask", async () => {
      const v = await task(second);
      const pushed = v.actions.find((a) => a.kind === "push");
      const asks = v.actions.find((a) => a.kind === "open_pr");
      return pushed?.state === "succeeded" && asks?.state === "awaiting_approval" ? v : null;
    });
    expect(t.actions.find((a) => a.kind === "push")?.requiresApproval).toBe(false);
    const used = (await audits("rule.used")).filter((a) => a.subjectId === made.id);
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ action: "push", taskId: second });
    expect(used[0]?.actionId).toBe(t.actions.find((a) => a.kind === "push")?.id);
    const asking = (await api<{ taskId: string; actionKind: string }[]>("GET", "/api/approvals"))
      .filter((a) => a.taskId === second)
      .map((a) => a.actionKind);
    expect(asking).toEqual(["open_pr"]);
    await api("POST", `/api/tasks/${second}/approval`, { decision: "reject" });
  });
});

// ---------------------------------------------------------------- start rules

describe("start rules", () => {
  let checkId = "";
  let incidentId = "";

  function siteCheck(state: CheckView["state"]): CheckView {
    return {
      id: checkId,
      name: "Website",
      kind: "site",
      config: {
        kind: "site",
        checks: [{ url: "https://acme.test/health", status: null, contains: null }],
        versionUrl: null,
      },
      enabled: true,
      intervalSeconds: 60,
      deadline: null,
      runnerId: null,
      runnerName: null,
      installationId: null,
      installationName: null,
      state,
      stateSince: new Date().toISOString(),
      failures: state === "down" ? 2 : 0,
      lastResult: null,
      nextRunAt: null,
      notify: true,
      deploy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function change(from: CheckView["state"], to: CheckView["state"]): CheckChange {
    const passed = to === "up";
    return {
      workspaceId,
      ownerId: userId,
      check: siteCheck(to),
      from,
      result: {
        id: newId("chr"),
        checkId,
        at: new Date().toISOString(),
        passed,
        state: to,
        message: passed ? "Answered 200" : "https://acme.test/health answered 503",
        ms: 140,
        detail: {
          kind: "site",
          checks: [
            {
              url: "https://acme.test/health",
              ok: passed,
              status: passed ? 200 : 503,
              ms: 140,
              error: passed ? null : "wanted 200–399",
            },
          ],
          versionSeen: null,
        },
      },
    };
  }

  beforeAll(async () => {
    checkId = newId("chk");
    await server.ctx.db.insert(schema.checks).values({
      id: checkId,
      workspaceId,
      ownerId: userId,
      kind: "site",
      name: "Website",
      config: {
        kind: "site",
        checks: [{ url: "https://acme.test/health", status: null, contains: null }],
        versionUrl: null,
      },
      intervalSeconds: 60,
    });
    incidentId = (await api<{ id: string }>("POST", "/api/personalities/templates/incident")).id;
  });

  it("refuses Full access, and an event the check can't have", async () => {
    const full = await raw("POST", "/api/rules", {
      kind: "start",
      checkId,
      on: "down",
      message: "Look.",
      mode: "full-access",
    });
    expect(full.status).toBe(400);
    const met = await raw("POST", "/api/rules", {
      kind: "start",
      checkId,
      on: "met",
      message: "Look.",
      mode: "auto",
    });
    expect(met.status).toBe(400);
    expect(await met.text()).toMatch(/goes up and down/);
  });

  it("opens a chat when the check goes down and runs its first turn, once per 30 minutes", async () => {
    const made = await api<StartRuleView>("POST", "/api/rules", {
      kind: "start",
      checkId,
      on: "down",
      personalityId: incidentId,
      message: "{check} is down: {results}. Find out why.",
      mode: "auto",
    });
    expect(made).toMatchObject({
      kind: "start",
      summary: "When Website goes down, Incident investigates",
      checkName: "Website",
      on: "down",
      mode: "auto",
    });
    // Coming back up isn't going down, and a first pass isn't coming back up.
    expect(await server.ctx.rules.checkChanged(change("down", "up"))).toEqual([]);
    expect(await server.ctx.rules.checkChanged(change("unknown", "up"))).toEqual([]);

    const mark = calls.length;
    const started = await server.ctx.rules.checkChanged(change("up", "down"));
    expect(started).toHaveLength(1);
    expect(started[0]?.ruleId).toBe(made.id);
    const convId = started[0]?.conversationId as string;
    const d = await until("the first reply", async () => {
      const v = await detail(convId);
      return v.messages.some((m) => m.role === "assistant") ? v : null;
    });
    expect(d.conversation).toMatchObject({
      title: "Website went down",
      mode: "auto",
      personalityId: incidentId,
      startedBy: { kind: "rule", ruleId: made.id, checkId, checkName: "Website", on: "down" },
    });
    expect(d.messages.map((m) => [m.role, m.text.split("\n")[0]])).toEqual([
      ["system", "Website went down: https://acme.test/health answered 503"],
      ["user", "Website is down: https://acme.test/health answered 503. Find out why."],
      ["assistant", "Looking into it."],
    ]);
    // The turn had the check's results, marked as data.
    const turn = calls.slice(mark).find((c) => c.users.some((u) => u.includes("Find out why")));
    expect(turn?.users.join("\n")).toContain(
      "[Sling update] Website went down: https://acme.test/health answered 503",
    );
    expect(turn?.users.join("\n")).toContain(
      "- https://acme.test/health: answered 503 in 140 ms, wanted 200–399.",
    );
    expect(turn?.system).toContain("This conversation is in Auto mode");

    // Flapping opens nothing new for half an hour.
    expect(await server.ctx.rules.checkChanged(change("down", "up"))).toEqual([]);
    expect(await server.ctx.rules.checkChanged(change("up", "down"))).toEqual([]);
    // Two changes at once still make one chat.
    const both = await Promise.all([
      server.ctx.rules.checkChanged(change("up", "down")),
      server.ctx.rules.checkChanged(change("up", "down")),
    ]);
    expect(both.flat()).toEqual([]);
    const opened = await server.ctx.db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.workspaceId, workspaceId),
          eq(schema.conversations.title, "Website went down"),
        ),
      );
    expect(opened).toHaveLength(1);

    expect((await rule(made.id))?.uses).toBe(1);
    const used = (await audits("rule.used")).filter((a) => a.subjectId === made.id);
    expect(used).toEqual([
      expect.objectContaining({ kind: "start", action: "start_chat", conversationId: convId }),
    ]);
    await api("DELETE", `/api/rules/${made.id}`);
    expect(
      await server.ctx.rules.checkChanged({ ...change("up", "down"), check: siteCheck("down") }),
    ).toEqual([]);
  });

  it("covers every check when it names none", async () => {
    const made = await api<StartRuleView>("POST", "/api/rules", {
      kind: "start",
      checkId: null,
      on: "up",
      message: "{check} is back. Tell me what happened.",
      mode: "read-only",
    });
    expect(made.summary).toBe("When any check comes back up, Sling follows up");
    const started = await server.ctx.rules.checkChanged(change("down", "up"));
    expect(started.map((s) => s.ruleId)).toEqual([made.id]);
    const conv = await detail(started[0]?.conversationId as string);
    expect(conv.conversation.mode).toBe("read-only");
    await api("DELETE", `/api/rules/${made.id}`);
  });
});

// ---------------------------------------------------------------- from chat

describe("rules from chat", () => {
  it("shows save_rule's card in Full access and Read-only, and saves nothing until Apply", async () => {
    for (const [mode, decision] of [
      ["full-access", "approve"],
      ["read-only", "deny"],
    ] as const) {
      const id = await conversation(mode);
      const before = (await rules()).length;
      const done = ask(id, "save_rule", {
        kind: "allow",
        action: "email_send",
        match: { to: "*@acme.org" },
      });
      const card = await pending(id);
      expect(card.kind).toBe("change");
      expect(card.change?.title).toBe("Always allow this?");
      expect(card.change?.rows).toEqual([
        { label: "Rule", after: "Email to anyone at acme.org" },
        { label: "to", after: "*@acme.org" },
      ]);
      expect((await rules()).length).toBe(before);
      await decide(id, card, decision);
      const step = await done;
      const saved = (await rules()).filter(
        (r) => r.kind === "allow" && r.createdFrom.conversationId === id,
      );
      if (decision === "approve") {
        expect(step.approval?.state).toBe("approved");
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ summary: "Email to anyone at acme.org", uses: 0 });
        expect(JSON.parse(step.output ?? "{}")).toMatchObject({
          applied: true,
          rule: { summary: "Email to anyone at acme.org" },
        });
      } else {
        expect(saved).toHaveLength(0);
      }
    }
    const changes = (await audits("assistant.change")).filter((a) => a.tool === "save_rule");
    expect(changes.map((c) => c.decision)).toEqual(["approved", "denied"]);
  });

  it("makes a start rule from names", async () => {
    const id = await conversation("auto");
    const done = ask(id, "save_rule", {
      kind: "start",
      check: "website",
      on: "down",
      personality: "incident",
    });
    const card = await pending(id);
    expect(card.change?.title).toBe("Start work on its own?");
    expect(card.change?.rows).toEqual([
      { label: "Rule", after: "When Website goes down, Incident investigates" },
      { label: "Check", after: "Website" },
      { label: "When", after: "It goes down" },
      { label: "Who answers", after: "Incident" },
      { label: "Mode", after: "Auto" },
      {
        label: "First message",
        after: "{check} went down. Find out why, and tell me what you found and what you'd do.",
      },
    ]);
    await decide(id, card, "approve");
    await done;
    const saved = (await rules()).find(
      (r): r is StartRuleView => r.kind === "start" && r.createdFrom.conversationId === id,
    );
    expect(saved).toMatchObject({ on: "down", mode: "auto", checkName: "Website" });
  });

  it("says what it can't cover", async () => {
    const id = await conversation("auto");
    const step = await ask(id, "save_rule", { kind: "allow", action: "run_command" });
    expect(result(step).error).toMatch(/can't have an allow rule/);
    const prompt = calls.at(-1)?.system ?? "";
    expect(prompt).toContain("save_rule makes a standing answer");
  });
});
