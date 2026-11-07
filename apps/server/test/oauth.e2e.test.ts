/**
 * Signing in with OAuth, end to end: real Postgres, the control plane
 * in-process, and the calendar connector's Google kind, against a local
 * stand-in for Google's token endpoint and Calendar API. The consent screen
 * is the one step a browser does on Google; here the stand-in hands out a
 * code for the challenge the start URL carried.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import type { NodeContext } from "@sling/connector-sdk";
import type { OAuthConnectionView, SetupResultView } from "@sling/core";
import { schema } from "@sling/db";
import { createCalendarConnector } from "@sling/integration-calendar";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appTools } from "../src/agent/app-tools.ts";
import type { Config } from "../src/config.ts";
import type { OAuth } from "../src/oauth/service.ts";
import { type RunningServer, startServer } from "../src/server.ts";
import { loadInstallation } from "../src/workflows/connectors/installations.ts";

vi.setConfig({ testTimeout: 60_000 });

const CLIENT_ID = "123-sling.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-test-secret";

// ---------------------------------------------------------------- Google stand-in

/** Codes handed out on "consent", with the PKCE challenge and redirect they were for. */
const codes = new Map<string, { challenge: string; redirect: string }>();
/** Access tokens the Calendar API accepts. */
const live = new Set<string>();
const refreshTokens = new Set<string>();
const grants: Record<string, string>[] = [];
const calendarCalls: string[] = [];
const events: Record<string, unknown>[] = [];

async function form(req: IncomingMessage): Promise<Record<string, string>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return Object.fromEntries(new URLSearchParams(text));
}

/** What the browser would get back from Google's consent screen. */
function consent(authorizeUrl: string): { code: string; state: string } {
  const url = new URL(authorizeUrl);
  const code = `code-${randomBytes(6).toString("hex")}`;
  codes.set(code, {
    challenge: url.searchParams.get("code_challenge") ?? "",
    redirect: url.searchParams.get("redirect_uri") ?? "",
  });
  return { code, state: url.searchParams.get("state") ?? "" };
}

let google: Server;
let googleBase = "";

function startGoogle() {
  google = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, value: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (req.method === "POST" && url.pathname === "/token") {
      const f = await form(req);
      grants.push(f);
      if (f.client_id !== CLIENT_ID || f.client_secret !== CLIENT_SECRET) {
        return json(401, { error: "invalid_client", error_description: "Unauthorized" });
      }
      const issue = (refresh: boolean) => {
        const access = `ya29.${randomBytes(8).toString("hex")}`;
        live.add(access);
        const out: Record<string, unknown> = {
          access_token: access,
          expires_in: 3599,
          scope:
            "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
          token_type: "Bearer",
        };
        if (refresh) {
          const r = `1//refresh-${randomBytes(8).toString("hex")}`;
          refreshTokens.add(r);
          out.refresh_token = r;
        }
        return json(200, out);
      };
      if (f.grant_type === "authorization_code") {
        const code = codes.get(f.code ?? "");
        codes.delete(f.code ?? "");
        const challenge = createHash("sha256")
          .update(f.code_verifier ?? "")
          .digest("base64url");
        if (!code || code.challenge !== challenge) {
          return json(400, { error: "invalid_grant", error_description: "Bad code or verifier" });
        }
        if (code.redirect !== f.redirect_uri) {
          return json(400, { error: "redirect_uri_mismatch", error_description: "Bad redirect" });
        }
        return issue(true);
      }
      if (f.grant_type === "refresh_token") {
        if (!refreshTokens.has(f.refresh_token ?? "")) {
          return json(400, {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          });
        }
        return issue(false);
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      const f = await form(req);
      refreshTokens.delete(f.token ?? "");
      return json(200, {});
    }
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    calendarCalls.push(`${req.method} ${url.pathname} ${token}`);
    if (!live.has(token))
      return json(401, { error: { code: 401, message: "Invalid Credentials" } });
    if (url.pathname === "/calendar/v3/users/me/calendarList") {
      return json(200, {
        items: [
          { id: "ana@gmail.com", summary: "ana@gmail.com", primary: true, accessRole: "owner" },
        ],
      });
    }
    if (url.pathname === "/calendar/v3/calendars/ana%40gmail.com/events") {
      if (req.method === "POST") {
        let text = "";
        for await (const chunk of req) text += chunk;
        const event = { ...JSON.parse(text), status: "confirmed" };
        events.push(event);
        return json(200, event);
      }
      return json(200, { items: events });
    }
    const one = /^\/calendar\/v3\/calendars\/ana%40gmail\.com\/events\/(.+)$/.exec(url.pathname);
    if (one) {
      const hit = events.find((e) => e.id === one[1]);
      return hit ? json(200, hit) : json(404, { error: { code: 404, message: "Not Found" } });
    }
    json(404, { error: { code: 404, message: `no ${url.pathname}` } });
  });
  return new Promise<void>((ok) => google.listen(0, "127.0.0.1", ok));
}

// ---------------------------------------------------------------- harness

let pg: StartedPostgreSqlContainer;
let server: RunningServer;
let origin = "";
let installationId = "";

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => ok(port));
    });
  });
}

/** A browser: its own cookies, and redirects left for the test to follow. */
function browser() {
  let cookie = "";
  return {
    async fetch(method: string, path: string, body?: unknown) {
      const res = await fetch(server.url + path, {
        method,
        redirect: "manual",
        headers: {
          origin,
          cookie,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
      return res;
    },
    async json<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await this.fetch(method, path, body);
      const t = await res.text();
      if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${t}`);
      return (t ? JSON.parse(t) : null) as T;
    },
  };
}

const me = browser();

/** Follows Connect to Google's consent page and back, and returns where Sling sent the browser. */
async function connect(
  b = me,
  id = installationId,
  before?: (consented: { code: string; state: string }) => void,
) {
  const start = await b.fetch("GET", `/api/oauth/google/start?installationId=${id}`);
  expect(start.status).toBe(302);
  const consented = consent(start.headers.get("location") ?? "");
  before?.(consented);
  const back = await b.fetch(
    "GET",
    `/api/oauth/google/callback?code=${consented.code}&state=${encodeURIComponent(consented.state)}`,
  );
  expect(back.status).toBe(302);
  return {
    location: back.headers.get("location") ?? "",
    consented,
    authorize: start.headers.get("location") ?? "",
  };
}

const tokenRow = async () =>
  (
    await server.ctx.db
      .select()
      .from(schema.oauthTokens)
      .where(eq(schema.oauthTokens.installationId, installationId))
  )[0];

beforeAll(async () => {
  await startGoogle();
  googleBase = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
  pg = await new PostgreSqlContainer("postgres:18-alpine").start();
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const config: Config = {
    databaseUrl: pg.getConnectionUri(),
    publicUrl: new URL(origin),
    secretKey: "oauth-e2e-secret-key-that-is-long-enough-1",
    host: "127.0.0.1",
    port,
    logLevel: "warn",
    webDist: undefined,
  };
  server = await startServer(config, {
    jobs: false,
    connectors: [createCalendarConnector({ googleApiUrl: `${googleBase}/calendar/v3` })],
  });
  const oauth = server.ctx.oauth as OAuth;
  oauth.endpoints = {
    google: {
      ...oauth.endpoints.google,
      authorizeUrl: `${googleBase}/authorize`,
      tokenUrl: `${googleBase}/token`,
      revokeUrl: `${googleBase}/revoke`,
    },
  };
  await me.json("POST", "/api/auth/sign-up/email", {
    name: "Admin",
    email: "admin@example.com",
    password: "correct-horse-battery",
  });
  await me.json("PUT", "/api/settings/time-zone", { timeZone: "Europe/Lisbon" });
}, 180_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
  await new Promise<void>((ok) => google?.close(() => ok()));
});

describe("adding a Google calendar", () => {
  it("tells the web app it signs in, and shows the redirect URI to add", async () => {
    const connectors = await me.json<{ id: string; signIn?: unknown }[]>("GET", "/api/connectors");
    expect(connectors.find((c) => c.id === "calendar")?.signIn).toEqual({
      provider: "google",
      providerName: "Google",
      when: { kind: "google" },
      fields: ["clientId", "clientSecret"],
    });
    const found = await me.json<SetupResultView>("POST", "/api/connectors/calendar/setup", {
      credentials: { clientId: CLIENT_ID },
      config: { kind: "google" },
    });
    expect(found.notes?.[0]?.text).toBe(
      `Make an OAuth client ID for a web application, with ${origin}/api/oauth/google/callback as its redirect URI.`,
    );
    const inst = await me.json<{ id: string }>("POST", "/api/installations", {
      connectorId: "calendar",
      name: "Google Calendar",
      credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      config: { kind: "google" },
    });
    installationId = inst.id;
    const test = await me.json<{ ok: boolean; error?: string }>(
      "POST",
      `/api/installations/${installationId}/test`,
    );
    expect(test).toEqual({
      ok: false,
      error: "Not connected yet. Connect it on the Connectors page.",
    });
  });

  it("goes through Google's consent with PKCE and a state, and stores the tokens encrypted", async () => {
    const { location, authorize } = await connect();
    const url = new URL(authorize);
    expect(`${url.origin}${url.pathname}`).toBe(`${googleBase}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `${origin}/api/oauth/google/callback`,
      response_type: "code",
      scope:
        "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    expect(url.searchParams.get("state")).toMatch(/^[\w-]{43}$/);
    expect(location).toBe(`/connectors?oauth=connected&installation=${installationId}`);

    const row = await tokenRow();
    expect(row?.provider).toBe("google");
    expect(row?.scopes).toHaveLength(2);
    // Nothing is stored as Google sent it.
    for (const t of [...refreshTokens, ...live]) {
      expect(JSON.stringify(row)).not.toContain(t);
    }
    const [flow] = await server.ctx.db.select().from(schema.oauthFlows);
    expect(flow).toBeUndefined();
    const audits = await server.ctx.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.verb, "oauth.connected"));
    expect(audits).toHaveLength(1);

    expect(await me.json<OAuthConnectionView[]>("GET", "/api/oauth/connections")).toEqual([
      expect.objectContaining({ installationId, provider: "google" }),
    ]);
    expect(await me.json("POST", `/api/installations/${installationId}/test`)).toEqual({
      ok: true,
      detail: "Found 1 calendar: ana@gmail.com.",
    });
    const edit = await me.json<SetupResultView>("POST", "/api/connectors/calendar/setup", {
      config: { kind: "google" },
      installationId,
    });
    expect(edit.options?.calendars).toEqual([
      { value: "ana@gmail.com", label: "ana@gmail.com", detail: "Yours" },
    ]);
  });

  it("refuses a state used twice, one from another session, and a canceled consent", async () => {
    // The same redirect again.
    const { consented } = await connect();
    const replay = await me.fetch(
      "GET",
      `/api/oauth/google/callback?code=${consented.code}&state=${encodeURIComponent(consented.state)}`,
    );
    expect(new URL(replay.headers.get("location") ?? "", origin).searchParams.get("error")).toMatch(
      /already used/,
    );

    // Started in one browser, finished in another.
    const other = browser();
    await other.json("POST", "/api/auth/sign-in/email", {
      email: "admin@example.com",
      password: "correct-horse-battery",
    });
    const start = await me.fetch("GET", `/api/oauth/google/start?installationId=${installationId}`);
    const elsewhere = consent(start.headers.get("location") ?? "");
    const stolen = await other.fetch(
      "GET",
      `/api/oauth/google/callback?code=${elsewhere.code}&state=${encodeURIComponent(elsewhere.state)}`,
    );
    const q = new URL(stolen.headers.get("location") ?? "", origin).searchParams;
    expect(q.get("oauth")).toBe("failed");
    expect(q.get("installation")).toBe(installationId);
    expect(q.get("error")).toMatch(/another browser session/);

    const start2 = await me.fetch(
      "GET",
      `/api/oauth/google/start?installationId=${installationId}`,
    );
    const state = new URL(start2.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const denied = await me.fetch(
      "GET",
      `/api/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(new URL(denied.headers.get("location") ?? "", origin).searchParams.get("error")).toBe(
      "Google sign-in was canceled.",
    );

    // Signed out, Connect goes back to the page rather than to Google.
    const nobody = browser();
    const out = await nobody.fetch(
      "GET",
      `/api/oauth/google/start?installationId=${installationId}`,
    );
    expect(out.headers.get("location")).toMatch(/^\/connectors\?oauth=failed/);
  });
});

describe("using it", () => {
  it("lists and adds events through Google's API, and reads the event back", async () => {
    const conv = await me.json<{ id: string }>("POST", "/api/conversations");
    await me.json("PATCH", `/api/conversations/${conv.id}`, { mode: "full-access" });
    const [row] = await server.ctx.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conv.id));
    if (!row) throw new Error("no conversation");
    const tools = await appTools(server.ctx, {
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
      conversationId: conv.id,
    });
    type Exec = (input: unknown, o: { toolCallId: string; messages: [] }) => Promise<unknown>;
    const call = (name: string, input: unknown, id: string) =>
      (tools[name]?.execute as unknown as Exec | undefined)?.(input, {
        toolCallId: id,
        messages: [],
      }) as Promise<{
        output?: Record<string, unknown>;
        error?: string;
      }>;
    const added = await call(
      "calendar_create_event",
      { title: "Dentist", start: "2026-11-12T15:00", durationMinutes: 30 },
      "call_dentist",
    );
    expect(added.error).toBeUndefined();
    expect(added.output?.event).toMatchObject({ title: "Dentist", calendar: "ana@gmail.com" });
    const listed = await call("calendar_list_events", { from: "2026-11-12", days: 1 }, "call_list");
    expect(listed.output?.agenda).toContain("15:00–15:30: Dentist (ana@gmail.com)");

    const spec = server.ctx.registry.get("calendar.create_event", 1);
    const ctx: NodeContext = {
      runId: `chat:${conv.id}`,
      nodeId: "calendar_create_event",
      nodeRunId: "call_dentist",
      workflowId: "",
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
      iteration: 0,
      attempt: 1,
      idempotencyKey: "chat:call_dentist",
      signal: AbortSignal.timeout(10_000),
      log: { info() {}, warn() {}, error() {} },
      installation: async (id) =>
        (await loadInstallation(server.ctx, row.workspaceId, id)).installation as never,
      services: { timeZone: async () => "Europe/Lisbon" },
    };
    const verdict = await spec?.verify?.(ctx as never, {
      inputs: {},
      config: { installationId, title: "Dentist", start: "2026-11-12T15:00" },
      outputs: added.output ?? {},
    });
    expect(verdict).toEqual({ state: "passed", message: "In ana@gmail.com, Thu 12 Nov 15:00" });
  });

  it("refreshes an access token within a minute of expiring, once for calls at the same time", async () => {
    await server.ctx.db
      .update(schema.oauthTokens)
      .set({ expiresAt: new Date(Date.now() + 30_000) })
      .where(eq(schema.oauthTokens.installationId, installationId));
    const before = grants.filter((g) => g.grant_type === "refresh_token").length;
    const [a, b] = await Promise.all([
      server.ctx.oauth.accessToken((await tokenRow())?.workspaceId ?? "", installationId),
      server.ctx.oauth.accessToken((await tokenRow())?.workspaceId ?? "", installationId),
    ]);
    expect(a).toBe(b);
    expect(grants.filter((g) => g.grant_type === "refresh_token").length).toBe(before + 1);
    const row = await tokenRow();
    expect(row?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    // The new token is the one Google sees next.
    calendarCalls.length = 0;
    expect(await me.json("POST", `/api/installations/${installationId}/test`)).toMatchObject({
      ok: true,
    });
    expect(calendarCalls.at(-1)).toContain(a);
  });

  it("forgets a grant Google revoked, and says to connect again", async () => {
    refreshTokens.clear();
    await server.ctx.db
      .update(schema.oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.oauthTokens.installationId, installationId));
    const test = await me.json<{ ok: boolean; error?: string }>(
      "POST",
      `/api/installations/${installationId}/test`,
    );
    expect(test).toEqual({
      ok: false,
      error:
        "Google no longer accepts Sling's sign-in for Google Calendar. Connect it again on the Connectors page.",
    });
    expect(await tokenRow()).toBeUndefined();
    expect(await me.json("GET", "/api/oauth/connections")).toEqual([]);
    // Connecting again works as the first time did.
    expect((await connect()).location).toBe(
      `/connectors?oauth=connected&installation=${installationId}`,
    );
  });
});
