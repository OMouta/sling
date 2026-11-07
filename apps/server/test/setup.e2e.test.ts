/**
 * The chat changing Sling's own setup, end to end: real Postgres, the control
 * plane in-process, and a scripted mock model that calls the setup tools. A
 * test connector stands in for a mail account: its setup lookup finds the
 * server from the address, and its connection test takes one password.
 *
 * Needs Docker.
 */
import { type AddressInfo, createServer } from "node:net";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { defineConnector } from "@sling/connector-sdk";
import type {
  CommandApprovalView,
  InstallationView,
  LiveReplyView,
  MessageView,
  PermissionMode,
  PersonalityView,
  ServerEvent,
  ToolStep,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Config } from "../src/config.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { readCredentials } from "../src/workflows/connectors/installations.ts";

vi.setConfig({ testTimeout: 60_000 });

const RIGHT = "correct-vault-app-password";
const WRONG = "wrong-vault-password-123";
const HOOK = "https://api.render.example/deploy/srv-abc123?key=hook-secret-xyz";

// ---------------------------------------------------------------- a connector

const vault = defineConnector({
  id: "vault",
  name: "Vault",
  description: "A mail account, for tests.",
  credentialsSchema: z.object({
    address: z.string().min(3).meta({ title: "Address", order: 0 }),
    server: z.string().min(1).meta({ title: "Server", advanced: true, order: 2 }),
    password: z.string().min(1).meta({ title: "Password", order: 1 }),
  }),
  secretFields: ["password"],
  configSchema: z.object({ folder: z.string().default("INBOX").meta({ title: "Folder" }) }),
  async setup({ credentials }) {
    const domain = credentials.address?.split("@")[1];
    if (!domain) return {};
    return {
      name: credentials.address,
      credentials: { server: `mail.${domain}` },
      notes: [
        { field: "address", tone: "ok", text: `Found mail.${domain}` },
        {
          field: "password",
          tone: "info",
          text: "Vault needs an app password.",
          link: { label: "Make one", url: "https://vault.example/app-passwords" },
        },
      ],
    };
  },
  // A refused login echoes the password, as a careless server might.
  test: async ({ credentials }) =>
    credentials.password === RIGHT
      ? { ok: true, detail: "Logged in." }
      : {
          ok: false,
          error: `Login refused for ${credentials.address} with ${credentials.password}`,
        },
  nodes: [],
});

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

/** The tool call the assistant makes for the next user message. */
const plan: { tool: string; input: Record<string, unknown> }[] = [];
/** What the model was handed back after each tool call. */
const toolResults: string[] = [];
const offered: string[][] = [];

const model = new MockLanguageModelV4({
  doStream: async (options: LanguageModelV4CallOptions) => {
    offered.push((options.tools ?? []).map((t) => t.name));
    const last = options.prompt.at(-1);
    if (last?.role === "tool") {
      toolResults.push(JSON.stringify(last.content));
      return text("Done.");
    }
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
let server: RunningServer;
let cookie = "";
let origin = "";
const published: ServerEvent[] = [];

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => ok(port));
    });
  });
}

async function call(method: string, path: string, body?: unknown) {
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
  const t = await res.text();
  return { status: res.status, body: (t ? JSON.parse(t) : null) as unknown };
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await call(method, path, body);
  if (res.status >= 400) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as T;
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 20_000,
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
  messages: MessageView[];
  live: LiveReplyView | null;
}

const detail = (id: string) => api<Detail>("GET", `/api/conversations/${id}`);

async function conversation(mode: PermissionMode) {
  const conv = await api<{ id: string }>("POST", "/api/conversations");
  await api("PATCH", `/api/conversations/${conv.id}`, { mode });
  return conv.id;
}

/** Sends a message that makes the assistant call `tool`. Returns how many messages came before. */
async function send(id: string, tool: string, input: Record<string, unknown>) {
  plan.push({ tool, input });
  const before = (await detail(id)).messages.length;
  await api("POST", `/api/conversations/${id}/messages`, { text: `Please use ${tool}.` });
  return before;
}

/** The reply's tool step, once the reply is saved. */
async function reply(id: string, before: number): Promise<ToolStep> {
  const m = await until("the reply", async () => {
    const d = await detail(id);
    return d.messages.slice(before).find((x) => x.role === "assistant");
  });
  const step = m.trace?.steps.find((s): s is ToolStep => s.kind === "tool");
  if (!step) throw new Error(`no tool step in: ${m.text}`);
  return step;
}

/** The change card waiting in the live reply. */
async function card(id: string): Promise<{ step: ToolStep; approval: CommandApprovalView }> {
  const step = await until("the change card", async () => {
    const live = (await detail(id)).live;
    return live?.steps.find(
      (s): s is ToolStep => s.kind === "tool" && s.approval?.state === "pending",
    );
  });
  if (step.approval?.kind !== "change") throw new Error("not a change");
  return { step, approval: step.approval };
}

const decide = (id: string, approvalId: string, decision: "approve" | "deny", secrets?: object) =>
  call("POST", `/api/conversations/${id}/commands/${approvalId}`, {
    decision,
    ...(secrets ? { secrets } : {}),
  });

const result = (step: ToolStep) => JSON.parse(step.output ?? "null") as Record<string, unknown>;

async function changes() {
  const rows = await server.ctx.db
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.verb, "assistant.change"));
  return rows.map((r) => ({ subjectId: r.subjectId, ...(r.details as Record<string, unknown>) }));
}

/** Every row of every table except encrypted credentials, as text. */
async function everything(): Promise<string> {
  const tables = await server.ctx.db.execute<{ name: string }>(
    sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_name <> 'credentials'`,
  );
  const out: string[] = [];
  for (const t of tables.rows) {
    const rows = await server.ctx.db.execute(
      sql`select row_to_json(x)::text as j from ${sql.identifier(t.name)} x`,
    );
    for (const r of rows.rows as { j: string }[]) out.push(r.j);
  }
  return out.join("\n");
}

const typesPublished = () => new Set(published.map((e) => e.type));

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL(origin),
    secretKey: "setup-e2e-secret-key-that-is-long-enough-1",
    host: "127.0.0.1",
    port,
    logLevel: "warn",
    webDist: undefined,
  };
  server = await startServer(config, { model, jobs: false, connectors: [vault] });
  await api("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
  const publish = server.ctx.hub.publish.bind(server.ctx.hub);
  vi.spyOn(server.ctx.hub, "publish").mockImplementation((ws, ev) => {
    published.push(ev);
    return publish(ws, ev);
  });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await server?.close();
  await pg?.stop();
});

describe("the default personality", () => {
  it("can change Sling's setup", async () => {
    const [p] = await api<PersonalityView[]>("GET", "/api/personalities");
    expect(p?.tools).toContain("setup");
    const id = await conversation("auto");
    await reply(id, await send(id, "read_setup", { section: "apps" }));
    expect(offered.at(-1)).toEqual(
      expect.arrayContaining(["read_setup", "save_app_account", "change_settings"]),
    );
  });
});

describe("connecting an app account", () => {
  it("reads in Read-only, and refuses to change anything", async () => {
    const id = await conversation("read-only");
    const read = await reply(id, await send(id, "read_setup", { section: "apps" }));
    const apps = result(read) as {
      connectors: { id: string; credentials: { key: string; title: string; secret?: boolean }[] }[];
    };
    const v = apps.connectors.find((c) => c.id === "vault");
    expect(v?.credentials).toEqual([
      { key: "address", title: "Address", required: true },
      { key: "password", title: "Password", secret: true, required: true },
      { key: "server", title: "Server", required: true, advanced: true },
    ]);

    const step = await reply(
      id,
      await send(id, "save_app_account", {
        connector: "vault",
        credentials: { address: "ana@vault.example" },
      }),
    );
    expect(result(step).error).toContain("Read-only");
    expect(step.approval).toBeUndefined();
    expect(await api<InstallationView[]>("GET", "/api/installations")).toEqual([]);
    expect((await changes()).at(-1)).toMatchObject({ decision: "refused", ok: false });
  });

  it("asks in Supervised, takes the password on the card, and keeps it out of everything", async () => {
    const id = await conversation("supervised");
    // The model passes a password it shouldn't have. It's never used, and doesn't stay.
    const before = await send(id, "save_app_account", {
      connector: "vault",
      credentials: { address: "ana@vault.example", password: "leaked-by-the-model" },
    });
    const { step, approval } = await card(id);
    expect(step.input).toEqual({
      connector: "vault",
      credentials: { address: "ana@vault.example" },
    });
    expect(approval.change).toEqual({
      title: "Connect ana@vault.example?",
      doing: "Connecting ana@vault.example",
      done: "Connected ana@vault.example",
      rows: [
        { label: "App", after: "Vault" },
        { label: "Name", after: "ana@vault.example" },
        { label: "Address", after: "ana@vault.example" },
        { label: "Server", after: "mail.vault.example" },
        { label: "Folder", after: "INBOX" },
      ],
      secrets: [
        {
          key: "password",
          label: "Password",
          required: true,
          placeholder: "Vault needs an app password.",
          link: { label: "Make one", url: "https://vault.example/app-passwords" },
        },
      ],
    });

    // The card takes only what it asked for, and needs the password.
    expect((await decide(id, approval.id, "approve", { token: "x" })).status).toBe(400);
    expect((await decide(id, approval.id, "approve", {})).status).toBe(400);
    expect((await decide(id, approval.id, "approve", { password: RIGHT })).status).toBe(200);

    const done = await reply(id, before);
    expect(done.status).toBe("done");
    expect(done.approval?.state).toBe("approved");
    expect(result(done)).toMatchObject({
      applied: true,
      account: { name: "ana@vault.example", connector: "vault", enabled: true },
      test: "Logged in.",
      found: ["Found mail.vault.example"],
    });

    const [inst] = await api<InstallationView[]>("GET", "/api/installations");
    expect(inst).toMatchObject({ name: "ana@vault.example", connectorId: "vault" });
    const [row] = await server.ctx.db
      .select()
      .from(schema.connectorInstallations)
      .where(eq(schema.connectorInstallations.id, inst?.id ?? ""));
    expect(await readCredentials(server.ctx, row as never)).toEqual({
      address: "ana@vault.example",
      server: "mail.vault.example",
      password: RIGHT,
    });
    expect(typesPublished().has("installation.updated")).toBe(true);
    expect((await changes()).at(-1)).toMatchObject({
      subjectId: inst?.id,
      tool: "save_app_account",
      decision: "approved",
      ok: true,
      secretFields: ["password"],
    });

    // What was typed on the card isn't in the trace, the result, what the model
    // heard, the audit, or any other table.
    const all = await everything();
    expect(all).toContain("ana@vault.example");
    expect(all).not.toContain(RIGHT);
    expect(toolResults.join("\n")).not.toContain(RIGHT);
    // What the model passed itself stays only in its own message: never used, and not in the trace.
    expect(JSON.stringify(done)).not.toContain("leaked-by-the-model");
    expect(JSON.stringify(await changes())).not.toContain("leaked-by-the-model");
  });

  it("shows a failed connection test as the error, with the password taken out, and saves nothing", async () => {
    const id = await conversation("auto");
    const before = await send(id, "save_app_account", {
      connector: "vault",
      credentials: { address: "bo@vault.example" },
    });
    const { approval } = await card(id);
    await decide(id, approval.id, "approve", { password: WRONG });
    const step = await reply(id, before);
    expect(result(step).error).toBe(
      "The connection test failed: Login refused for bo@vault.example with [redacted]",
    );
    expect((await api<InstallationView[]>("GET", "/api/installations")).map((i) => i.name)).toEqual(
      ["ana@vault.example"],
    );
    expect((await changes()).at(-1)).toMatchObject({ decision: "approved", ok: false });
    expect(await everything()).not.toContain(WRONG);
  });

  it("takes a new password on the card, and tests it before saving", async () => {
    const id = await conversation("auto");
    const before = await send(id, "save_app_account", {
      account: "ana@vault.example",
      newSecrets: true,
    });
    const { approval } = await card(id);
    expect(approval.change).toMatchObject({
      title: "Change ana@vault.example?",
      rows: [],
      secrets: [{ key: "password", label: "New password", required: true }],
    });
    await decide(id, approval.id, "approve", { password: WRONG });
    expect(result(await reply(id, before)).error).toBe(
      "The connection test failed: Login refused for ana@vault.example with [redacted]",
    );
    const [row] = await server.ctx.db.select().from(schema.connectorInstallations);
    expect((await readCredentials(server.ctx, row as never)).password).toBe(RIGHT);
  });

  it("turns an account off with one Apply", async () => {
    const id = await conversation("auto");
    const before = await send(id, "save_app_account", {
      account: "ana@vault.example",
      enabled: false,
    });
    const { approval } = await card(id);
    expect(approval.change).toMatchObject({
      title: "Turn off ana@vault.example?",
      rows: [{ label: "On", before: "On", after: "Off" }],
      secrets: [],
    });
    await decide(id, approval.id, "approve");
    expect(result(await reply(id, before))).toMatchObject({ account: { enabled: false } });
  });
});

describe("cancelling", () => {
  it("changes nothing", async () => {
    const id = await conversation("supervised");
    const count = (await api<PersonalityView[]>("GET", "/api/personalities")).length;
    const before = await send(id, "save_personality", {
      name: "Gardener",
      instructions: "You are Gardener. You help with plants.",
    });
    const { approval } = await card(id);
    await decide(id, approval.id, "deny");
    const step = await reply(id, before);
    expect(result(step).error).toContain("cancelled");
    expect(step.approval?.state).toBe("denied");
    expect(await api<PersonalityView[]>("GET", "/api/personalities")).toHaveLength(count);
    expect((await changes()).at(-1)).toMatchObject({
      tool: "save_personality",
      decision: "denied",
    });
  });
});

describe("Full access", () => {
  it("applies at once, still showing the change", async () => {
    const id = await conversation("full-access");
    const step = await reply(id, await send(id, "change_settings", { timeZone: "Europe/Lisbon" }));
    expect(result(step)).toMatchObject({ applied: true });
    expect(step.approval).toMatchObject({
      kind: "change",
      state: "approved",
      change: { rows: [{ label: "Time zone", before: "UTC", after: "Europe/Lisbon" }] },
    });
    expect((await api<{ timeZone: string }>("GET", "/api/settings")).timeZone).toBe(
      "Europe/Lisbon",
    );
    expect((await changes()).at(-1)).toMatchObject({ decision: "full_access", ok: true });
    expect(typesPublished().has("settings.updated")).toBe(true);
  });
});

describe("each kind of change", () => {
  it("adds a deploy target, with its hook URL typed on the card", async () => {
    const id = await conversation("auto");
    const before = await send(id, "save_deploy_target", {
      name: "Website",
      repo: "https://github.com/acme/site.git",
      method: "hook",
      checks: [{ url: "https://site.example/health", contains: "ok" }],
    });
    const { approval } = await card(id);
    expect(approval.change).toMatchObject({
      title: "Add deploy target Website?",
      rows: [
        { label: "Name", after: "Website" },
        { label: "Repo", after: "github.com/acme/site" },
        { label: "Deploys", after: "Deploy hook" },
        { label: "Hook", after: "POST" },
        { label: "Merge with", after: "Squash" },
        {
          label: "Health check",
          after: "https://site.example/health, answers 200–399, contains “ok”",
        },
      ],
      secrets: [{ key: "hookUrl", label: "Deploy hook URL", required: true }],
    });
    await decide(id, approval.id, "approve", { hookUrl: HOOK });
    const step = await reply(id, before);
    expect(result(step)).toMatchObject({
      applied: true,
      target: {
        name: "Website",
        repo: "github.com/acme/site",
        hook: { host: "api.render.example" },
      },
    });
    const target = await server.ctx.deploys.find((await workspace()).id, "Website");
    expect((await server.ctx.deploys.readHook(target as never))?.url).toBe(HOOK);
    expect(typesPublished().has("deploy_target.updated")).toBe(true);
    const all = await everything();
    expect(all).not.toContain("hook-secret-xyz");
    expect(all).not.toContain("srv-abc123");

    // A second target for the same repo is refused before the card asks for anything.
    const again = await reply(
      id,
      await send(id, "save_deploy_target", {
        name: "Site again",
        repo: "github.com/acme/site",
        method: "merge",
        checks: [{ url: "https://site.example/" }],
      }),
    );
    expect(result(again).error).toContain("already has a deploy target, Website");
    expect(again.approval).toBeUndefined();

    // Renaming it, with a new hook URL typed on the card.
    const NEW_HOOK = "https://api.render.example/deploy/srv-new456?key=hook-secret-new";
    const edit = await send(id, "save_deploy_target", {
      target: "Website",
      name: "Site",
      newHookUrl: true,
    });
    const c = await card(id);
    expect(c.approval.change).toMatchObject({
      title: "Change deploy target Website?",
      rows: [
        { label: "Name", before: "Website", after: "Site" },
        { label: "Hook", before: "POST to api.render.example", after: "POST to the new URL" },
      ],
      secrets: [{ key: "hookUrl", required: true }],
    });
    await decide(id, c.approval.id, "approve", { hookUrl: NEW_HOOK });
    expect(result(await reply(id, edit))).toMatchObject({ target: { name: "Site" } });
    const renamed = await server.ctx.deploys.find((await workspace()).id, "Site");
    expect((await server.ctx.deploys.readHook(renamed as never))?.url).toBe(NEW_HOOK);
    expect(await everything()).not.toContain("hook-secret-new");
  });

  it("adds a workflow from a template, on, then changes a step and publishes it", async () => {
    const id = await conversation("auto");
    const before = await send(id, "add_workflow", { template: "Site down alert" });
    const { approval } = await card(id);
    expect(approval.change?.rows).toEqual([
      { label: "Template", after: "Site down alert" },
      { label: "Name", after: "Site down alert" },
      { label: "On", after: "On" },
    ]);
    await decide(id, approval.id, "approve");
    const step = await reply(id, before);
    const added = result(step) as { workflow: { id: string; enabled: boolean } };
    expect(added.workflow.enabled).toBe(true);
    expect(typesPublished().has("workflow.updated")).toBe(true);

    const next = await send(id, "change_workflow", {
      workflow: "Site down alert",
      steps: [{ step: "A site changed", settings: { check: "Website" } }],
    });
    const c = await card(id);
    expect(c.approval.change?.rows).toEqual([
      { label: "A site changed: Check", before: "None", after: "Website" },
    ]);
    await decide(id, c.approval.id, "approve");
    expect(result(await reply(id, next))).toMatchObject({ applied: true, version: 2 });
    const wf = await api<{ active: { nodes: { id: string; config: Record<string, unknown> }[] } }>(
      "GET",
      `/api/workflows/${added.workflow.id}`,
    );
    expect(wf.active.nodes.find((n) => n.id === "changed")?.config.check).toBe("Website");

    const off = await send(id, "change_workflow", { workflow: "Site down alert", enabled: false });
    const o = await card(id);
    expect(o.approval.change).toMatchObject({
      title: "Turn off workflow Site down alert?",
      done: "Turned off Site down alert",
      rows: [{ label: "On", before: "On", after: "Off" }],
    });
    await decide(id, o.approval.id, "approve");
    expect(result(await reply(id, off))).toMatchObject({ workflow: { enabled: false } });
  });

  it("adds a personality", async () => {
    const id = await conversation("supervised");
    const before = await send(id, "save_personality", {
      name: "Gardener",
      description: "Plants and soil.",
      instructions: "You are Gardener. You help with plants.",
      tools: ["apps"],
      color: "green",
      shape: "bloom",
    });
    const { approval } = await card(id);
    expect(approval.change?.rows).toEqual([
      { label: "Name", after: "Gardener" },
      { label: "Description", after: "Plants and soil." },
      { label: "Instructions", after: "You are Gardener. You help with plants." },
      { label: "Tools", after: "Apps and workflows" },
      { label: "Look", after: "green, bloom" },
    ]);
    await decide(id, approval.id, "approve");
    await reply(id, before);
    const made = (await api<PersonalityView[]>("GET", "/api/personalities")).find(
      (p) => p.name === "Gardener",
    );
    expect(made).toMatchObject({ tools: ["apps"], color: "green", shape: "bloom" });
    expect(typesPublished().has("personality.updated")).toBe(true);

    const edit = await send(id, "save_personality", {
      personality: "gardener",
      tools: ["apps", "setup"],
      color: "teal",
    });
    const c = await card(id);
    expect(c.approval.change).toMatchObject({
      title: "Change personality Gardener?",
      rows: [
        {
          label: "Tools",
          before: "Apps and workflows",
          after: "Apps and workflows, Change Sling's setup",
        },
        { label: "Look", before: "green, bloom", after: "teal, bloom" },
      ],
    });
    await decide(id, c.approval.id, "approve");
    await reply(id, edit);
    const changed = (await api<PersonalityView[]>("GET", "/api/personalities")).find(
      (p) => p.name === "Gardener",
    );
    expect(changed).toMatchObject({
      description: "Plants and soil.",
      tools: ["apps", "setup"],
      color: "teal",
      revision: 2,
    });
    // The route keeps a description it wasn't sent, too.
    const patched = await api<PersonalityView>("PATCH", `/api/personalities/${changed?.id}`, {
      color: "rose",
    });
    expect(patched).toMatchObject({ description: "Plants and soil.", color: "rose" });
  });

  it("changes settings, and the sandbox list", async () => {
    const id = await conversation("auto");
    const before = await send(id, "change_settings", {
      defaultMode: "supervised",
      notifications: { replies: false },
      sandboxes: { concurrentLimit: 3 },
      allowInSandboxes: [{ repo: "github.com/acme/site", network: true }],
    });
    const { approval } = await card(id);
    expect(approval.change?.rows).toEqual([
      { label: "New chats start in", before: "Auto", after: "Supervised" },
      { label: "Push for replies", before: "On", after: "Off" },
      { label: "Sandboxes at once", before: "2", after: "3" },
      {
        label: "In sandboxes: github.com/acme/site",
        before: "Not allowed",
        after: "main, with network",
      },
    ]);
    await decide(id, approval.id, "approve");
    expect(result(await reply(id, before))).toMatchObject({ applied: true });
    const s = await api<{ defaultMode: string; notifications: { replies: boolean } }>(
      "GET",
      "/api/settings",
    );
    expect(s.defaultMode).toBe("supervised");
    expect(s.notifications.replies).toBe(false);
    expect(
      (await api<{ concurrentLimit: number }>("GET", "/api/settings/sandboxes")).concurrentLimit,
    ).toBe(3);
    expect(await api("GET", "/api/sandbox-repos")).toEqual([
      expect.objectContaining({ remoteKey: "github.com/acme/site", network: true }),
    ]);
  });
});

async function workspace() {
  const [ws] = await server.ctx.db.select().from(schema.workspaces);
  if (!ws) throw new Error("no workspace");
  return ws;
}
