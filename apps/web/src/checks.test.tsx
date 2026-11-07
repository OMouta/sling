// @vitest-environment happy-dom
import type {
  ApprovalView,
  CheckResultDetail,
  CheckResultView,
  CheckView,
  DeployTargetView,
  InstallationView,
  MessageView,
  RunnerView,
  SandboxRepoView,
  ServerEvent,
  TaskView,
} from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";
import {
  apiTarget,
  deliveredPrTask,
  deployApprovals,
  deployFailedTask,
  deployWaitingTask,
  devbox,
  docsTarget,
  lockedMac,
  step,
  studioMac,
  websiteTarget,
} from "./test/fixtures.ts";

vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signOut: async () => {},
  },
}));

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[] = [];
let targets: DeployTargetView[] = [];
const checkedAt = () => new Date().toISOString();
let checks: CheckView[] = [];
let messages: MessageView[] = [];
let installations: InstallationView[] = [];
/** Each check's runs, newest first. */
let history = new Map<string, CheckResultView[]>();
let runners: RunnerView[] = [];
let sandboxRepos: SandboxRepoView[] = [];
let tasks: TaskView[] = [];
let approvals: ApprovalView[] = [];
/** What `POST /api/tasks/:id/deploy` answers next. */
let deployAnswer: TaskView | HttpError | null = null;
let clipboard: string[] = [];

function result(
  checkId: string,
  passed: boolean,
  detail: CheckResultDetail,
  message = "",
): CheckResultView {
  return {
    id: `ckr_${Math.random().toString(36).slice(2)}`,
    checkId,
    at: new Date().toISOString(),
    passed,
    state: passed ? "up" : "down",
    message,
    ms: 100,
    detail,
  };
}

/** The site check a deploy target is the deploy part of. */
function fromTarget(t: DeployTargetView): CheckView {
  const id = t.id.replace(/^dpt_/, "chk_");
  const last = t.lastCheck;
  return {
    id,
    name: t.name,
    kind: "site",
    config: { kind: "site", checks: t.checks, versionUrl: t.versionUrl },
    enabled: true,
    intervalSeconds: 60,
    deadline: null,
    runnerId: null,
    runnerName: null,
    installationId: null,
    installationName: null,
    state: !last ? "unknown" : last.up ? "up" : last.failures >= 2 ? "down" : "up",
    stateSince: last?.at ?? null,
    failures: last?.failures ?? 0,
    lastResult: last
      ? {
          ...result(id, last.up, { kind: "site", checks: last.results, versionSeen: null }),
          at: last.at,
          message: last.up ? "Answered 200 in 121 ms" : "Expected 200 to 399, got 502",
        }
      : null,
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    notify: true,
    deploy: {
      id: t.id,
      remoteKey: t.remoteKey,
      method: t.method,
      mergeMethod: t.mergeMethod,
      runnerId: t.runnerId,
      runnerName: t.runnerName,
      command: t.command,
      hook: t.hook,
      settleSeconds: t.settleSeconds,
      timeoutSeconds: t.timeoutSeconds,
      lastDeploy: t.lastDeploy,
    },
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

const backupCheck = (): CheckView => ({
  ...fromTarget(websiteTarget),
  id: "chk_backup",
  name: "Backup",
  kind: "command",
  config: {
    kind: "command",
    command: "test -f ~/Backups/today",
    contains: null,
    timeoutSeconds: 60,
  },
  intervalSeconds: 300,
  runnerId: "rnr_3",
  runnerName: "Studio Mac",
  state: "up",
  lastResult: result(
    "chk_backup",
    true,
    { kind: "command", exitCode: 0, output: "", timedOut: false, error: null },
    "Exited 0 in 40 ms",
  ),
  deploy: null,
});

const replyCheck = (): CheckView => ({
  ...fromTarget(websiteTarget),
  id: "chk_jo",
  name: "Jo replied",
  kind: "reply",
  config: { kind: "reply", from: "jo@silva.pt", subject: "invoice", inReplyTo: null, folder: null },
  intervalSeconds: 300,
  deadline: "2099-11-13T17:00:00.000Z",
  installationId: "ins_mail",
  installationName: "Mail",
  state: "waiting",
  lastResult: {
    ...result("chk_jo", false, { kind: "reply", match: null, error: null }, "No reply yet"),
    state: "waiting",
  },
  deploy: null,
});

const shell = (ready: boolean) => ({ name: "shell", version: "1", ready, detail: "" });

const mailInstallation = {
  id: "ins_mail",
  connectorId: "email",
  name: "Mail",
} as unknown as InstallationView;

function route(method: string, path: string, body: unknown): unknown {
  const key = `${method} ${path}`;
  switch (key) {
    case "GET /api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "GET /api/deploy-targets":
      return targets;
    case "GET /api/checks":
      return checks;
    case "GET /api/installations":
      return installations;
    case "POST /api/checks": {
      const b = body as CheckView;
      const created: CheckView = {
        ...fromTarget(websiteTarget),
        ...b,
        id: "chk_new",
        state: "unknown",
        lastResult: null,
        deploy: null,
      };
      checks = [...checks, created];
      return created;
    }
    case "GET /api/runners":
      return runners;
    case "GET /api/sandbox-repos":
      return sandboxRepos;
    case "GET /api/approvals":
      return approvals;
    case "GET /api/tasks":
      return tasks;
    case "GET /api/conversations":
    case "GET /api/personalities":
      return [];
    case "GET /api/conversations/cnv_1":
      return {
        conversation: {
          id: "cnv_1",
          title: "Checkout is down",
          mode: "auto",
          settings: { assistant: null, agent: null },
          personalityId: null,
          createdAt: "2026-11-06T17:00:00.000Z",
          updatedAt: "2026-11-06T18:00:00.000Z",
        },
        messages,
        tasks: tasks.filter((t) => t.conversationId === "cnv_1"),
        agentStatus: "idle",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    case "POST /api/deploy-targets": {
      const b = body as DeployTargetView;
      const created = { ...websiteTarget, ...b, id: "dpt_new", lastCheck: null, lastDeploy: null };
      targets = [...targets, created];
      return created;
    }
  }
  const check = /^\/api\/checks\/([^/]+)(\/run|\/results)?$/.exec(path);
  if (check) {
    const [, id, sub] = check;
    const found = checks.find((c) => c.id === id);
    if (!found) throw new HttpError(404, "No such check");
    if (method === "GET" && sub === "/results") return history.get(found.id) ?? [];
    if (method === "POST" && sub === "/run") {
      const pages = found.config.kind === "site" ? found.config.checks : [];
      const r = result(
        found.id,
        false,
        {
          kind: "site",
          checks: pages.map((c) => ({
            url: c.url,
            ok: false,
            status: 503,
            ms: 250,
            error: "Expected 200 to 399, got 503",
          })),
          versionSeen: null,
        },
        `${pages[0]?.url}: 503 (Expected 200 to 399, got 503)`,
      );
      const next: CheckView = { ...found, state: "down", failures: 2, lastResult: r };
      history.set(found.id, [
        r,
        ...(history.get(found.id) ?? (found.lastResult ? [found.lastResult] : [])),
      ]);
      checks = checks.map((c) => (c.id === id ? next : c));
      return next;
    }
    if (method === "PATCH") {
      const b = body as Partial<CheckView> & { deploy?: unknown };
      const next = { ...found, ...b, deploy: b.deploy === null ? null : found.deploy } as CheckView;
      checks = checks.map((c) => (c.id === id ? next : c));
      return next;
    }
    if (method === "DELETE") {
      checks = checks.filter((c) => c.id !== id);
      return undefined;
    }
  }
  const target = /^\/api\/deploy-targets\/([^/]+)(\/check)?$/.exec(path);
  if (target) {
    const [, id, check] = target;
    const found = targets.find((t) => t.id === id);
    if (!found) throw new HttpError(404, "No such target");
    if (method === "POST" && check) {
      const next: DeployTargetView = {
        ...found,
        lastCheck: {
          at: new Date().toISOString(),
          up: false,
          failures: 1,
          results: found.checks.map((c) => ({
            url: c.url,
            ok: false,
            status: 503,
            ms: 250,
            error: "Expected 200 to 399, got 503",
          })),
        },
      };
      targets = targets.map((t) => (t.id === id ? next : t));
      return next;
    }
    if (method === "PATCH") {
      const next = { ...found, ...(body as object) } as DeployTargetView;
      targets = targets.map((t) => (t.id === id ? next : t));
      return next;
    }
    if (method === "DELETE") {
      targets = targets.filter((t) => t.id !== id);
      return undefined;
    }
  }
  const taskDeploy = /^\/api\/tasks\/([^/]+)\/deploy$/.exec(path);
  if (taskDeploy && method === "POST") {
    const answer = deployAnswer;
    if (answer instanceof HttpError) throw answer;
    if (answer) tasks = tasks.map((t) => (t.id === answer.id ? answer : t));
    return answer;
  }
  if (/^\/api\/tasks\/[^/]+\/approval$/.test(path) && method === "POST") return { ok: true };
  const taskId = method === "GET" && /^\/api\/tasks\/([^/]+)$/.exec(path)?.[1];
  const task = taskId && tasks.find((t) => t.id === taskId);
  if (task) return { task, events: [] };
  // Everything else the shell asks for can be empty here.
  if (method === "GET") return null;
  throw new HttpError(500, `unmocked ${key}`);
}

let socket: FakeSocket | null = null;
class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor() {
    socket = this;
  }
  send() {}
  close() {}
}

function emit(ev: ServerEvent) {
  act(() => socket?.onmessage?.({ data: JSON.stringify(ev) }));
}

beforeEach(() => {
  calls = [];
  targets = [websiteTarget, docsTarget, apiTarget];
  checks = [...targets.map(fromTarget), backupCheck(), replyCheck()];
  installations = [];
  history = new Map();
  messages = [];
  runners = [studioMac, devbox];
  sandboxRepos = [];
  tasks = [];
  approvals = [];
  deployAnswer = null;
  clipboard = [];
  socket = null;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: { writeText: async (text: string) => void clipboard.push(text) },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      try {
        const data = route(method, url.pathname, body);
        return new Response(data === undefined ? "" : JSON.stringify(data), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        return new Response(JSON.stringify({ error: (err as Error).message }), { status });
      }
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

function callsTo(method: string, path: string) {
  return calls.filter((c) => c.method === method && c.path === path);
}

async function checkCard(name: string) {
  return within(await screen.findByRole("article", { name }));
}

/** Each line of a list, as text. */
function lines(list: HTMLElement): string[] {
  return [...list.querySelectorAll("li")].map((li) => li.textContent ?? "");
}

/** The text of the `dd` that a `dt` labels, inside a card. */
function fact(card: ReturnType<typeof within>, label: string): string {
  return card.getByText(label).nextElementSibling?.textContent ?? "";
}

async function openMenu(name: string, item: string) {
  fireEvent.click(await screen.findByRole("button", { name: `${name} actions` }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

async function openAddDialog() {
  renderAt("/checks");
  fireEvent.click((await screen.findAllByRole("button", { name: "Add check" }))[0] as HTMLElement);
  return within(await screen.findByRole("dialog", { name: "Add a check" }));
}

type Scope = ReturnType<typeof within>;

async function pickRepo(d: Scope, remote: string) {
  fireEvent.click(await d.findByRole("radio", { name: new RegExp(remote.replace(/[.]/g, "\\.")) }));
}

function next(d: Scope) {
  fireEvent.click(d.getByRole("button", { name: "Continue" }));
}

function fillCheck(d: Scope, url: string) {
  fireEvent.change(d.getByLabelText("URL to check"), { target: { value: url } });
}

function pickKind(d: Scope, name: RegExp) {
  fireEvent.click(d.getByRole("radio", { name }));
}

const KIND_CARD = { site: /^A site/, command: /^A command on a machine/, reply: /^An email reply/ };

const METHOD_CARD = {
  merge: /^When it's merged/,
  command: /^A command on one of your machines/,
  hook: /^A deploy hook/,
};

describe("checks in place of deploys", () => {
  it("sends old links to Checks, which the sidebar lists where Deploys was, after Memory", async () => {
    const { router } = renderAt("/deploys");
    await checkCard("Website");
    expect(router.state.location.pathname).toBe("/checks");
    const nav = screen.getAllByRole("link").map((l) => l.textContent);
    expect(nav).toContain("Checks");
    expect(nav).not.toContain("Deploys");
    expect(nav.indexOf("Memory")).toBe(nav.indexOf("Personalities") + 1);
    expect(nav.indexOf("Checks")).toBe(nav.indexOf("Sandboxes") + 1);
  });

  it("has a Memory page", async () => {
    renderAt("/memory");
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeTruthy();
  });
});

describe("checks page", () => {
  it("lists every check: sites with how they deploy, commands, and replies", async () => {
    renderAt("/checks");
    const site = await checkCard("Website");
    expect(site.getByText("example.com, example.com/health")).toBeTruthy();
    expect(fact(site, "Deploys")).toBe("Runs fly deploy on Studio Mac");
    expect(site.getByText("Up").parentElement?.textContent).toMatch(
      /^Up · 121 ms · checked .+ ago$/,
    );
    const last = site.getByRole("link", { name: "Fix the 500 on checkout" });
    expect(last.getAttribute("href")).toBe("/tasks/tsk_fix");
    expect(fact(site, "Last deploy")).toMatch(/^Fix the 500 on checkout9f8e7d6cDone.+$/);
    expect(lines(site.getByRole("list", { name: "Website pages" }))).toEqual([
      "example.com200 · 84 ms",
      "example.com/health200 · 121 ms",
    ]);

    const docs = await checkCard("Docs");
    expect(fact(docs, "Deploys")).toBe("Host deploys on merge");
    expect(docs.getByText("Down").parentElement?.textContent).toMatch(/3 failures in a row/);
    expect(docs.getByText("Expected 200 to 399, got 502")).toBeTruthy();
    expect(fact(docs, "Last deploy")).toBe("Never");

    const api = await checkCard("API");
    expect(fact(api, "Deploys")).toBe("Calls a hook on api.render.com");
    // One page says nothing the header doesn't.
    expect(api.getAllByText("Not checked yet")).toHaveLength(1);

    const backup = await checkCard("Backup");
    expect(backup.getByText("test -f ~/Backups/today")).toBeTruthy();
    expect(backup.getByText(/on Studio Mac/)).toBeTruthy();
    expect(backup.getByText("Passing").parentElement?.textContent).toMatch(/^Passing · /);
    expect(backup.queryByText("Deploys")).toBeNull();

    const jo = await checkCard("Jo replied");
    expect(jo.getByText("from jo@silva.pt, “invoice”")).toBeTruthy();
    expect(jo.getByText("Waiting").parentElement?.textContent).toMatch(/due by /);
    expect(jo.getByText("No reply yet")).toBeTruthy();
    // One check is down, and the header says so.
    expect(screen.getByText("1 down")).toBeTruthy();
  });

  it("shows a centered empty state with nothing added", async () => {
    checks = [];
    targets = [];
    renderAt("/checks");
    const empty = (await screen.findByText("Nothing watched yet")).parentElement as HTMLElement;
    expect(empty.className).toContain("justify-center");
    expect(within(empty).getByRole("button", { name: "Add check" })).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("follows checks as they change, appear, and go away", async () => {
    renderAt("/checks");
    await checkCard("Docs");
    const docs = checks.find((c) => c.name === "Docs") as CheckView;
    emit({
      type: "check.changed",
      check: {
        ...docs,
        state: "up",
        failures: 0,
        lastResult: result(docs.id, true, {
          kind: "site",
          checks: [
            { url: "https://docs.example.com/", ok: true, status: 200, ms: 70, error: null },
          ],
          versionSeen: null,
        }),
      },
    });
    expect((await checkCard("Docs")).getByText("Up")).toBeTruthy();
    expect(screen.queryByText("1 down")).toBeNull();
    emit({ type: "check.changed", check: { ...docs, id: "chk_blog", name: "Blog", deploy: null } });
    expect(await checkCard("Blog")).toBeTruthy();
    emit({ type: "check.removed", id: docs.id });
    await waitFor(() => expect(screen.queryByRole("article", { name: "Docs" })).toBeNull());
  });

  it("checks one now, and shows its history", async () => {
    renderAt("/checks");
    await openMenu("Website", "Check now");
    await waitFor(() => expect(callsTo("POST", "/api/checks/chk_site/run")).toHaveLength(1));
    const site = await checkCard("Website");
    expect(await site.findByText("Down")).toBeTruthy();
    expect(lines(site.getByRole("list", { name: "Website pages" }))).toEqual([
      "example.com503 · 250 msExpected 200 to 399, got 503",
      "example.com/health503 · 250 msExpected 200 to 399, got 503",
    ]);
    fireEvent.click(site.getByRole("button", { name: "History" }));
    const history = await site.findByRole("list", { name: "Website history" });
    expect(lines(history)).toEqual([
      expect.stringMatching(/^just now.+got 503\)$/),
      expect.stringMatching(/Answered 200 in 121 ms$/),
    ]);
    expect(site.getByRole("list", { name: "Website recent runs" }).children).toHaveLength(2);
  });

  it("pauses a check, and deletes one after asking", async () => {
    renderAt("/checks");
    await openMenu("Backup", "Pause");
    await waitFor(() => expect(callsTo("PATCH", "/api/checks/chk_backup")).toHaveLength(1));
    expect(callsTo("PATCH", "/api/checks/chk_backup")[0]?.body).toEqual({ enabled: false });
    expect(await (await checkCard("Backup")).findByText("Paused")).toBeTruthy();
    await openMenu("Docs", "Delete");
    const confirm = within(await screen.findByRole("dialog", { name: "Delete Docs?" }));
    expect(confirm.getByText(/tasks in github.com\/a\/docs can't deploy/)).toBeTruthy();
    fireEvent.click(confirm.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callsTo("DELETE", "/api/checks/chk_docs")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Docs" })).toBeNull());
  });
});

describe("the check dialog", () => {
  it("adds a site that only gets watched, then says what it saw", async () => {
    const d = await openAddDialog();
    pickKind(d, KIND_CARD.site);
    next(d);
    fillCheck(d, "https://blog.example.com/");
    // The name comes from the page until you type one.
    expect((d.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Blog.example.com");
    fireEvent.change(d.getByLabelText(/^Name/), { target: { value: "Blog" } });
    next(d);
    expect(d.getByRole("radio", { name: /^No, just watch it/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(d.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(callsTo("POST", "/api/checks")).toHaveLength(1));
    expect(callsTo("POST", "/api/checks")[0]?.body).toEqual({
      name: "Blog",
      config: {
        kind: "site",
        checks: [{ url: "https://blog.example.com/", status: null, contains: null }],
        versionUrl: null,
      },
      intervalSeconds: 60,
      notify: true,
    });
    expect(await d.findByText("Blog is set up")).toBeTruthy();
    expect(
      d.getByText("https://blog.example.com/: 503 (Expected 200 to 399, got 503)"),
    ).toBeTruthy();
  });

  it("adds a site the host deploys on merge, with a version URL", async () => {
    targets = [];
    checks = [];
    const d = await openAddDialog();
    pickKind(d, KIND_CARD.site);
    next(d);
    fillCheck(d, "https://example.com/");
    fireEvent.click(d.getByRole("button", { name: "More settings" }));
    fireEvent.change(d.getByLabelText(/^Version URL/), {
      target: { value: "https://example.com/version" },
    });
    next(d);
    await pickRepo(d, "github.com/a/site");
    next(d);
    expect(d.getByRole("radio", { name: METHOD_CARD.merge }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(d.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(callsTo("POST", "/api/checks")).toHaveLength(1));
    expect(callsTo("POST", "/api/checks")[0]?.body).toEqual({
      name: "Site",
      config: {
        kind: "site",
        checks: [{ url: "https://example.com/", status: null, contains: null }],
        versionUrl: "https://example.com/version",
      },
      intervalSeconds: 60,
      notify: true,
      deploy: {
        remoteKey: "github.com/a/site",
        method: "merge",
        mergeMethod: "squash",
        settleSeconds: 60,
        timeoutSeconds: 600,
      },
    });
  });

  it("offers the machines that report a deploy command, and picks the one that can", async () => {
    targets = [];
    checks = [];
    runners = [studioMac, lockedMac, devbox];
    const d = await openAddDialog();
    pickKind(d, KIND_CARD.site);
    next(d);
    fillCheck(d, "https://example.com/health");
    fireEvent.click(d.getByRole("button", { name: "More settings" }));
    fireEvent.change(d.getByLabelText(/^Status/), { target: { value: "200" } });
    fireEvent.change(d.getByLabelText("Page contains"), { target: { value: "ok" } });
    next(d);
    await pickRepo(d, "github.com/a/site");
    next(d);
    fireEvent.click(d.getByRole("radio", { name: METHOD_CARD.command }));
    next(d);
    expect(d.getByRole("heading", { name: "Which machine deploys it?" })).toBeTruthy();
    const machines = d
      .getAllByRole("radio")
      .map((r) => [r.textContent, r.getAttribute("aria-checked")]);
    expect(machines).toEqual([
      ["locked-macRefuses deploys: deploys are off", "false"],
      ["Studio MacRuns fly deploy", "true"],
    ]);
    fireEvent.click(d.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(callsTo("POST", "/api/checks")).toHaveLength(1));
    expect(callsTo("POST", "/api/checks")[0]?.body).toMatchObject({
      config: { checks: [{ url: "https://example.com/health", status: 200, contains: "ok" }] },
      deploy: { method: "command", runnerId: "rnr_3", settleSeconds: 0 },
    });
  });

  it("shows the line that sets a deploy command, and waits for a machine to report it", async () => {
    targets = [];
    checks = [];
    runners = [devbox];
    const d = await openAddDialog();
    pickKind(d, KIND_CARD.site);
    next(d);
    fillCheck(d, "https://example.com/");
    next(d);
    await pickRepo(d, "github.com/a/site");
    next(d);
    fireEvent.click(d.getByRole("radio", { name: METHOD_CARD.command }));
    next(d);
    const line = 'sling-runner repo set site deploy-command "…"';
    expect(d.getByText(line)).toBeTruthy();
    expect(d.getByText("Waiting for a machine to report it")).toBeTruthy();
    expect((d.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(d.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(clipboard).toEqual([line]));
    expect(d.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(callsTo("POST", "/api/checks")).toHaveLength(0);
  });

  it("adds a deploy hook with a header", async () => {
    targets = [];
    checks = [];
    const d = await openAddDialog();
    pickKind(d, KIND_CARD.site);
    next(d);
    fillCheck(d, "https://example.com/");
    next(d);
    await pickRepo(d, "github.com/a/site");
    next(d);
    fireEvent.click(d.getByRole("radio", { name: METHOD_CARD.hook }));
    next(d);
    fireEvent.change(d.getByLabelText(/^Hook URL/), {
      target: { value: "https://api.render.com/deploy/srv-1?key=abc" },
    });
    fireEvent.click(d.getByRole("button", { name: "More settings" }));
    fireEvent.click(d.getByRole("radio", { name: "GET" }));
    fireEvent.change(d.getByLabelText("Header"), { target: { value: "Authorization" } });
    // A header name needs its value before it can go on.
    expect(d.getByText("Add the header's value, or clear its name.")).toBeTruthy();
    expect((d.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(d.getByLabelText("Header value"), { target: { value: "Bearer t0k" } });
    fireEvent.click(d.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(callsTo("POST", "/api/checks")).toHaveLength(1));
    expect(callsTo("POST", "/api/checks")[0]?.body).toMatchObject({
      deploy: {
        method: "hook",
        hook: {
          url: "https://api.render.com/deploy/srv-1?key=abc",
          httpMethod: "GET",
          headerName: "Authorization",
          headerValue: "Bearer t0k",
        },
      },
    });
  });

  it("edits from a summary, and keeps a stored hook unless it's replaced", async () => {
    renderAt("/checks");
    await openMenu("API", "Edit");
    let d = within(await screen.findByRole("dialog", { name: "Edit API" }));
    const row = (label: string) =>
      within(d.getByRole("list", { name: "Settings" }))
        .getByText(label)
        .closest("button") as HTMLElement;
    expect(row("Hook").textContent).toContain("Stored for api.render.com");
    fireEvent.click(row("Name"));
    fireEvent.change(d.getByLabelText(/^Name/), { target: { value: "Public API" } });
    fireEvent.click(d.getByRole("button", { name: "Done" }));
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("PATCH", "/api/checks/chk_api")).toHaveLength(1));
    const kept = callsTo("PATCH", "/api/checks/chk_api")[0]?.body as {
      name: string;
      config: unknown;
      deploy: Record<string, unknown>;
    };
    expect(kept.name).toBe("Public API");
    expect(kept.config).toEqual({
      kind: "site",
      checks: [{ url: "https://api.example.com/health", status: 204, contains: null }],
      versionUrl: null,
    });
    expect(kept.deploy).toMatchObject({ remoteKey: "github.com/a/api", method: "hook" });
    expect("hook" in kept.deploy).toBe(false);

    await openMenu("Public API", "Edit");
    d = within(await screen.findByRole("dialog", { name: "Edit Public API" }));
    fireEvent.click(row("Hook"));
    expect(d.getByText("Stored for api.render.com")).toBeTruthy();
    fireEvent.click(d.getByRole("button", { name: "Replace the hook" }));
    expect((d.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(d.getByPlaceholderText("https://api.example-host.com/deploy/…"), {
      target: { value: "https://api.render.com/deploy/srv-2" },
    });
    fireEvent.click(d.getByRole("button", { name: "Done" }));
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("PATCH", "/api/checks/chk_api")).toHaveLength(2));
    expect(callsTo("PATCH", "/api/checks/chk_api")[1]?.body).toMatchObject({
      deploy: { hook: { url: "https://api.render.com/deploy/srv-2", httpMethod: "POST" } },
    });
  });

  it("stops a site deploying when its repo is set to none", async () => {
    renderAt("/checks");
    await openMenu("Docs", "Edit");
    const d = within(await screen.findByRole("dialog", { name: "Edit Docs" }));
    const row = within(d.getByRole("list", { name: "Settings" }))
      .getByText("Deploys")
      .closest("button") as HTMLElement;
    fireEvent.click(row);
    fireEvent.click(await d.findByRole("radio", { name: /^No, just watch it/ }));
    fireEvent.click(d.getByRole("button", { name: "Done" }));
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("PATCH", "/api/checks/chk_docs")).toHaveLength(1));
    expect(callsTo("PATCH", "/api/checks/chk_docs")[0]?.body).toMatchObject({ deploy: null });
  });

  it("says what's wrong in place, and won't go on", async () => {
    const d = await openAddDialog();
    pickKind(d, KIND_CARD.site);
    next(d);
    fillCheck(d, "example.com");
    expect(d.getByText("Use an http or https URL.")).toBeTruthy();
    expect((d.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fillCheck(d, "https://example.com");
    fireEvent.change(d.getByLabelText(/^Name/), { target: { value: "api" } });
    expect(d.getByText("Another check has this name.")).toBeTruthy();
    expect((d.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(d.getByLabelText(/^Name/), { target: { value: "Fresh" } });
    fireEvent.click(d.getByRole("button", { name: "More settings" }));
    fireEvent.change(d.getByLabelText(/^Status/), { target: { value: "42" } });
    expect(d.getByText("A status is 100 to 599.")).toBeTruthy();
    expect((d.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    expect(callsTo("POST", "/api/checks")).toHaveLength(0);
  });

  it("asks for a machine or a hook only when the method needs one", async () => {
    targets = [];
    checks = [];
    const d = await openAddDialog();
    const steps = () => d.getByRole("list", { name: "Steps" }).children.length;
    pickKind(d, KIND_CARD.site);
    expect(steps()).toBe(3);
    next(d);
    fillCheck(d, "https://example.com/");
    next(d);
    await pickRepo(d, "github.com/a/site");
    expect(steps()).toBe(4);
    next(d);
    fireEvent.click(d.getByRole("radio", { name: METHOD_CARD.hook }));
    expect(steps()).toBe(5);
    fireEvent.click(d.getByRole("radio", { name: METHOD_CARD.merge }));
    expect(steps()).toBe(4);
  });

  it("adds and removes pages, up to five", async () => {
    const d = await openAddDialog();
    pickKind(d, KIND_CARD.site);
    next(d);
    expect(d.queryByRole("button", { name: "Remove check 1" })).toBeNull();
    for (let i = 0; i < 4; i++)
      fireEvent.click(d.getByRole("button", { name: "Check another page" }));
    expect(d.getByLabelText("Check 5 URL")).toBeTruthy();
    expect(d.queryByRole("button", { name: "Check another page" })).toBeNull();
    fireEvent.click(d.getByRole("button", { name: "Remove check 2" }));
    expect(d.queryByLabelText("Check 5 URL")).toBeNull();
    expect(d.getByRole("button", { name: "Check another page" })).toBeTruthy();
  });

  it("adds a command check on a machine that can sandbox it", async () => {
    const sandboxed = [
      shell(true),
      { name: "shell.sandbox", version: "1", ready: true, detail: "" },
    ];
    runners = [
      { ...studioMac, capabilities: [...studioMac.capabilities, ...sandboxed] },
      devbox,
      { ...devbox, id: "rnr_off", name: "old-mac", capabilities: [shell(false)] },
    ];
    const d = await openAddDialog();
    pickKind(d, KIND_CARD.command);
    next(d);
    const machines = d
      .getAllByRole("radio")
      .map((r) => [r.textContent, r.getAttribute("aria-checked")]);
    // Only Studio Mac can sandbox a command, so it's picked.
    expect(machines).toEqual([
      ["Studio MacOnline", "true"],
      ["old-macCan't: commands are off", "false"],
    ]);
    fireEvent.change(d.getByLabelText(/^Command/), { target: { value: "test -f ~/Backups/x" } });
    fireEvent.change(d.getByLabelText(/^Name/), { target: { value: "Nightly" } });
    fireEvent.click(d.getByRole("button", { name: "More settings" }));
    fireEvent.change(d.getByLabelText(/^Output contains/), { target: { value: "ok" } });
    fireEvent.change(d.getByLabelText("How often"), { target: { value: "3600" } });
    fireEvent.click(d.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(callsTo("POST", "/api/checks")).toHaveLength(1));
    expect(callsTo("POST", "/api/checks")[0]?.body).toEqual({
      name: "Nightly",
      config: {
        kind: "command",
        command: "test -f ~/Backups/x",
        contains: "ok",
        timeoutSeconds: 60,
      },
      intervalSeconds: 3600,
      notify: true,
      runnerId: "rnr_3",
    });
  });

  it("adds a reply check, due by a time", async () => {
    installations = [mailInstallation];
    const d = await openAddDialog();
    pickKind(d, KIND_CARD.reply);
    next(d);
    // With one email account, there's nothing to pick.
    expect(d.queryByRole("radio")).toBeNull();
    fireEvent.change(d.getByLabelText("From"), { target: { value: "jo@silva.pt" } });
    expect((d.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Reply from jo");
    fireEvent.change(d.getByLabelText(/^Due by/), { target: { value: "2020-01-01T10:00" } });
    expect(d.getByText("Pick a time that's still to come.")).toBeTruthy();
    expect((d.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(d.getByLabelText(/^Due by/), { target: { value: "2099-11-13T17:00" } });
    fireEvent.click(d.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(callsTo("POST", "/api/checks")).toHaveLength(1));
    expect(callsTo("POST", "/api/checks")[0]?.body).toMatchObject({
      name: "Reply from jo",
      config: { kind: "reply", from: "jo@silva.pt", subject: null },
      installationId: "ins_mail",
      deadline: new Date("2099-11-13T17:00").toISOString(),
      intervalSeconds: 300,
    });
  });
});

describe("deploy steps on a task", () => {
  it("shows where the merge and deploy ran, the output, and what the checks saw", async () => {
    tasks = [deployFailedTask];
    renderAt("/tasks/tsk_fix");
    const steps = within(await screen.findByRole("list", { name: "Steps after the task" }));
    const row = (label: string) => within(steps.getByText(label).closest("li") as HTMLElement);

    const merge = row("Merge");
    expect(merge.getByText("Done")).toBeTruthy();
    expect(merge.getByText("on Studio Mac")).toBeTruthy();
    expect(merge.getByText("abcdef12")).toBeTruthy();
    // The PR step above already links to it.
    expect(merge.queryByRole("link", { name: /View PR/ })).toBeNull();
    expect(row("Open pull request").getByRole("link", { name: /View PR/ })).toBeTruthy();

    const deploy = row("Deploy");
    expect(deploy.getByText("on Studio Mac")).toBeTruthy();
    expect(deploy.getByText("Output")).toBeTruthy();
    expect(deploy.getByText(/Release v42 created/)).toBeTruthy();

    const verify = row("Check the site");
    expect(verify.getByText("Failed")).toBeTruthy();
    expect(verify.getByText("The site didn't pass its checks within 10 minutes.")).toBeTruthy();
    const saw = within(verify.getByRole("list", { name: "What the checks saw" }));
    expect(saw.getByText("example.com/health")).toBeTruthy();
    expect(saw.getByText("502")).toBeTruthy();
    expect(saw.getByText("Expected 200, got 502")).toBeTruthy();
    expect(verify.getByText(/The version URL never showed/).textContent).toBe(
      "The version URL never showed abcdef12",
    );
    expect(verify.getByText("60 attempts over 10m 00s")).toBeTruthy();

    expect(screen.getByText("Delivers").nextElementSibling?.textContent).toBe(
      "A deploy to Website, checked",
    );
  });

  it("asks once to approve the deployment, saying what will happen", async () => {
    tasks = [{ ...deployWaitingTask, conversationId: "cnv_1" }];
    targets = [websiteTarget];
    runners = [studioMac];
    renderAt("/c/cnv_1");
    const ask = (await screen.findByText("Approve deployment?")).closest("div")
      ?.parentElement as HTMLElement;
    expect(await within(ask).findByText("Website")).toBeTruthy();
    await waitFor(() =>
      expect(within(ask).getByText(/^Merges PR #12/).textContent).toBe(
        "Merges PR #12 into main with squash, then runs fly deploy on Studio Mac, then checks example.com.",
      ),
    );
    // One decision covers both steps, and the card offers nothing else to approve.
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.queryByText(/Approve merge and deploy/)).toBeNull();
    const steps = within(screen.getByRole("list", { name: "Steps after the task" }));
    expect(steps.getByText("Not started")).toBeTruthy();
    fireEvent.click(within(ask).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(callsTo("POST", "/api/tasks/tsk_fix/approval")[0]?.body).toEqual({
        decision: "approve",
      }),
    );
  });

  it("shows the PR's CI on its step and on the deploy approval", async () => {
    const ci = { state: "failed" as const, message: "CI failed: lint (1 of 3)", at: checkedAt() };
    tasks = [
      {
        ...deployWaitingTask,
        conversationId: "cnv_1",
        actions: deployWaitingTask.actions.map((a) =>
          a.kind === "open_pr" ? { ...a, check: ci } : a,
        ),
      },
    ];
    targets = [websiteTarget];
    runners = [studioMac];
    renderAt("/c/cnv_1");
    const ask = (await screen.findByText("Approve deployment?")).closest("div")
      ?.parentElement as HTMLElement;
    expect(
      within(ask).getByRole("status", { name: "Check failed: CI failed: lint (1 of 3)" }),
    ).toBeTruthy();
    const steps = within(screen.getByRole("list", { name: "Steps after the task" }));
    expect(steps.getByRole("status").textContent).toBe("CI failed: lint (1 of 3)");
  });

  it("deploys a delivered PR later, and shows why it can't", async () => {
    tasks = [deliveredPrTask];
    targets = [websiteTarget];
    runners = [studioMac];
    deployAnswer = new HttpError(409, "The PR has conflicts with main.");
    renderAt("/tasks/tsk_pr");
    const deploy = await screen.findByRole("button", { name: "Deploy" });
    fireEvent.click(deploy);
    expect(await screen.findByText("The PR has conflicts with main.")).toBeTruthy();

    deployAnswer = {
      ...deliveredPrTask,
      actions: [
        ...deliveredPrTask.actions,
        step("merge", "awaiting_approval", { targetId: "dpt_site", targetName: "Website" }),
        step("deploy", "awaiting_approval", { targetId: "dpt_site", targetName: "Website" }),
        step("verify", "queued", { targetId: "dpt_site", targetName: "Website" }),
      ],
    };
    fireEvent.click(deploy);
    expect(await screen.findByText("Approve deployment?")).toBeTruthy();
    expect(callsTo("POST", "/api/tasks/tsk_pr/deploy")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
    expect(screen.getByText("Delivers").nextElementSibling?.textContent).toBe(
      "A pull request, then a deploy to Website",
    );
  });

  it("offers no Deploy for a repo without a target", async () => {
    tasks = [deliveredPrTask];
    targets = [docsTarget];
    runners = [studioMac];
    renderAt("/tasks/tsk_pr");
    await screen.findByRole("list", { name: "Steps after the task" });
    await waitFor(() => expect(callsTo("GET", "/api/deploy-targets")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: "Deploy" })).toBeNull();
  });
});

describe("an action's check in the chat", () => {
  it("shows on the step, and follows it after the reply was saved", async () => {
    messages = [
      {
        id: "msg_1",
        conversationId: "cnv_1",
        role: "assistant",
        text: "Added it.",
        taskIds: [],
        attachments: [],
        personalityId: null,
        research: false,
        feedback: null,
        replaceable: false,
        createdAt: "2026-11-06T18:00:00.000Z",
        trace: {
          ms: 900,
          steps: [
            {
              kind: "tool",
              id: "call_1",
              name: "calendar_create_event",
              input: { title: "Dentist" },
              status: "done",
              output: "{}",
              check: { state: "waiting", message: "Couldn't check yet", at: checkedAt() },
            },
          ],
        },
      },
    ];
    renderAt("/c/cnv_1");
    expect(
      await screen.findByRole("status", { name: "Still checking: Couldn't check yet" }),
    ).toBeTruthy();
    emit({
      type: "tool_step.check",
      conversationId: "cnv_1",
      messageId: "msg_1",
      stepId: "call_1",
      check: { state: "passed", message: "In Work, Mon 9 Nov 10:00", at: checkedAt() },
    });
    expect(
      await screen.findByRole("status", { name: "Checked: In Work, Mon 9 Nov 10:00" }),
    ).toBeTruthy();
  });
});

describe("approvals page", () => {
  it("groups a task's merge and deploy as one deployment to approve", async () => {
    approvals = deployApprovals;
    tasks = [deployWaitingTask];
    targets = [websiteTarget];
    runners = [studioMac];
    renderAt("/approvals");
    const card = (await screen.findByText("Approve deployment?")).closest(
      ".rounded-xl",
    ) as HTMLElement;
    const c = within(card);
    expect(await c.findByText("Website")).toBeTruthy();
    expect(c.getByRole("link", { name: "Fix the 500 on checkout" })).toBeTruthy();
    await waitFor(() =>
      expect(c.getByText(/^Merges PR #12/).textContent).toBe(
        "Merges PR #12 into main with squash, then runs fly deploy on Studio Mac, then checks example.com.",
      ),
    );
    expect(c.getByText("Merge")).toBeTruthy();
    expect(c.getByText("Deploy")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Tasks/ })).toBeTruthy();
    fireEvent.click(c.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(callsTo("POST", "/api/tasks/tsk_fix/approval")[0]?.body).toEqual({
        decision: "approve",
      }),
    );
  });
});
