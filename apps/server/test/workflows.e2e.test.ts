/**
 * Workflow engine end to end: real Postgres and pg-boss, the control plane
 * in-process, test nodes, a fake connector, and a scripted mock model. The
 * crash test runs a second server in a child process and SIGKILLs it.
 *
 * Needs Docker.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { NodeRunView, RunDetailView, RunView } from "@sling/core";
import { newId, taskBranch } from "@sling/core";
import { schema } from "@sling/db";
import type { WorkflowDefinition } from "@sling/workflow";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { NO_CHAT_WORKFLOW } from "../src/conversations/routes.ts";
import { drainDeliveries, RETRY_NOTE_AFTER, RETRYING_NOTE } from "../src/deliveries.ts";
import { type RunningServer, type StartOptions, startServer } from "../src/server.ts";
import { fireSchedule, SCHEDULE_QUEUE } from "../src/workflows/triggers.ts";
import { withinBudget } from "./fixtures/budget.ts";
import {
  calls,
  discordSent,
  fakeConnector,
  fakeDiscord,
  fakeSource,
  sideEffects,
  testNodes,
} from "./fixtures/nodes.ts";

const SECRET = "engine-test-secret-key-that-is-long-enough";

vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------- mock model

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function generated(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function userText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .filter((m) => m.role === "user")
    .map((m) => JSON.stringify(m.content))
    .join(" ");
}

/** Answers AI nodes by response format, and plays the assistant with a fixed reply. */
const model = new MockLanguageModelV4({
  doGenerate: async (options: LanguageModelV4CallOptions) => {
    const rf = options.responseFormat;
    if (rf?.type === "json") {
      const labels = (rf.schema as { properties?: { result?: { enum?: string[] } } } | undefined)
        ?.properties?.result?.enum;
      if (labels) {
        const text = userText(options).toLowerCase();
        return generated(
          JSON.stringify({ result: labels.find((l) => text.includes(`[${l}]`)) ?? labels.at(-1) }),
        );
      }
      return generated(JSON.stringify({ summary: "Lunch moved", actionItems: ["Reply to Ana"] }));
    }
    return generated(`Summary of: ${userText(options).slice(0, 40)}`);
  },
  doStream: async () => ({
    stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hi from Sling" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
    ]),
  }),
});

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let c: Client;
const extra: RunningServer[] = [];
let child: ChildProcess | null = null;

/** Browsers reach Sling here. Servers listen on port 0, so there's no race for a free port. */
const ORIGIN = "http://sling.test";

function configFor(databaseUrl: string): Config {
  return {
    databaseUrl,
    publicUrl: new URL(ORIGIN),
    secretKey: SECRET,
    host: "127.0.0.1",
    port: 0,
    logLevel: "warn",
    webDist: undefined,
  };
}

/** A fresh database in the same container, for tests that restart servers. */
async function freshDatabase(name: string): Promise<string> {
  await server.ctx.db.execute(sql.raw(`create database ${name}`));
  const url = new URL(pg.getConnectionUri());
  url.pathname = `/${name}`;
  return url.toString();
}

async function boot(databaseUrl: string, opts: StartOptions = {}): Promise<RunningServer> {
  return startServer(configFor(databaseUrl), {
    model,
    jobs: false,
    nodes: testNodes,
    connectors: [fakeConnector, fakeDiscord],
    ...opts,
  });
}

class Client {
  cookie = "";
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        origin: ORIGIN,
        cookie: this.cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie();
    if (set.length) this.cookie = set.map((s) => s.split(";")[0]).join("; ");
    return res;
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async signUp() {
    await this.call("POST", "/api/auth/sign-up/email", {
      name: "Admin",
      email: "admin@example.com",
      password: "correct-horse-battery",
    });
  }
}

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 15_000,
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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ""}`);
}

// ---------------------------------------------------------------- definitions

interface Node {
  id: string;
  type: string;
  version: number;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}
let seq = 0;
const n = (id: string, type: string, config: Record<string, unknown> = {}): Node => ({
  id,
  type,
  version: 1,
  position: { x: 0, y: 0 },
  config,
});
const port = (ref: string) => {
  const [node, p] = ref.split(".") as [string, string];
  return { node, port: p };
};
const x = (from: string, to: string) => ({
  id: `e${++seq}`,
  kind: "exec" as const,
  from: port(from),
  to: { node: to, port: "in" },
});
const d = (from: string, to: string) => ({
  id: `e${++seq}`,
  kind: "data" as const,
  from: port(from),
  to: port(to),
});
const def = (name: string, nodes: Node[], edges: unknown[]) => ({
  schema: "sling.workflow/v1",
  name,
  description: "",
  nodes,
  edges,
});

interface Detail {
  id: string;
  name: string;
  enabled: boolean;
  activeVersion: number | null;
  webhooks: { nodeId: string; url: string }[];
  templateKey: string | null;
  draft: { nodes: Node[] };
  draftRevision: number;
}

async function deploy(client: Client, definition: unknown, opts: { enable?: boolean } = {}) {
  const wf = await client.call<Detail>("POST", "/api/workflows", { definition });
  const pub = await client.raw("POST", `/api/workflows/${wf.id}/publish`, { note: "test" });
  if (!pub.ok) throw new Error(`publish failed: ${await pub.text()}`);
  if (opts.enable) await client.call("PATCH", `/api/workflows/${wf.id}`, { enabled: true });
  return client.call<Detail>("GET", `/api/workflows/${wf.id}`);
}

async function start(client: Client, workflowId: string, input: unknown = null) {
  return client.call<RunView>("POST", `/api/workflows/${workflowId}/run`, { input });
}

async function settled(
  client: Client,
  runId: string,
  statuses: string[] = ["succeeded", "failed", "cancelled"],
  ms = 15_000,
): Promise<RunDetailView> {
  return until(
    `run ${runId} to be ${statuses.join("/")}`,
    async () => {
      const r = await client.call<RunDetailView>("GET", `/api/runs/${runId}`);
      return statuses.includes(r.run.status) ? r : null;
    },
    ms,
  );
}

const byNode = (r: RunDetailView, id: string): NodeRunView[] =>
  r.nodeRuns.filter((nr) => nr.nodeId === id);
const callsFor = (runId: string, tag?: string) =>
  calls.filter((x) => x.runId === runId && (tag === undefined || x.tag === tag));

async function workspace() {
  const [m] = await server.ctx.db.select().from(schema.workspaceMembers).limit(1);
  if (!m) throw new Error("no workspace");
  return m;
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  server = await boot(pg.getConnectionUri());
  server.ctx.connectors.backoffBaseMs = 50;
  c = new Client(server.url);
  await c.signUp();
}, 120_000);

afterAll(async () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  for (const s of extra) await s.close().catch(() => {});
  await server?.close();
  await pg?.stop();
});

// ---------------------------------------------------------------- tests

describe("catalog and validation", () => {
  it("serves node specs with JSON Schema config", async () => {
    const cat = await c.call<{
      nodes: {
        type: string;
        connector: string | null;
        isTrigger: boolean;
        configSchema: { properties?: Record<string, { description?: string; widget?: string }> };
      }[];
      types: { name: string }[];
    }>("GET", "/api/workflow-nodes");
    const types = cat.nodes.map((x) => x.type);
    for (const t of [
      "core.if",
      "core.switch",
      "core.transform",
      "core.for_each",
      "core.wait",
      "core.set_var",
      "core.get_var",
      "core.invoke_workflow",
      "core.return",
      "http.request",
      "state.kv_get",
      "state.kv_set",
      "state.conversation",
      "ai.prompt",
      "ai.extract",
      "ai.classify",
      "human.approval",
      "agent.delegate_coding_task",
      "agent.assistant",
      "core.manual",
      "core.schedule",
      "core.webhook",
      "app.chat_message",
      "sling.conversation_update",
      "sling.task_settled",
      "sling.approval_requested",
    ]) {
      expect(types).toContain(t);
    }
    const prompt = cat.nodes.find((x) => x.type === "ai.prompt");
    expect(prompt?.configSchema.properties?.prompt?.widget).toBe("textarea");
    // Every field of every built-in node has help text.
    for (const node of cat.nodes.filter((x) => !x.connector && !x.type.startsWith("test."))) {
      for (const [field, s] of Object.entries(node.configSchema.properties ?? {})) {
        expect([node.type, field, Boolean(s.description)]).toEqual([node.type, field, true]);
      }
    }
    expect(cat.nodes.find((x) => x.type === "fake.event")).toMatchObject({
      connector: "fake",
      isTrigger: true,
    });
    expect(cat.types.map((t) => t.name)).toContain("discord.message");
  });

  it("refuses to publish an invalid draft, with issues on the nodes", async () => {
    const wf = await c.call<Detail>("POST", "/api/workflows", {
      definition: def(
        "Broken",
        [n("t", "core.manual"), n("s", "test.record"), n("orphan", "test.record")],
        [x("t.next", "s"), d("t.input", "s.nope")],
      ),
    });
    const res = await c.raw("POST", `/api/workflows/${wf.id}/publish`, {});
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; issues: { code: string; nodeId?: string }[] };
    expect(body.ok).toBe(false);
    expect(body.issues.map((i) => [i.code, i.nodeId]).sort()).toEqual([
      ["unknown_port", "s"],
      ["unreachable", "orphan"],
    ]);
    const shape = await c.raw("PUT", `/api/workflows/${wf.id}/draft`, { schema: "nope" });
    expect(shape.status).toBe(400);
  });

  it("tracks unpublished changes, versions, export, and import", async () => {
    const wf = await deploy(
      c,
      def("Versions", [n("t", "core.manual"), n("a", "test.record")], [x("t.next", "a")]),
    );
    expect(wf.activeVersion).toBe(1);
    const edited = def(
      "Versions",
      [n("t", "core.manual"), n("a", "test.record"), n("b", "test.record")],
      [x("t.next", "a"), x("a.next", "b")],
    );
    const saved = await c.call<{ hasUnpublishedChanges: boolean }>(
      "PUT",
      `/api/workflows/${wf.id}/draft`,
      edited,
    );
    expect(saved.hasUnpublishedChanges).toBe(true);
    await c.call("POST", `/api/workflows/${wf.id}/publish`, { note: "add b" });
    const versions = await c.call<{ number: number; note: string }[]>(
      "GET",
      `/api/workflows/${wf.id}/versions`,
    );
    expect(versions.map((v) => [v.number, v.note])).toEqual([
      [2, "add b"],
      [1, "test"],
    ]);
    const v1 = await c.call<{ definition: { nodes: unknown[] } }>(
      "GET",
      `/api/workflows/${wf.id}/versions/1`,
    );
    expect(v1.definition.nodes).toHaveLength(2);
    const exported = await c.call<{ nodes: unknown[] }>("GET", `/api/workflows/${wf.id}/export`);
    expect(exported.nodes).toHaveLength(3);
    const imported = await c.call<Detail>("POST", "/api/workflows/import", exported);
    expect(imported.activeVersion).toBeNull();
    expect(imported.draft.nodes).toHaveLength(3);
  });
});

describe("draft revisions", () => {
  const one = (name: string) =>
    def(name, [n("t", "core.manual"), n("a", "test.record")], [x("t.next", "a")]);
  const two = (name: string) =>
    def(
      name,
      [n("t", "core.manual"), n("a", "test.record"), n("b", "test.record")],
      [x("t.next", "a"), x("a.next", "b")],
    );

  it("saves only over the revision a save was based on", async () => {
    const wf = await c.call<Detail>("POST", "/api/workflows", { definition: one("Tabs") });
    expect(wf.draftRevision).toBe(1);

    // One tab saves, then another tab still on revision 1 saves something else.
    const saved = two("Tabs");
    const first = await c.call<Detail>("PUT", `/api/workflows/${wf.id}/draft`, {
      definition: saved,
      revision: 1,
    });
    expect(first.draftRevision).toBe(2);
    const stale = await c.raw("PUT", `/api/workflows/${wf.id}/draft`, {
      definition: one("Tabs from the other tab"),
      revision: 1,
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      error: string;
      conflict: { revision: number; draft: { name: string; nodes: unknown[] } };
    };
    expect(body.conflict.revision).toBe(2);
    expect(body.conflict.draft.nodes).toHaveLength(3);
    const kept = await c.call<Detail>("GET", `/api/workflows/${wf.id}`);
    expect([kept.name, kept.draftRevision]).toEqual(["Tabs", 2]);

    // A save repeated after its response was lost isn't a conflict with itself.
    const repeated = await c.call<Detail>("PUT", `/api/workflows/${wf.id}/draft`, {
      definition: saved,
      revision: 1,
    });
    expect(repeated.draftRevision).toBe(2);

    // Saving over the conflict on purpose names the revision it was shown.
    const over = await c.call<Detail>("PUT", `/api/workflows/${wf.id}/draft`, {
      definition: one("Tabs from the other tab"),
      revision: body.conflict.revision,
    });
    expect([over.name, over.draftRevision]).toEqual(["Tabs from the other tab", 3]);

    // Writes that name no revision still move it on, so an open editor sees them.
    const bareDraft = two("Bare");
    const bare = await c.call<Detail>("PUT", `/api/workflows/${wf.id}/draft`, bareDraft);
    expect(bare.draftRevision).toBe(4);
    const renamed = await c.call<Detail>("PATCH", `/api/workflows/${wf.id}`, { name: "Renamed" });
    expect(renamed.draftRevision).toBe(5);
    const after = await c.raw("PUT", `/api/workflows/${wf.id}/draft`, {
      definition: bareDraft,
      revision: 4,
    });
    expect(after.status).toBe(409);
  });

  it("publishes only the revision that was reviewed", async () => {
    const wf = await c.call<Detail>("POST", "/api/workflows", { definition: one("Reviewed") });
    await c.call("PUT", `/api/workflows/${wf.id}/draft`, {
      definition: two("Reviewed"),
      revision: wf.draftRevision,
    });
    const stale = await c.raw("POST", `/api/workflows/${wf.id}/publish`, {
      note: "what I saw",
      revision: wf.draftRevision,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { conflict: { revision: number } }).conflict.revision).toBe(
      wf.draftRevision + 1,
    );
    const unpublished = await c.call<Detail>("GET", `/api/workflows/${wf.id}`);
    expect(unpublished.activeVersion).toBeNull();

    const ok = await c.call<{ ok: boolean; version: number }>(
      "POST",
      `/api/workflows/${wf.id}/publish`,
      { note: "what I saw", revision: unpublished.draftRevision },
    );
    expect(ok).toMatchObject({ ok: true, version: 1 });
    const published = await c.call<Detail & { active: { nodes: unknown[] } }>(
      "GET",
      `/api/workflows/${wf.id}`,
    );
    expect(published.active.nodes).toHaveLength(3);
    // Publishing doesn't change the draft, so an editor keeps saving on the same revision.
    expect(published.draftRevision).toBe(unpublished.draftRevision);
  });

  it("refuses a chat change when the draft moved on after it was proposed", async () => {
    const wf = await deploy(c, one("Proposed"));
    const ws = await workspace();
    const row = await server.ctx.workflows.get(ws.workspaceId, wf.id);
    if (!row) throw new Error("no workflow");
    // The editor saves while the card waits for the user.
    await c.call("PUT", `/api/workflows/${wf.id}/draft`, {
      definition: two("Proposed"),
      revision: row.draftRevision,
    });
    await expect(
      server.ctx.workflows.saveDraft(row, one("Proposed by chat") as WorkflowDefinition, {
        revision: row.draftRevision,
      }),
    ).rejects.toThrow("changed somewhere else");
    const kept = await c.call<Detail>("GET", `/api/workflows/${wf.id}`);
    expect(kept.draft.nodes).toHaveLength(3);
  });
});

describe("traversal", () => {
  it("takes one branch and rejoins", async () => {
    const wf = await deploy(
      c,
      def(
        "Branch",
        [
          n("t", "core.manual"),
          n("if", "core.if", { condition: "inputs.value.n > 5" }),
          n("big", "test.record", { tag: "big" }),
          n("small", "test.record", { tag: "small" }),
          n("after", "test.record", { tag: "after" }),
        ],
        [
          x("t.next", "if"),
          x("if.true", "big"),
          x("if.false", "small"),
          x("big.next", "after"),
          x("small.next", "after"),
          d("t.input", "if.value"),
          d("big.value", "after.value"),
          d("t.input", "big.value"),
        ],
      ),
    );
    const big = await settled(c, (await start(c, wf.id, { n: 10 })).id);
    const small = await settled(c, (await start(c, wf.id, { n: 1 })).id);
    expect(big.run.status).toBe("succeeded");
    expect(byNode(big, "if")[0]?.execPort).toBe("true");
    expect(callsFor(big.run.id).map((x) => x.tag)).toEqual(["big", "after"]);
    expect(callsFor(big.run.id, "after")[0]?.value).toEqual({ n: 10 });
    expect(byNode(small, "if")[0]?.execPort).toBe("false");
    expect(callsFor(small.run.id).map((x) => x.tag)).toEqual(["small", "after"]);
    // big didn't run on this branch, so after's input from it is null.
    expect(callsFor(small.run.id, "after")[0]?.value).toBeNull();
  });

  it("loops over items with an iteration number per pass", async () => {
    const wf = await deploy(
      c,
      def(
        "Loop",
        [
          n("t", "core.manual"),
          n("each", "core.for_each", { items: "={{ trigger.input.items }}" }),
          n("double", "core.transform", { expression: "inputs.value * 2" }),
          n("rec", "test.record", { tag: "item" }),
          n("done", "test.record", { tag: "done" }),
        ],
        [
          x("t.next", "each"),
          x("each.each", "double"),
          x("double.next", "rec"),
          x("each.done", "done"),
          d("each.item", "double.value"),
          d("double.result", "rec.value"),
        ],
      ),
    );
    const r = await settled(c, (await start(c, wf.id, { items: [1, 2, 3] })).id);
    expect(r.run.status).toBe("succeeded");
    expect(callsFor(r.run.id, "item").map((x) => x.value)).toEqual([2, 4, 6]);
    expect(callsFor(r.run.id, "item").map((x) => x.key)).toEqual(
      [0, 1, 2].map((i) => `${r.run.id}:rec:${i}`),
    );
    expect(byNode(r, "double").map((nr) => nr.iteration)).toEqual([0, 1, 2]);
    expect(callsFor(r.run.id, "done")).toHaveLength(1);

    const tooMany = await settled(c, (await start(c, wf.id, { items: Array(1001).fill(1) })).id);
    expect(tooMany.run.status).toBe("failed");
    expect(tooMany.run.error).toMatchObject({ code: "loop_limit", nodeId: "each" });
  });

  it("follows a connected error port, and fails the run when it isn't connected", async () => {
    const routed = await deploy(
      c,
      def(
        "Error port",
        [n("t", "core.manual"), n("f", "test.fail"), n("h", "test.record", { tag: "handled" })],
        [x("t.next", "f"), x("f.error", "h"), d("f.error", "h.value")],
      ),
    );
    const r = await settled(c, (await start(c, routed.id)).id);
    expect(r.run.status).toBe("succeeded");
    expect(byNode(r, "f")[0]).toMatchObject({
      status: "failed",
      execPort: "error",
      error: { code: "boom" },
    });
    expect(callsFor(r.run.id, "handled")[0]?.value).toEqual({ message: "boom", code: "boom" });

    const bare = await deploy(
      c,
      def("No error port", [n("t", "core.manual"), n("f", "test.fail")], [x("t.next", "f")]),
    );
    const b = await settled(c, (await start(c, bare.id)).id);
    expect(b.run.status).toBe("failed");
    expect(b.run.error).toEqual({ message: "boom", code: "boom", nodeId: "f" });
  });

  it("ends the run at core.return, even inside a loop", async () => {
    const wf = await deploy(
      c,
      def(
        "Return",
        [
          n("t", "core.manual"),
          n("each", "core.for_each", { items: "={{ trigger.input }}" }),
          n("if", "core.if", { condition: "inputs.value = 2" }),
          n("ret", "core.return"),
          n("rec", "test.record", { tag: "seen" }),
        ],
        [
          x("t.next", "each"),
          x("each.each", "if"),
          x("if.true", "ret"),
          x("if.false", "rec"),
          d("each.item", "if.value"),
          d("each.item", "ret.value"),
          d("each.item", "rec.value"),
        ],
      ),
    );
    const r = await settled(c, (await start(c, wf.id, [1, 2, 3])).id);
    expect(r.run).toMatchObject({ status: "succeeded", output: 2 });
    expect(callsFor(r.run.id, "seen").map((x) => x.value)).toEqual([1]);
  });
});

describe("retries", () => {
  it("retries a retryable error on an idempotent node", async () => {
    const wf = await deploy(
      c,
      def(
        "Flaky",
        [n("t", "core.manual"), n("f", "test.flaky", { failTimes: 2 })],
        [x("t.next", "f")],
      ),
    );
    const r = await settled(c, (await start(c, wf.id)).id);
    expect(r.run.status).toBe("succeeded");
    expect(byNode(r, "f").map((nr) => [nr.attempt, nr.status])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "succeeded"],
    ]);
  });

  it("never retries a node with side effects", async () => {
    const wf = await deploy(
      c,
      def("Side effect", [n("t", "core.manual"), n("s", "test.side_effect")], [x("t.next", "s")]),
    );
    const r = await settled(c, (await start(c, wf.id)).id);
    expect(r.run.status).toBe("failed");
    expect(byNode(r, "s")).toHaveLength(1);
    expect(sideEffects.get(r.run.id)).toBe(1);
  });
});

describe("waits", () => {
  it("waits for an approval decided through tasks.decide, and announces it", async () => {
    const watcher = await deploy(
      c,
      def(
        "Approval watcher",
        [n("t", "sling.approval_requested"), n("rec", "test.record", { tag: "requested" })],
        [x("t.next", "rec"), d("t.approval", "rec.value")],
      ),
      { enable: true },
    );
    const wf = await deploy(
      c,
      def(
        "Approve",
        [
          n("t", "core.manual"),
          n("ask", "human.approval", { title: "={{ 'Ship ' & trigger.input.what & '?' }}" }),
          n("yes", "test.record", { tag: "approved" }),
          n("no", "test.record", { tag: "rejected" }),
        ],
        [
          x("t.next", "ask"),
          x("ask.approved", "yes"),
          x("ask.rejected", "no"),
          d("t.input", "ask.summary"),
        ],
      ),
    );
    const run = await start(c, wf.id, { what: "v2" });
    await settled(c, run.id, ["waiting"]);
    const pending = (
      await c.call<{ items: { id: string; kind: string; title: string; runId: string | null }[] }>(
        "GET",
        "/api/approvals",
      )
    ).items;
    const approval = pending.find((a) => a.runId === run.id);
    expect(approval).toMatchObject({ kind: "workflow", title: "Ship v2?" });
    const requested = await until("approval announced", async () => {
      const runs = await c.call<RunView[]>("GET", `/api/workflows/${watcher.id}/runs`);
      return runs[0] ? settled(c, runs[0].id) : null;
    });
    expect(callsFor(requested.run.id, "requested")[0]?.value).toMatchObject({
      id: approval?.id,
      kind: "workflow",
    });

    const m = await workspace();
    expect(await server.ctx.tasks.decide(m.workspaceId, approval?.id ?? "", m.userId, true)).toBe(
      true,
    );
    const done = await settled(c, run.id);
    expect(done.run.status).toBe("succeeded");
    expect(byNode(done, "ask")[0]).toMatchObject({ status: "succeeded", execPort: "approved" });
    expect(callsFor(run.id).map((x) => x.tag)).toEqual(["approved"]);

    // Rejecting through the API takes the other branch.
    const second = await start(c, wf.id, { what: "v3" });
    await settled(c, second.id, ["waiting"]);
    const p2 = (
      await c.call<{ items: { id: string; runId: string }[] }>("GET", "/api/approvals")
    ).items.find((a) => a.runId === second.id);
    await c.call("POST", `/api/approvals/${p2?.id}`, { decision: "reject" });
    await settled(c, second.id, ["succeeded"]);
    expect(callsFor(second.id).map((x) => x.tag)).toEqual(["rejected"]);
    await c.call("PATCH", `/api/workflows/${watcher.id}`, { enabled: false });
  });

  it("waits for a task to settle", async () => {
    const m = await workspace();
    const db = server.ctx.db;
    const runnerId = newId("rnr");
    await db.insert(schema.runners).values({
      id: runnerId,
      workspaceId: m.workspaceId,
      ownerId: m.userId,
      name: "box",
      publicKey: Buffer.alloc(32, 1).toString("base64"),
    });
    const repoId = newId("rpo");
    await db.insert(schema.repos).values({
      id: repoId,
      workspaceId: m.workspaceId,
      ownerId: m.userId,
      runnerId,
      name: "site",
      defaultBranch: "main",
    });
    const taskId = newId("tsk");
    await db.insert(schema.tasks).values({
      id: taskId,
      workspaceId: m.workspaceId,
      ownerId: m.userId,
      runnerId,
      repoId,
      repoName: "site",
      title: "Fix the footer",
      objective: "x",
      mode: "auto",
      state: "running",
      branch: taskBranch(taskId, "x"),
    });
    const settledWatcher = await deploy(
      c,
      def(
        "Task watcher",
        [n("t", "sling.task_settled"), n("rec", "test.record", { tag: "settled" })],
        [x("t.next", "rec"), d("t.reason", "rec.value")],
      ),
      { enable: true },
    );
    const wf = await deploy(
      c,
      def(
        "Task wait",
        [
          n("t", "core.manual"),
          n("w", "test.wait_task", { taskId }),
          n("rec", "test.record", { tag: "task" }),
        ],
        [x("t.next", "w"), x("w.next", "rec"), d("w.task", "rec.value")],
      ),
    );
    const run = await start(c, wf.id);
    await settled(c, run.id, ["waiting"]);
    await db
      .update(schema.tasks)
      .set({ state: "succeeded", summary: "Done." })
      .where(eq(schema.tasks.id, taskId));
    await server.ctx.tasks.onSettled?.(taskId, "finished");
    await settled(c, run.id, ["succeeded"]);
    expect(callsFor(run.id, "task")[0]?.value).toMatchObject({
      id: taskId,
      state: "succeeded",
      summary: "Done.",
      settleReason: "finished",
    });
    const watcherRuns = await c.call<RunView[]>("GET", `/api/workflows/${settledWatcher.id}/runs`);
    expect(watcherRuns).toHaveLength(1);
    // The same settle point again starts nothing; a new one for the same reason does.
    await server.ctx.tasks.onSettled?.(taskId, "finished");
    await db.update(schema.tasks).set({ state: "failed" }).where(eq(schema.tasks.id, taskId));
    await server.ctx.tasks.onSettled?.(taskId, "finished");
    await until("a second watcher run", async () => {
      const runs = await c.call<RunView[]>("GET", `/api/workflows/${settledWatcher.id}/runs`);
      return runs.length >= 2 ? runs : null;
    });
    expect(await c.call<RunView[]>("GET", `/api/workflows/${settledWatcher.id}/runs`)).toHaveLength(
      2,
    );
    await c.call("PATCH", `/api/workflows/${settledWatcher.id}`, { enabled: false });
  });

  it("cancels the task a cancelled run waits on", async () => {
    const m = await workspace();
    const db = server.ctx.db;
    const runnerId = newId("rnr");
    await db.insert(schema.runners).values({
      id: runnerId,
      workspaceId: m.workspaceId,
      ownerId: m.userId,
      name: "spare",
      publicKey: Buffer.alloc(32, 3).toString("base64"),
    });
    const repoId = newId("rpo");
    await db.insert(schema.repos).values({
      id: repoId,
      workspaceId: m.workspaceId,
      ownerId: m.userId,
      runnerId,
      name: "site",
      defaultBranch: "main",
    });
    const taskId = newId("tsk");
    await db.insert(schema.tasks).values({
      id: taskId,
      workspaceId: m.workspaceId,
      ownerId: m.userId,
      runnerId,
      repoId,
      repoName: "site",
      title: "Not needed after all",
      objective: "x",
      mode: "auto",
      state: "queued",
      branch: taskBranch(taskId, "x"),
    });
    const wf = await deploy(
      c,
      def(
        "Cancelled task wait",
        [n("t", "core.manual"), n("w", "test.wait_task", { taskId })],
        [x("t.next", "w")],
      ),
    );
    const run = await start(c, wf.id);
    await settled(c, run.id, ["waiting"]);
    await c.call("POST", `/api/runs/${run.id}/cancel`);
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(task?.state).toBe("cancelled");
  });

  it("waits for an event with a timeout", async () => {
    const wf = await deploy(
      c,
      def(
        "Event wait",
        [
          n("t", "core.manual"),
          n("w", "test.wait_event", { key: "={{ trigger.input.key }}", timeoutMs: 800 }),
          n("got", "test.record", { tag: "pinged" }),
          n("late", "test.record", { tag: "timed-out" }),
        ],
        [
          x("t.next", "w"),
          x("w.next", "got"),
          x("w.error", "late"),
          d("w.payload", "got.value"),
          d("w.error", "late.value"),
        ],
      ),
    );
    const m = await workspace();
    const pinged = await start(c, wf.id, { key: "k-ping" });
    await settled(c, pinged.id, ["waiting"]);
    // Another key doesn't wake it.
    await server.ctx.events.emit({
      type: "test.ping",
      workspaceId: m.workspaceId,
      payload: { n: 0 },
      waitKey: "other",
    });
    await server.ctx.events.emit({
      type: "test.ping",
      workspaceId: m.workspaceId,
      payload: { n: 1 },
      waitKey: "k-ping",
    });
    await settled(c, pinged.id, ["succeeded"]);
    expect(callsFor(pinged.id).map((x) => [x.tag, x.value])).toEqual([["pinged", { n: 1 }]]);

    const late = await start(c, wf.id, { key: "never" });
    await settled(c, late.id, ["succeeded"], 10_000);
    expect(callsFor(late.id).map((x) => [x.tag, x.value])).toEqual([
      ["timed-out", { message: "No ping came", code: "timeout" }],
    ]);
  });

  it("cancels a waiting run and retries it from the same payload", async () => {
    const wf = await deploy(
      c,
      def(
        "Long wait",
        [n("t", "core.manual"), n("w", "core.wait", { seconds: 600 })],
        [x("t.next", "w")],
      ),
    );
    const run = await start(c, wf.id, { again: true });
    await settled(c, run.id, ["waiting"]);
    const cancelled = await c.call<RunView>("POST", `/api/runs/${run.id}/cancel`);
    expect(cancelled.status).toBe("cancelled");
    const detail = await c.call<RunDetailView>("GET", `/api/runs/${run.id}`);
    expect(byNode(detail, "w")[0]).toMatchObject({
      status: "failed",
      error: { code: "cancelled" },
    });
    const waits = await server.ctx.db
      .select()
      .from(schema.runWaits)
      .where(eq(schema.runWaits.runId, run.id));
    expect(waits).toEqual([]);

    const retried = await c.call<RunView>("POST", `/api/runs/${run.id}/retry`);
    expect(retried.id).not.toBe(run.id);
    const r = await settled(c, retried.id, ["waiting"]);
    expect(byNode(r, "t")[0]?.outputs).toEqual({ input: { again: true } });
    await c.call("POST", `/api/runs/${retried.id}/cancel`);
  });
});

describe("stuck runs", () => {
  it("picks up a run whose timer job or queue job was lost", async () => {
    const wf = await deploy(
      c,
      def(
        "Lost jobs",
        [
          n("t", "core.manual"),
          n("w", "core.wait", { seconds: 600 }),
          n("rec", "test.record", { tag: "woke" }),
        ],
        [x("t.next", "w"), x("w.next", "rec")],
      ),
    );
    const db = server.ctx.db;
    const engine = server.ctx.engine;
    const waitOf = async (runId: string) => {
      const [w] = await db.select().from(schema.runWaits).where(eq(schema.runWaits.runId, runId));
      if (!w) throw new Error("no wait");
      return w;
    };
    const longAgo = new Date(Date.now() - 10 * 60_000);

    // The timer's job is gone, and the wait is long overdue.
    const timer = await start(c, wf.id);
    await settled(c, timer.id, ["waiting"]);
    const tw = await waitOf(timer.id);
    await db.execute(
      sql`delete from pgboss.job where name = 'workflow-timer' and data->>'waitId' = ${tw.id}`,
    );
    await db
      .update(schema.runWaits)
      .set({ resumeAt: longAgo, createdAt: longAgo })
      .where(eq(schema.runWaits.id, tw.id));

    // The wait resolved, but queueing the run failed.
    const queued = await start(c, wf.id);
    await settled(c, queued.id, ["waiting"]);
    const qw = await waitOf(queued.id);
    const enqueue = engine.enqueue;
    engine.enqueue = async () => {
      throw new Error("lost");
    };
    try {
      await expect(engine.resolveWait(qw.id, { kind: "timer" })).rejects.toThrow("lost");
    } finally {
      engine.enqueue = enqueue;
    }
    await db
      .update(schema.workflowRuns)
      .set({ updatedAt: longAgo })
      .where(eq(schema.workflowRuns.id, queued.id));

    // Nothing else is stuck, so a fresh run isn't touched.
    const fresh = await start(c, wf.id);
    await settled(c, fresh.id, ["waiting"]);

    expect(await engine.reconcile()).toBeGreaterThanOrEqual(2);
    await settled(c, timer.id, ["succeeded"]);
    await settled(c, queued.id, ["succeeded"]);
    expect((await c.call<RunDetailView>("GET", `/api/runs/${fresh.id}`)).run.status).toBe(
      "waiting",
    );
    await c.call("POST", `/api/runs/${fresh.id}/cancel`);
  });
});

describe("ordering", () => {
  it("runs one key at a time, in order, and other keys in parallel", async () => {
    const inst = await c.call<{ id: string }>("POST", "/api/installations", {
      connectorId: "fake",
      name: "Ordering",
      credentials: { token: "good-token-123" },
      config: {},
    });
    const wf = await deploy(
      c,
      def(
        "Ordered",
        [
          n("t", "fake.event", { installationId: inst.id, topic: "order" }),
          n("pause", "test.sleep", { ms: "={{ trigger.payload.ms }}" }),
          n("rec", "test.record"),
        ],
        [x("t.next", "pause"), x("pause.next", "rec"), d("t.payload", "rec.value")],
      ),
      { enable: true },
    );
    const before = calls.length;
    const m = await workspace();
    const emit = (key: string, label: string, ms: number) =>
      server.ctx.events.emit({
        type: "fake.event",
        workspaceId: m.workspaceId,
        installationId: inst.id,
        payload: { topic: "order", key, label, ms },
      });
    await emit("k1", "a", 400);
    await emit("k1", "b", 10);
    await emit("k1", "c", 10);
    await emit("k2", "z", 10);
    await until("four runs recorded", async () => calls.length - before >= 4, 5_000);
    const order = calls.slice(before).map((x) => (x.value as { label: string }).label);
    expect(order.filter((l) => l !== "z")).toEqual(["a", "b", "c"]);
    // k2 didn't wait behind k1's slow first run.
    expect(order.indexOf("z")).toBeLessThan(order.indexOf("a"));
    await c.call("PATCH", `/api/workflows/${wf.id}`, { enabled: false });
  });
});

describe("child workflows", () => {
  it("runs a child workflow and gets its output", async () => {
    const childWf = await deploy(
      c,
      def(
        "Doubler",
        [
          n("t", "core.manual"),
          n("calc", "core.transform", { expression: "{ 'doubled': inputs.value.n * 2 }" }),
          n("ret", "core.return"),
        ],
        [
          x("t.next", "calc"),
          x("calc.next", "ret"),
          d("t.input", "calc.value"),
          d("calc.result", "ret.value"),
        ],
      ),
    );
    const parent = await deploy(
      c,
      def(
        "Parent",
        [
          n("t", "core.manual"),
          n("call", "core.invoke_workflow", { workflowId: childWf.id }),
          n("rec", "test.record", { tag: "child" }),
        ],
        [
          x("t.next", "call"),
          x("call.next", "rec"),
          d("t.input", "call.input"),
          d("call.output", "rec.value"),
        ],
      ),
    );
    const run = await start(c, parent.id, { n: 21 });
    const r = await settled(c, run.id);
    expect(r.run.status).toBe("succeeded");
    expect(callsFor(run.id, "child")[0]?.value).toEqual({ doubled: 42 });
    const childRuns = await c.call<RunView[]>("GET", `/api/workflows/${childWf.id}/runs`);
    expect(childRuns[0]).toMatchObject({
      parentRunId: run.id,
      status: "succeeded",
      output: { doubled: 42 },
    });

    // A failing child fails the parent's node.
    const failing = await deploy(
      c,
      def("Failing child", [n("t", "core.manual"), n("f", "test.fail")], [x("t.next", "f")]),
    );
    const p2 = await deploy(
      c,
      def(
        "Parent 2",
        [n("t", "core.manual"), n("call", "core.invoke_workflow", { workflowId: failing.id })],
        [x("t.next", "call")],
      ),
    );
    const r2 = await settled(c, (await start(c, p2.id)).id);
    expect(r2.run.status).toBe("failed");
    expect(r2.run.error).toMatchObject({ code: "child_failed", nodeId: "call" });
  });
});

describe("triggers", () => {
  it("starts runs from a webhook, only while enabled", async () => {
    const wf = await deploy(
      c,
      def(
        "Hook",
        [n("t", "core.webhook"), n("rec", "test.record", { tag: "hook" })],
        [x("t.next", "rec"), d("t.body", "rec.value")],
      ),
      { enable: true },
    );
    expect(wf.webhooks).toHaveLength(1);
    const url = wf.webhooks[0]?.url ?? "";
    expect(url).toMatch(/\/hooks\/[A-Za-z0-9_-]{20,}$/);
    const res = await fetch(url.replace(/^https?:\/\/[^/]+/, server.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope", "x-sig": "1" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    const r = await settled(c, runId);
    expect(callsFor(runId, "hook")[0]?.value).toEqual({ hello: "world" });
    const headers = byNode(r, "t")[0]?.outputs?.headers as Record<string, string>;
    expect(headers["x-sig"]).toBe("1");
    expect(headers.authorization).toBeUndefined();

    // The URL survives a republish.
    await c.call("POST", `/api/workflows/${wf.id}/publish`, { note: "again" });
    const again = await c.call<Detail>("GET", `/api/workflows/${wf.id}`);
    expect(again.webhooks[0]?.url).toBe(url);

    await c.call("PATCH", `/api/workflows/${wf.id}`, { enabled: false });
    const off = await fetch(url.replace(/^https?:\/\/[^/]+/, server.url), {
      method: "POST",
      body: "x",
    });
    expect(off.status).toBe(404);
    expect(
      (await fetch(`${server.url}/hooks/not-a-token`, { method: "POST", body: "x" })).status,
    ).toBe(404);
  });

  describe("webhook settings", () => {
    const local = (url: string) => url.replace(/^https?:\/\/[^/]+/, server.url);
    const signed = (secret: string, body: string, ts = Math.floor(Date.now() / 1000)) => ({
      "content-type": "application/json",
      "x-sling-timestamp": String(ts),
      "x-sling-signature": createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex"),
    });
    const post = (url: string, body: string, headers: Record<string, string> = {}) =>
      fetch(local(url), {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
    const runsOf = async (workflowId: string) =>
      (
        await server.ctx.db
          .select({ id: schema.workflowRuns.id })
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.workflowId, workflowId))
      ).length;

    it("checks a signed hook's own secret, refuses replays, and rotates without a new URL", async () => {
      const definition = def(
        "Signed hook",
        [n("t", "core.webhook", { auth: "signed" }), n("rec", "test.record", { tag: "signed" })],
        [x("t.next", "rec")],
      );
      const wf = await c.call<Detail>("POST", "/api/workflows", { definition });
      // Taking signed requests only, it can't publish without a secret.
      const refused = await c.raw("POST", `/api/workflows/${wf.id}/publish`, {});
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({
        issues: [expect.objectContaining({ code: "missing_signing_secret", nodeId: "t" })],
      });
      expect(await c.call("GET", `/api/workflows/${wf.id}/webhooks/t/secret`)).toEqual({
        signing: null,
      });
      const first = await c.call<{ secret: string; rotatedAt: string | null }>(
        "POST",
        `/api/workflows/${wf.id}/webhooks/t/secret`,
      );
      expect(first.secret).toMatch(/^whsec_/);
      expect(first.rotatedAt).toBeNull();
      expect((await c.raw("POST", `/api/workflows/${wf.id}/webhooks/nope/secret`)).status).toBe(
        404,
      );
      await c.call("POST", `/api/workflows/${wf.id}/publish`, {});
      await c.call("PATCH", `/api/workflows/${wf.id}`, { enabled: true });
      const url = (await c.call<Detail>("GET", `/api/workflows/${wf.id}`)).webhooks[0]?.url ?? "";

      expect((await post(url, "{}")).status).toBe(401);
      const body = '{"n":1}';
      const headers = signed(first.secret, body);
      expect((await post(url, body, headers)).status).toBe(202);
      // The same signed request again is a replay.
      expect((await post(url, body, headers)).status).toBe(409);
      expect(
        (await post(url, body, signed(first.secret, body, Date.now() / 1000 - 600))).status,
      ).toBe(401);
      expect((await post(url, '{"n":2}', signed("whsec_not-the-secret", '{"n":2}'))).status).toBe(
        401,
      );
      // The secret is never sent back.
      const status = await c.call<{ signing: Record<string, unknown> }>(
        "GET",
        `/api/workflows/${wf.id}/webhooks/t/secret`,
      );
      expect(JSON.stringify(status)).not.toContain(first.secret);

      const second = await c.call<{ secret: string; previousValidUntil: string | null }>(
        "POST",
        `/api/workflows/${wf.id}/webhooks/t/secret`,
      );
      expect(second.secret).not.toBe(first.secret);
      expect(second.previousValidUntil).not.toBeNull();
      expect((await c.call<Detail>("GET", `/api/workflows/${wf.id}`)).webhooks[0]?.url).toBe(url);
      // Both work while the old one overlaps.
      expect((await post(url, '{"n":3}', signed(first.secret, '{"n":3}'))).status).toBe(202);
      expect((await post(url, '{"n":4}', signed(second.secret, '{"n":4}'))).status).toBe(202);
      // Once the overlap is over, only the new one does.
      await server.ctx.db
        .update(schema.webhookSecrets)
        .set({ previousUntil: new Date(Date.now() - 60_000) })
        .where(eq(schema.webhookSecrets.workflowId, wf.id));
      expect((await post(url, '{"n":5}', signed(first.secret, '{"n":5}'))).status).toBe(401);
      expect((await post(url, '{"n":6}', signed(second.secret, '{"n":6}'))).status).toBe(202);
      expect(await runsOf(wf.id)).toBe(4);

      // Deleting the workflow takes its stored secret with it.
      const [link] = await server.ctx.db
        .select({ credentialId: schema.webhookSecrets.credentialId })
        .from(schema.webhookSecrets)
        .where(eq(schema.webhookSecrets.workflowId, wf.id));
      await c.call("DELETE", `/api/workflows/${wf.id}`);
      const left = await server.ctx.db
        .select({ id: schema.credentials.id })
        .from(schema.credentials)
        .where(eq(schema.credentials.id, link?.credentialId ?? ""));
      expect(left).toEqual([]);
    });

    it("starts at most one run per event ID, from the header the hook names", async () => {
      const wf = await deploy(
        c,
        def(
          "Deduped hook",
          [n("t", "core.webhook", { eventIdHeader: "X-GitHub-Delivery" }), n("rec", "test.record")],
          [x("t.next", "rec")],
        ),
        { enable: true },
      );
      const url = wf.webhooks[0]?.url ?? "";
      const once = await Promise.all(
        [1, 2, 3].map(() => post(url, "{}", { "x-github-delivery": "delivery-1" })),
      );
      expect(once.map((r) => r.status).sort()).toEqual([202, 409, 409]);
      expect((await post(url, "{}", { "x-github-delivery": "delivery-2" })).status).toBe(202);
      // Another header isn't this hook's event ID.
      expect((await post(url, "{}", { "x-sling-event-id": "delivery-2" })).status).toBe(202);
      expect(await runsOf(wf.id)).toBe(3);

      const off = await deploy(
        c,
        def("Hook without event IDs", [n("t", "core.webhook", { eventIdHeader: "" })], []),
        { enable: true },
      );
      const offUrl = off.webhooks[0]?.url ?? "";
      expect((await post(offUrl, "{}", { "x-sling-event-id": "same" })).status).toBe(202);
      expect((await post(offUrl, "{}", { "x-sling-event-id": "same" })).status).toBe(202);
      expect(await runsOf(off.id)).toBe(2);

      const bad = await c.call<Detail>("POST", "/api/workflows", {
        definition: def(
          "Bad header",
          [n("t", "core.webhook", { eventIdHeader: "Not a header" })],
          [],
        ),
      });
      const issues = await c.call<{ issues: { message: string }[] }>(
        "POST",
        `/api/workflows/${bad.id}/validate`,
      );
      expect(issues.issues.map((i) => i.message)).toContain(
        "eventIdHeader: Not a header isn't a header name",
      );
    });

    it("keeps a hook's unfinished runs within its budget, counted in the database", async () => {
      const wf = await deploy(
        c,
        def(
          "Budgeted hook",
          [
            n("t", "core.webhook", { maxConcurrentRuns: 2 }),
            n("w", "test.wait_event", { key: "budget", timeoutMs: 60_000 }),
          ],
          [x("t.next", "w")],
        ),
        { enable: true },
      );
      const url = wf.webhooks[0]?.url ?? "";
      const burst = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => post(url, `{"i":${i}}`)));
      const codes = burst.map((r) => r.status).sort();
      expect(codes).toEqual([202, 202, 429, 429, 429, 429]);
      const refused = burst.find((r) => r.status === 429);
      expect(refused?.headers.get("retry-after")).toBe("60");
      expect(await refused?.json()).toEqual({
        error: "This trigger already has 2 unfinished runs.",
      });
      expect(await runsOf(wf.id)).toBe(2);

      // Waiting runs hold their place; a finished one frees it.
      const ids = await Promise.all(
        burst
          .filter((r) => r.status === 202)
          .map(async (r) => ((await r.json()) as { runId: string }).runId),
      );
      await Promise.all(ids.map((id) => settled(c, id, ["waiting"])));
      expect((await post(url, "{}")).status).toBe(429);
      await c.call("POST", `/api/runs/${ids[0]}/cancel`);
      await settled(c, ids[0] ?? "", ["cancelled"]);
      expect((await post(url, "{}")).status).toBe(202);
      expect((await post(url, "{}")).status).toBe(429);
    });

    it("falls back to the server's secret for hooks without their own", async () => {
      const wf = await deploy(
        c,
        def(
          "Server-signed hook",
          [n("t", "core.webhook"), n("rec", "test.record")],
          [x("t.next", "rec")],
        ),
        { enable: true },
      );
      const url = wf.webhooks[0]?.url ?? "";
      const key = "server-wide-webhook-secret-for-the-test-0123456789";
      server.ctx.config.webhookSecret = key;
      try {
        expect((await post(url, "{}")).status).toBe(401);
        expect((await post(url, "{}", signed(key, "{}"))).status).toBe(202);
      } finally {
        server.ctx.config.webhookSecret = undefined;
      }
      expect((await post(url, '{"plain":true}')).status).toBe(202);
    });
  });

  it("runs manually, and needs a published version", async () => {
    const wf = await c.call<Detail>("POST", "/api/workflows", {
      definition: def(
        "Manual",
        [n("t", "core.manual"), n("rec", "test.record")],
        [x("t.next", "rec"), d("t.input", "rec.value")],
      ),
    });
    expect((await c.raw("POST", `/api/workflows/${wf.id}/run`, {})).status).toBe(409);
    await c.call("POST", `/api/workflows/${wf.id}/publish`, {});
    const run = await start(c, wf.id, { a: 1 });
    expect(["queued", "running", "succeeded"]).toContain(run.status);
    const r = await settled(c, run.id);
    expect(r.run).toMatchObject({
      status: "succeeded",
      triggerType: "core.manual",
      versionNumber: 1,
    });
    expect(callsFor(run.id)[0]?.value).toEqual({ a: 1 });
  });

  it("keeps a pg-boss schedule per schedule trigger while enabled", async () => {
    const wf = await deploy(
      c,
      def(
        "Every minute",
        [
          n("t", "core.schedule", { cron: "*/5 * * * *" }),
          n("rec", "test.record", { tag: "cron" }),
        ],
        [x("t.next", "rec")],
      ),
      { enable: true },
    );
    const [trigger] = await server.ctx.db
      .select()
      .from(schema.workflowTriggers)
      .where(eq(schema.workflowTriggers.workflowId, wf.id));
    expect(trigger?.event).toBe("core.schedule");
    const boss = server.ctx.boss;
    if (!boss || !trigger) throw new Error("no boss");
    const sched = await boss.getSchedule(SCHEDULE_QUEUE, trigger.id);
    expect(sched?.cron).toBe("*/5 * * * *");
    const run = await fireSchedule(server.ctx, trigger.id, "job-1");
    if (!run) throw new Error("no run");
    await settled(c, run.id, ["succeeded"]);
    // The same scheduled job never starts two runs.
    expect(await fireSchedule(server.ctx, trigger.id, "job-1")).toBeNull();
    await c.call("PATCH", `/api/workflows/${wf.id}`, { enabled: false });
    expect(await boss.getSchedule(SCHEDULE_QUEUE, trigger.id)).toBeNull();
  });
});

describe("connectors", () => {
  it("runs a source for an installation in use, dedupes its events, and keeps secrets out of storage", async () => {
    const connectors = await c.call<
      { id: string; secretFields: string[]; credentialsSchema: { properties: object } }[]
    >("GET", "/api/connectors");
    expect(connectors.find((x) => x.id === "fake")).toMatchObject({ secretFields: ["token"] });

    const inst = await c.call<{ id: string; status: string; hasCredentials: boolean }>(
      "POST",
      "/api/installations",
      {
        connectorId: "fake",
        name: "Fake one",
        credentials: { token: "good-token-123" },
        config: { label: "first" },
      },
    );
    expect(inst).toMatchObject({ status: "idle", hasCredentials: true });
    expect(JSON.stringify(await c.call("GET", "/api/installations"))).not.toContain(
      "good-token-123",
    );
    expect(await c.call("POST", `/api/installations/${inst.id}/test`)).toEqual({
      ok: true,
      detail: "fine",
    });

    const startsBefore = fakeSource.starts;
    const wf = await deploy(
      c,
      def(
        "Fake events",
        [
          n("t", "fake.event", { installationId: inst.id, topic: "mail" }),
          n("leak", "fake.echo_secret", { installationId: inst.id }),
          n("rec", "test.record", { tag: "fake" }),
        ],
        [x("t.next", "leak"), x("leak.next", "rec"), d("t.payload", "rec.value")],
      ),
      { enable: true },
    );
    const live = await until("source connected", async () => {
      const list = await c.call<{ id: string; status: string }[]>("GET", "/api/installations");
      return list.find((i) => i.id === inst.id && i.status === "connected");
    });
    expect(live).toBeTruthy();
    expect(fakeSource.starts).toBe(startsBefore + 1);
    const src = fakeSource.ctx;
    if (!src) throw new Error("no source");
    expect(src.credentials).toEqual({ token: "good-token-123" });

    await src.state.set("uid", "41");
    expect(await src.state.get("uid")).toBe("41");

    await src.emit({ type: "fake.event", payload: { topic: "mail", n: 1 }, dedupeKey: "mail-1" });
    await src.emit({ type: "fake.event", payload: { topic: "mail", n: 1 }, dedupeKey: "mail-1" });
    await src.emit({ type: "fake.event", payload: { topic: "other" }, dedupeKey: "mail-2" });
    await src.emit({ type: "fake.event", payload: { topic: "mail", n: 2 }, dedupeKey: "mail-3" });
    // Sources can't pose as other triggers.
    await src.emit({ type: "app.chat_message", payload: {} });
    // A run that fails to start throws, so the source tries the event again.
    const startRun = vi
      .spyOn(server.ctx.engine, "startRun")
      .mockRejectedValueOnce(new Error("database went away"));
    await expect(
      src.emit({ type: "fake.event", payload: { topic: "mail", n: 4 }, dedupeKey: "mail-4" }),
    ).rejects.toThrow("database went away");
    startRun.mockRestore();
    const runs = await until("two runs", async () => {
      const list = await c.call<RunView[]>("GET", `/api/workflows/${wf.id}/runs`);
      return list.length >= 2 && list.every((r) => r.status === "succeeded") ? list : null;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(await c.call<RunView[]>("GET", `/api/workflows/${wf.id}/runs`)).toHaveLength(2);
    const detail = await c.call<RunDetailView>("GET", `/api/runs/${runs[0]?.id}`);
    const stored = JSON.stringify(byNode(detail, "leak")[0]?.outputs);
    expect(stored).not.toContain("good-token-123");
    expect(stored).toContain("[redacted]");
    expect(byNode(detail, "leak")[0]?.outputs?.label).toBe("first");

    // Disabling the only workflow that uses it stops the source.
    await c.call("PATCH", `/api/workflows/${wf.id}`, { enabled: false });
    expect(fakeSource.ctx).toBeNull();
    // What a stopped source still tries to hand on or record is refused, not dropped.
    await expect(src.emit({ type: "fake.event", payload: { topic: "mail" } })).rejects.toThrow(
      /stopped/,
    );
    await expect(src.state.set("uid", "42")).rejects.toThrow(/stopped/);
    expect(await src.state.get("uid")).toBe("41");
    const idle = (await c.call<{ id: string; status: string }[]>("GET", "/api/installations")).find(
      (i) => i.id === inst.id,
    );
    expect(idle?.status).toBe("idle");
  });

  it("restarts a failing source with backoff", async () => {
    const inst = await c.call<{ id: string }>("POST", "/api/installations", {
      connectorId: "fake",
      name: "Flaky source",
      credentials: { token: "t0k3n-flaky" },
      config: {},
    });
    fakeSource.failNext = 2;
    const before = fakeSource.starts;
    const wf = await deploy(
      c,
      def(
        "Flaky source",
        [n("t", "fake.event", { installationId: inst.id }), n("r", "test.record")],
        [x("t.next", "r")],
      ),
      {
        enable: true,
      },
    );
    await until("connected after retries", async () => {
      const list = await c.call<{ id: string; status: string }[]>("GET", "/api/installations");
      return list.find((i) => i.id === inst.id)?.status === "connected";
    });
    expect(fakeSource.starts - before).toBe(3);
    expect(await c.call("POST", `/api/installations/${inst.id}/test`)).toEqual({
      ok: false,
      error: "bad token",
    });
    await c.call("PATCH", `/api/workflows/${wf.id}`, { enabled: false });
  });

  it("decides approvals for external users and audits refused clicks", async () => {
    const inst = await c.call<{ id: string }>("POST", "/api/installations", {
      connectorId: "fake",
      name: "Approver",
      credentials: { token: "approver-token" },
      config: {},
    });
    const listener = await deploy(
      c,
      def(
        "Keep source up",
        [n("t", "fake.event", { installationId: inst.id, topic: "none" }), n("r", "test.record")],
        [x("t.next", "r")],
      ),
      {
        enable: true,
      },
    );
    const src = await until("source", async () => fakeSource.ctx);
    const wf = await deploy(
      c,
      def(
        "Needs approval",
        [
          n("t", "core.manual"),
          n("ask", "human.approval", { title: "Go?" }),
          n("yes", "test.record", { tag: "yes" }),
        ],
        [x("t.next", "ask"), x("ask.approved", "yes")],
      ),
    );
    const run = await start(c, wf.id);
    await settled(c, run.id, ["waiting"]);
    const approval = (
      await c.call<{ items: { id: string; runId: string }[] }>("GET", "/api/approvals")
    ).items.find((a) => a.runId === run.id);
    if (!approval) throw new Error("no approval");
    const actor = { via: "fake", externalUserId: "u-42" };
    await src.approvals.reportRefused({
      approvalId: approval.id,
      approve: true,
      actor: { via: "fake", externalUserId: "intruder" },
      reason: "not an approver",
    });
    expect(await src.approvals.decide({ approvalId: approval.id, approve: true, actor })).toEqual({
      ok: true,
      message: "Approved.",
    });
    expect(
      await src.approvals.decide({ approvalId: approval.id, approve: true, actor }),
    ).toMatchObject({ ok: false });
    await settled(c, run.id, ["succeeded"]);
    const audits = await server.ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, approval.id));
    expect(
      audits
        .map((a) => [
          a.verb,
          (a.details as { via?: string }).via,
          (a.details as { externalUserId?: string }).externalUserId,
        ])
        .sort(),
    ).toEqual([
      ["approval.approved", "fake", "u-42"],
      ["approval.refused", "fake", "intruder"],
    ]);
    const [row] = await server.ctx.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approval.id));
    expect(row?.decidedVia).toBe("fake");
    await c.call("PATCH", `/api/workflows/${listener.id}`, { enabled: false });
  });
});

describe("connector setup", () => {
  it("fills in from what's typed, and never hands a secret back", async () => {
    const out = await c.call<{
      name: string;
      credentials?: Record<string, unknown>;
      config: Record<string, unknown>;
      notes: { field: string; tone: string }[];
    }>("POST", "/api/connectors/fake/setup", { credentials: { token: "good-token-123" } });
    expect(out).toMatchObject({
      name: "Fake for good",
      config: { label: "from setup" },
      notes: [{ field: "token", tone: "ok" }],
    });
    expect(out.credentials).toEqual({ host: "fake.example.com" });
    expect(JSON.stringify(out)).not.toContain("good-token-123");

    const missing = await c.raw("POST", "/api/connectors/nope/setup", {});
    expect(missing.status).toBe(404);
  });

  it("checks the connection before adding, and names it after the connector", async () => {
    const before = await c.call<unknown[]>("GET", "/api/installations");
    const bad = await c.raw("POST", "/api/installations", {
      connectorId: "fake",
      credentials: { token: "wrong" },
      check: true,
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: "bad token", check: "failed" });
    expect(await c.call<unknown[]>("GET", "/api/installations")).toHaveLength(before.length);

    const add = () =>
      c.call<{ id: string; name: string }>("POST", "/api/installations", {
        connectorId: "fake",
        credentials: { token: "good-token-123" },
        check: true,
      });
    const first = await add();
    const second = await add();
    const names = (await c.call<{ name: string }[]>("GET", "/api/installations")).map(
      (i) => i.name,
    );
    expect(names).toContain(first.name);
    expect(second.name).not.toBe(first.name);
    expect(second.name).toMatch(/^Fake \d+$/);

    // Editing: the stored token fills what isn't typed again, and nothing stored comes back.
    const edit = await c.call<{ credentials?: unknown; notes: { tone: string }[] }>(
      "POST",
      "/api/connectors/fake/setup",
      { installationId: second.id },
    );
    expect(edit.notes).toEqual([expect.objectContaining({ tone: "ok" })]);
    expect(edit.credentials).toBeUndefined();

    // A failed check on new credentials keeps the old ones.
    const patch = await c.raw("PATCH", `/api/installations/${second.id}`, {
      credentials: { token: "wrong" },
      check: true,
    });
    expect(patch.status).toBe(422);
    expect(
      await c.call<{ ok: boolean }>("POST", `/api/installations/${second.id}/test`),
    ).toMatchObject({ ok: true });
    for (const i of [first, second]) await c.call("DELETE", `/api/installations/${i.id}`);
  });
});

describe("assistant", () => {
  it("answers web chat through Sling Assistant, and says so when nothing handles chat", async () => {
    const list = await c.call<{ id: string; templateKey: string | null; enabled: boolean }[]>(
      "GET",
      "/api/workflows",
    );
    const assistant = list.find((w) => w.templateKey === "sling-assistant");
    expect(assistant?.enabled).toBe(true);
    const conv = await c.call<{ id: string }>("POST", "/api/conversations");
    await c.call("POST", `/api/conversations/${conv.id}/messages`, { text: "hello" });
    const answered = await until("reply", async () => {
      const dd = await c.call<{ messages: { role: string; text: string }[] }>(
        "GET",
        `/api/conversations/${conv.id}`,
      );
      return dd.messages.length === 2 ? dd : null;
    });
    expect(answered.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello"],
      ["assistant", "Hi from Sling"],
    ]);
    const [row] = await server.ctx.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conv.id));
    expect(row?.workflowId).toBe(assistant?.id);

    expect((await c.raw("DELETE", `/api/workflows/${assistant?.id}`)).status).toBe(409);
    await c.call("PATCH", `/api/workflows/${assistant?.id}`, { enabled: false });
    await c.call("POST", `/api/conversations/${conv.id}/messages`, { text: "anyone?" });
    await until("no-workflow explanation", async () => {
      const latest = await c.call<{ messages: { text: string }[] }>(
        "GET",
        `/api/conversations/${conv.id}`,
      );
      return latest.messages.at(-1)?.text.includes("No workflow handles chat messages");
    });
    await c.call("PATCH", `/api/workflows/${assistant?.id}`, { enabled: true });
  });

  it("installs the Discord assistant, answers in Discord, and sends task updates back there", async () => {
    const templates = await c.call<{ key: string; bindings: { placeholder: string }[] }[]>(
      "GET",
      "/api/templates",
    );
    expect(templates.map((t) => t.key)).toEqual(
      expect.arrayContaining(["sling-assistant", "discord-assistant"]),
    );
    expect(
      (await c.raw("POST", "/api/workflows", { templateKey: "discord-assistant" })).status,
    ).toBe(400);

    const inst = await c.call<{ id: string }>("POST", "/api/installations", {
      connectorId: "discord",
      name: "Sling bot",
      credentials: { botToken: "discord-bot-token" },
      config: { allowedUserIds: ["u1"] },
    });
    const wf = await c.call<Detail>("POST", "/api/workflows", {
      templateKey: "discord-assistant",
      bindings: { $discord: inst.id },
      name: "Help desk",
    });
    expect(wf.name).toBe("Help desk");
    expect(wf.activeVersion).toBe(1);
    expect(wf.enabled).toBe(false);
    const trigger = wf.draft.nodes.find((x) => x.type === "discord.message_received");
    expect(trigger?.config.installationId).toBe(inst.id);
    await c.call("PATCH", `/api/workflows/${wf.id}`, { enabled: true });

    const m = await workspace();
    const sentBefore = discordSent.length;
    const [first] = await server.ctx.events.emit({
      type: "discord.message_received",
      workspaceId: m.workspaceId,
      installationId: inst.id,
      payload: {
        id: "dm1",
        channelId: "chan-9",
        guildId: null,
        isDM: true,
        author: { id: "u1", username: "tiago" },
        content: "fix the footer year in site",
        mentionsBot: false,
        createdAt: new Date().toISOString(),
      },
      dedupeKey: "dm1",
    });
    if (!first) throw new Error("no run");
    expect(first.concurrencyKey).toBe(`discord:${inst.id}:chan-9`);
    await settled(c, first.id, ["succeeded"]);
    expect(discordSent.slice(sentBefore)).toEqual([
      expect.objectContaining({
        installationId: inst.id,
        channelId: "chan-9",
        content: "Hi from Sling",
        nonce: `${first.id}:send:0`,
      }),
    ]);
    const [conv] = await server.ctx.db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.workspaceId, m.workspaceId),
          eq(schema.conversations.externalKey, `discord:${inst.id}:chan-9`),
        ),
      );
    expect(conv).toMatchObject({ workflowId: wf.id, title: "Discord: tiago" });
    const dd = await c.call<{ messages: { role: string; text: string }[] }>(
      "GET",
      `/api/conversations/${conv?.id}`,
    );
    expect(dd.messages.map((x) => x.role)).toEqual(["user", "assistant"]);

    // A task in this conversation settles: the note goes back to the Discord workflow only.
    const runnerId = newId("rnr");
    await server.ctx.db.insert(schema.runners).values({
      id: runnerId,
      workspaceId: m.workspaceId,
      ownerId: m.userId,
      name: "laptop",
      publicKey: Buffer.alloc(32, 2).toString("base64"),
    });
    const repoId = newId("rpo");
    await server.ctx.db.insert(schema.repos).values({
      id: repoId,
      workspaceId: m.workspaceId,
      ownerId: m.userId,
      runnerId,
      name: "site",
      defaultBranch: "main",
    });
    const taskId = newId("tsk");
    await server.ctx.db.insert(schema.tasks).values({
      id: taskId,
      workspaceId: m.workspaceId,
      ownerId: m.userId,
      conversationId: conv?.id ?? null,
      runnerId,
      repoId,
      repoName: "site",
      title: "Fix the footer year",
      objective: "x",
      mode: "auto",
      state: "succeeded",
      branch: taskBranch(taskId, "x"),
    });
    const assistantRunsBefore = (
      await c.call<RunView[]>(
        "GET",
        `/api/workflows/${(await server.ctx.workflows.assistantId(m.workspaceId)) ?? ""}/runs`,
      )
    ).length;
    await server.ctx.tasks.onSettled?.(taskId, "finished");
    await until("reply in Discord", async () => discordSent.length === sentBefore + 2);
    expect(discordSent.at(-1)).toMatchObject({ channelId: "chan-9", content: "Hi from Sling" });
    const assistantRunsAfter = (
      await c.call<RunView[]>(
        "GET",
        `/api/workflows/${(await server.ctx.workflows.assistantId(m.workspaceId)) ?? ""}/runs`,
      )
    ).length;
    expect(assistantRunsAfter).toBe(assistantRunsBefore);
    await c.call("PATCH", `/api/workflows/${wf.id}`, { enabled: false });
  });
});

describe("http.request", () => {
  it("retries GET on 5xx, never retries POST, and can pass errors on", async () => {
    let flaky = 0;
    let posts = 0;
    const http = (await import("node:http")).createServer((req, res) => {
      if (req.url === "/flaky") {
        flaky++;
        res.writeHead(flaky < 3 ? 503 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ flaky }));
      } else if (req.url === "/post") {
        posts++;
        let body = "";
        req.on("data", (b) => {
          body += b;
        });
        req.on("end", () => {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`got ${body}`);
        });
      } else {
        res.writeHead(404);
        res.end("nope");
      }
    });
    await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    server.ctx.config.httpAllowedOrigins = [base];
    try {
      const get = await deploy(
        c,
        def(
          "GET",
          [
            n("t", "core.manual"),
            n("h", "http.request", { url: `={{ '${base}' & trigger.input.path }}` }),
          ],
          [x("t.next", "h")],
        ),
      );
      const r = await settled(c, (await start(c, get.id, { path: "/flaky" })).id);
      expect(r.run.status).toBe("succeeded");
      expect(byNode(r, "h").map((nr) => [nr.attempt, nr.status])).toEqual([
        [1, "failed"],
        [2, "failed"],
        [3, "succeeded"],
      ]);
      expect(byNode(r, "h")[2]?.outputs?.response).toMatchObject({
        status: 200,
        ok: true,
        body: { flaky: 3 },
      });

      const post = await deploy(
        c,
        def(
          "POST",
          [n("t", "core.manual"), n("h", "http.request", { method: "POST", url: `${base}/post` })],
          [x("t.next", "h"), d("t.input", "h.body")],
        ),
      );
      const p = await settled(c, (await start(c, post.id, { hello: 1 })).id);
      expect(p.run.status).toBe("failed");
      expect(p.run.error).toMatchObject({ code: "http_error", nodeId: "h" });
      expect(posts).toBe(1);

      const lenient = await deploy(
        c,
        def(
          "Lenient",
          [
            n("t", "core.manual"),
            n("h", "http.request", { method: "POST", url: `${base}/post`, failOnError: false }),
          ],
          [x("t.next", "h"), d("t.input", "h.body")],
        ),
      );
      const l = await settled(c, (await start(c, lenient.id, { hello: 2 })).id);
      expect(l.run.status).toBe("succeeded");
      expect(byNode(l, "h")[0]?.outputs?.response).toMatchObject({
        status: 502,
        ok: false,
        body: 'got {"hello":2}',
      });
    } finally {
      http.close();
    }
  });
});

describe("http.request network policy", () => {
  it("reaches an internal origin only when allowed, never metadata, and doesn't retry a refusal", async () => {
    let hits = 0;
    const http = (await import("node:http")).createServer((_req, res) => {
      hits++;
      res.end("internal");
    });
    await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const before = server.ctx.config.httpAllowedOrigins;
    const metadata = "http://169.254.169.254";
    try {
      const wf = await deploy(
        c,
        def(
          "Policy",
          [n("t", "core.manual"), n("h", "http.request", { url: "={{ trigger.input.url }}" })],
          [x("t.next", "h")],
        ),
      );
      server.ctx.config.httpAllowedOrigins = [];
      const refused = await settled(c, (await start(c, wf.id, { url: `${base}/` })).id);
      expect(refused.run.status).toBe("failed");
      expect(refused.run.error).toMatchObject({ code: "forbidden_destination", nodeId: "h" });
      expect(refused.run.error?.message).toContain("outside the configured HTTP network policy");
      expect(byNode(refused, "h")).toHaveLength(1);
      expect(hits).toBe(0);

      server.ctx.config.httpAllowedOrigins = [base, metadata];
      const meta = await settled(
        c,
        (await start(c, wf.id, { url: `${metadata}/latest/meta-data/` })).id,
      );
      expect(meta.run.error).toMatchObject({ code: "forbidden_destination" });
      expect(meta.run.error?.message).toContain("metadata");

      const ok = await settled(c, (await start(c, wf.id, { url: `${base}/` })).id);
      expect(ok.run.status).toBe("succeeded");
      expect(byNode(ok, "h")[0]?.outputs?.response).toMatchObject({
        status: 200,
        body: "internal",
      });
      expect(hits).toBe(1);
    } finally {
      server.ctx.config.httpAllowedOrigins = before;
      http.close();
    }
  });
});

describe("data and AI nodes", () => {
  it("stores values across runs and caps stored payloads", async () => {
    const setter = await deploy(
      c,
      def(
        "KV",
        [
          n("t", "core.manual"),
          n("set", "state.kv_set", { key: "counter" }),
          n("get", "state.kv_get", { key: "counter" }),
          n("rec", "test.record", { tag: "kv" }),
        ],
        [
          x("t.next", "set"),
          x("set.next", "get"),
          x("get.next", "rec"),
          d("t.input", "set.value"),
          d("get.value", "rec.value"),
        ],
      ),
    );
    const r1 = await settled(c, (await start(c, setter.id, { n: 1 })).id);
    expect(callsFor(r1.run.id, "kv")[0]?.value).toEqual({ n: 1 });

    const big = await deploy(
      c,
      def(
        "Big",
        [
          n("t", "core.manual"),
          n("make", "core.transform", { expression: "$join([1..20000].('xxxx'))" }),
          n("rec", "test.record", { tag: "big" }),
        ],
        [x("t.next", "make"), x("make.next", "rec"), d("make.result", "rec.value")],
      ),
    );
    const r2 = await settled(c, (await start(c, big.id)).id);
    expect(String(callsFor(r2.run.id, "big")[0]?.value).length).toBe(80_000);
    expect(byNode(r2, "make")[0]?.outputs).toMatchObject({ _truncated: true });
    expect(byNode(r2, "make")[0]?.outputs?.size).toBeGreaterThan(64 * 1024);

    // Payloads past 30 days are pruned.
    await server.ctx.db
      .update(schema.nodeRuns)
      .set({ startedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.nodeRuns.runId, r2.run.id));
    expect(await server.ctx.engine.prunePayloads()).toBeGreaterThan(0);
    const pruned = await c.call<RunDetailView>("GET", `/api/runs/${r2.run.id}`);
    expect(pruned.nodeRuns.every((nr) => nr.inputs === null && nr.outputs === null)).toBe(true);
  });

  it("prompts, extracts, and classifies with the workspace model", async () => {
    const wf = await deploy(
      c,
      def(
        "AI",
        [
          n("t", "core.manual"),
          n("sum", "ai.prompt", { prompt: "Summarize this email." }),
          n("ext", "ai.extract", {
            prompt: "Pull out action items.",
            schema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                actionItems: { type: "array", items: { type: "string" } },
              },
            },
          }),
          n("cls", "ai.classify", { labels: [{ label: "urgent" }, { label: "later" }] }),
          n("u", "test.record", { tag: "urgent" }),
          n("l", "test.record", { tag: "later" }),
        ],
        [
          x("t.next", "sum"),
          x("sum.next", "ext"),
          x("ext.next", "cls"),
          x("cls.urgent", "u"),
          x("cls.later", "l"),
          d("t.input", "sum.context"),
          d("t.input", "ext.context"),
          d("t.input", "cls.context"),
          d("ext.result", "u.value"),
        ],
      ),
    );
    const r = await settled(c, (await start(c, wf.id, { subject: "[urgent] server down" })).id);
    expect(r.run.status).toBe("succeeded");
    expect(byNode(r, "sum")[0]?.outputs?.text).toMatch(/^Summary of: /);
    expect(byNode(r, "cls")[0]).toMatchObject({ execPort: "urgent", outputs: { label: "urgent" } });
    expect(callsFor(r.run.id, "urgent")[0]?.value).toEqual({
      summary: "Lunch moved",
      actionItems: ["Reply to Ana"],
    });
    const r2 = await settled(c, (await start(c, wf.id, { subject: "newsletter" })).id);
    expect(byNode(r2, "cls")[0]?.execPort).toBe("later");
  });

  it("keeps engine overhead per node under 5 ms at p95", async () => {
    const wf = await deploy(
      c,
      def(
        "Overhead",
        [
          n("t", "core.manual"),
          n("each", "core.for_each", { items: "={{ [1..200] }}" }),
          n("step", "core.transform", { expression: "inputs.value + 1" }),
          n("ret", "core.return", { value: "={{ 'done' }}" }),
        ],
        [
          x("t.next", "each"),
          x("each.each", "step"),
          x("each.done", "ret"),
          d("each.item", "step.value"),
        ],
      ),
    );
    const before = server.ctx.engine.overheadMs.length;
    const r = await settled(c, (await start(c, wf.id)).id, ["succeeded"], 60_000);
    expect(r.nodeRuns).toHaveLength(203);
    const samples = server.ctx.engine.overheadMs.slice(before).sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
    console.log(
      `engine overhead per node over ${samples.length} nodes: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`,
    );
    expect(samples.length).toBeGreaterThanOrEqual(202);
    withinBudget(p95, 5);
  });
});

describe("restarts", () => {
  it("keeps a timer wait across a server restart", async () => {
    const url = await freshDatabase("restart_timer");
    const a = await boot(url);
    const ca = new Client(a.url);
    await ca.signUp();
    const wf = await deploy(
      ca,
      def(
        "Timer",
        [
          n("t", "core.manual"),
          n("w", "core.wait", { seconds: 2 }),
          n("rec", "test.record", { tag: "after-timer" }),
        ],
        [x("t.next", "w"), x("w.next", "rec")],
      ),
    );
    const run = await start(ca, wf.id);
    await settled(ca, run.id, ["waiting"]);
    await a.close();

    const b = await boot(url);
    extra.push(b);
    const restartedAt = Date.now();
    const cb = new Client(b.url);
    await cb.call("POST", "/api/auth/sign-in/email", {
      email: "admin@example.com",
      password: "correct-horse-battery",
    });
    const r = await settled(cb, run.id, ["succeeded"], 20_000);
    const wait = byNode(r, "w")[0];
    expect(wait?.status).toBe("succeeded");
    expect(wait?.durationMs ?? 0).toBeGreaterThanOrEqual(1900);
    expect(new Date(r.run.finishedAt ?? 0).getTime()).toBeGreaterThanOrEqual(restartedAt);
    expect(callsFor(run.id, "after-timer")).toHaveLength(1);
    await expect(boot(url)).rejects.toThrow("Another Sling control plane");
    await b.close();
    // Without the Discord connector, its template isn't offered.
    const plain = await boot(url, { connectors: [] });
    extra.push(plain);
    const cp = new Client(plain.url);
    await cp.call("POST", "/api/auth/sign-in/email", {
      email: "admin@example.com",
      password: "correct-horse-battery",
    });
    const keys = (await cp.call<{ key: string }[]>("GET", "/api/templates")).map((t) => t.key);
    expect(keys).toContain("sling-assistant");
    expect(keys).not.toContain("discord-assistant");
  });

  it("holds automation while paused and resumes it on a normal start", async () => {
    const url = await freshDatabase("paused_restore");
    const a = await boot(url);
    const ca = new Client(a.url);
    await ca.signUp();
    const inst = await ca.call<{ id: string }>("POST", "/api/installations", {
      connectorId: "fake",
      name: "Paused source",
      credentials: { token: "good-token-123" },
      config: { label: "paused" },
    });
    await deploy(
      ca,
      def(
        "Source while paused",
        [
          n("t", "fake.event", { installationId: inst.id, topic: "mail" }),
          n("rec", "test.record", { tag: "paused-source" }),
        ],
        [x("t.next", "rec")],
      ),
      { enable: true },
    );
    const hook = await deploy(
      ca,
      def(
        "Hook while paused",
        [n("t", "core.webhook"), n("rec", "test.record", { tag: "paused-hook" })],
        [x("t.next", "rec")],
      ),
      { enable: true },
    );
    const timer = await deploy(
      ca,
      def(
        "Timer while paused",
        [
          n("t", "core.manual"),
          n("w", "core.wait", { seconds: 1 }),
          n("rec", "test.record", { tag: "paused-timer" }),
        ],
        [x("t.next", "w"), x("w.next", "rec")],
      ),
    );
    const waiting = await start(ca, timer.id);
    await settled(ca, waiting.id, ["waiting"]);
    await a.close();

    const startsBefore = fakeSource.starts;
    const paused = await startServer(
      { ...configFor(url), automationPaused: true },
      { model, jobs: false, nodes: testNodes, connectors: [fakeConnector, fakeDiscord] },
    );
    const cp = new Client(paused.url);
    await cp.call("POST", "/api/auth/sign-in/email", {
      email: "admin@example.com",
      password: "correct-horse-battery",
    });
    const hookUrl = (hook.webhooks[0]?.url ?? "").replace(/^https?:\/\/[^/]+/, paused.url);
    const refused = await fetch(hookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(refused.status).toBe(503);
    const queued = await start(cp, timer.id);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await cp.call<RunDetailView>("GET", `/api/runs/${waiting.id}`)).run.status).toBe(
      "waiting",
    );
    expect((await cp.call<RunDetailView>("GET", `/api/runs/${queued.id}`)).run.status).toBe(
      "queued",
    );
    expect(callsFor(waiting.id)).toHaveLength(0);
    expect(fakeSource.starts).toBe(startsBefore);
    const installs = await cp.call<{ id: string; status: string }[]>("GET", "/api/installations");
    expect(installs.find((i) => i.id === inst.id)?.status).toBe("idle");
    await paused.close();

    const resumed = await boot(url);
    extra.push(resumed);
    const cr = new Client(resumed.url);
    await cr.call("POST", "/api/auth/sign-in/email", {
      email: "admin@example.com",
      password: "correct-horse-battery",
    });
    await settled(cr, waiting.id, ["succeeded"], 20_000);
    await settled(cr, queued.id, ["succeeded"], 20_000);
    expect(callsFor(waiting.id, "paused-timer")).toHaveLength(1);
    expect(callsFor(queued.id, "paused-timer")).toHaveLength(1);
    await until("source started", async () => fakeSource.starts > startsBefore);
    await resumed.close();
  });

  it("resumes after the executor is killed mid-node: idempotent nodes rerun, others fail", async () => {
    const url = await freshDatabase("crash_test");
    child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        join(import.meta.dirname, "fixtures/engine-child.ts"),
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: url,
          SLING_PUBLIC_URL: ORIGIN,
          SLING_SECRET_KEY: SECRET,
          SLING_TEST_BLOCK: "1",
        },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const childUrl = await new Promise<string>((ok, fail) => {
      let out = "";
      child?.stdout?.on("data", (b: Buffer) => {
        out += b.toString();
        const m = /READY (\S+)/.exec(out);
        if (m?.[1]) ok(m[1]);
      });
      child?.once("exit", (code) => fail(new Error(`child exited ${code}`)));
    });
    const cc = new Client(childUrl);
    await cc.signUp();
    const unsafe = await deploy(
      cc,
      def(
        "Unsafe",
        [
          n("t", "core.manual"),
          n("b", "test.block"),
          n("rec", "test.record", { tag: "unsafe-after" }),
        ],
        [x("t.next", "b"), x("b.next", "rec")],
      ),
    );
    const safe = await deploy(
      cc,
      def(
        "Safe",
        [
          n("t", "core.manual"),
          n("b", "test.block_safe"),
          n("rec", "test.record", { tag: "safe-after" }),
        ],
        [x("t.next", "b"), x("b.next", "rec"), d("b.attempt", "rec.value")],
      ),
    );
    const r1 = await start(cc, unsafe.id);
    const r2 = await start(cc, safe.id);
    for (const id of [r1.id, r2.id]) {
      await until(`${id} blocked`, async () => {
        const dd = await cc.call<RunDetailView>("GET", `/api/runs/${id}`);
        return byNode(dd, "b")[0]?.status === "running";
      });
    }
    const exited = new Promise((ok) => child?.once("exit", ok));
    child.kill("SIGKILL");
    await exited;

    const b = await boot(url);
    extra.push(b);
    const cb = new Client(b.url);
    await cb.call("POST", "/api/auth/sign-in/email", {
      email: "admin@example.com",
      password: "correct-horse-battery",
    });
    const failed = await settled(cb, r1.id);
    expect(failed.run.status).toBe("failed");
    expect(failed.run.error).toEqual({
      message: "Interrupted, outcome unknown",
      code: "interrupted",
      nodeId: "b",
    });
    expect(byNode(failed, "b").map((nr) => [nr.attempt, nr.status])).toEqual([[1, "failed"]]);
    expect(callsFor(r1.id)).toEqual([]);

    const resumed = await settled(cb, r2.id);
    expect(resumed.run.status).toBe("succeeded");
    expect(
      byNode(resumed, "b").map((nr) => [nr.attempt, nr.status, nr.error?.code ?? null]),
    ).toEqual([
      [1, "failed", "interrupted"],
      [2, "succeeded", null],
    ]);
    expect(callsFor(r2.id, "safe-after").map((x) => x.value)).toEqual([2]);
  }, 60_000);
});

describe("durable chat acceptance", () => {
  it("dispatches an accepted message after the process restarts before delivery", async () => {
    const url = await freshDatabase("chat_outbox");
    const first = await boot(url, { deliveries: false });
    const client = new Client(first.url);
    await client.signUp();
    const conv = await client.call<{ id: string }>("POST", "/api/conversations", {});
    const msg = await client.call<{ id: string }>(
      "POST",
      `/api/conversations/${conv.id}/messages`,
      { text: "hello after restart" },
    );
    const [delivery] = await first.ctx.db
      .select()
      .from(schema.deliveries)
      .where(eq(schema.deliveries.id, msg.id));
    expect(delivery?.completedAt).toBeNull();
    await first.close();
    const second = await boot(url);
    extra.push(second);
    await until("durable dispatch", async () => {
      const [row] = await second.ctx.db
        .select()
        .from(schema.deliveries)
        .where(eq(schema.deliveries.id, msg.id));
      return row?.completedAt;
    });
    const runs = await second.ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.dedupeKey, msg.id));
    expect(runs).toHaveLength(1);
  });

  it("retries a message whose reply fails to start, says so once, and starts it once", async () => {
    const url = await freshDatabase("chat_retry");
    const server = await boot(url, { deliveries: false });
    extra.push(server);
    const client = new Client(server.url);
    await client.signUp();
    const conv = await client.call<{ id: string }>("POST", "/api/conversations", {});
    const msg = await client.call<{ id: string }>(
      "POST",
      `/api/conversations/${conv.id}/messages`,
      { text: "hello through a flaky start" },
    );
    const emit = server.ctx.events.emit.bind(server.ctx.events);
    let failures = 0;
    server.ctx.events.emit = (async (...args: Parameters<typeof emit>) => {
      if (failures < RETRY_NOTE_AFTER + 1) {
        failures++;
        throw new Error("trigger start failed");
      }
      return emit(...args);
    }) as typeof emit;
    const notes = async () =>
      (
        await server.ctx.db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.conversationId, conv.id))
      ).filter((m) => m.role !== "user");
    const tryNow = async () => {
      await server.ctx.db
        .update(schema.deliveries)
        .set({ availableAt: new Date(0) })
        .where(eq(schema.deliveries.id, msg.id));
      await drainDeliveries(server.ctx);
    };
    for (let i = 0; i < RETRY_NOTE_AFTER + 1; i++) await tryNow();
    const said = await notes();
    expect(said.map((m) => (m.content as { content: string }).content)).toEqual([RETRYING_NOTE]);

    await tryNow();
    const [delivery] = await server.ctx.db
      .select()
      .from(schema.deliveries)
      .where(eq(schema.deliveries.id, msg.id));
    expect(delivery?.completedAt).not.toBeNull();
    expect(delivery?.attempts).toBe(RETRY_NOTE_AFTER + 1);
    const runs = await server.ctx.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.dedupeKey, msg.id));
    expect(runs).toHaveLength(1);
    // It found its workflow, so the no-workflow message never shows.
    expect(
      (await notes()).some((m) => (m.content as { content: string }).content === NO_CHAT_WORKFLOW),
    ).toBe(false);
  });
});
