// @vitest-environment happy-dom
import type {
  ApprovalView,
  DeployTargetView,
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
  sandboxRepos as allowedRepos,
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
let runners: RunnerView[] = [];
let sandboxRepos: SandboxRepoView[] = [];
let tasks: TaskView[] = [];
let approvals: ApprovalView[] = [];
/** What `POST /api/tasks/:id/deploy` answers next. */
let deployAnswer: TaskView | HttpError | null = null;
let clipboard: string[] = [];

function route(method: string, path: string, body: unknown): unknown {
  const key = `${method} ${path}`;
  switch (key) {
    case "GET /api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "GET /api/deploy-targets":
      return targets;
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
        messages: [],
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

async function targetCard(name: string) {
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
  renderAt("/deploys");
  fireEvent.click((await screen.findAllByRole("button", { name: "Add target" }))[0] as HTMLElement);
  return within(await screen.findByRole("dialog", { name: "Add a deploy target" }));
}

type Scope = ReturnType<typeof within>;

function pickRepo(d: Scope, remote: string) {
  fireEvent.change(d.getByLabelText(/^Repo/), { target: { value: remote } });
}

function fillCheck(d: Scope, url: string) {
  fireEvent.change(d.getByLabelText("Check 1 URL"), { target: { value: url } });
}

describe("deploys page", () => {
  it("lists each target with its method, status, last deploy, and checks", async () => {
    renderAt("/deploys");
    const site = await targetCard("Website");
    expect(site.getByText("github.com/a/site")).toBeTruthy();
    expect(fact(site, "Method")).toBe("Runs fly deploy on Studio Mac");
    expect(site.getByText("Up").parentElement?.textContent).toMatch(
      /^Up · 121 ms · checked .+ ago$/,
    );
    const last = site.getByRole("link", { name: "Fix the 500 on checkout" });
    expect(last.getAttribute("href")).toBe("/tasks/tsk_fix");
    expect(fact(site, "Last deploy")).toMatch(/^Fix the 500 on checkout9f8e7d6cDone.+ago$/);
    expect(lines(site.getByRole("list", { name: "Website checks" }))).toEqual([
      "example.com200 · 84 ms",
      "example.com/health200 · 121 ms",
    ]);

    const docs = await targetCard("Docs");
    expect(fact(docs, "Method")).toBe("Host deploys on merge");
    expect(docs.getByText("Down").parentElement?.textContent).toMatch(/3 failures in a row/);
    expect(docs.getByText("Expected 200 to 399, got 502")).toBeTruthy();
    expect(fact(docs, "Last deploy")).toBe("Never");

    const api = await targetCard("API");
    expect(fact(api, "Method")).toBe("Calls a hook on api.render.com");
    expect(api.getAllByText("Not checked yet")).toHaveLength(2);
    // One target is down, and the header says so.
    expect(screen.getByText("1 down")).toBeTruthy();
  });

  it("shows a centered empty state with nothing added", async () => {
    targets = [];
    renderAt("/deploys");
    const empty = (await screen.findByText("No deploy targets yet")).parentElement as HTMLElement;
    expect(empty.className).toContain("justify-center");
    expect(within(empty).getByRole("button", { name: "Add target" })).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("follows targets as they change, appear, and go away", async () => {
    renderAt("/deploys");
    await targetCard("Docs");
    emit({
      type: "deploy_target.updated",
      target: {
        ...docsTarget,
        lastCheck: {
          at: new Date().toISOString(),
          up: true,
          failures: 0,
          results: [
            { url: "https://docs.example.com/", ok: true, status: 200, ms: 70, error: null },
          ],
        },
      },
    });
    expect((await targetCard("Docs")).getByText("Up")).toBeTruthy();
    expect(screen.queryByText("1 down")).toBeNull();

    emit({
      type: "deploy_target.updated",
      target: { ...websiteTarget, id: "dpt_blog", name: "Blog" },
    });
    expect(await targetCard("Blog")).toBeTruthy();
    emit({ type: "deploy_target.removed", id: "dpt_docs" });
    await waitFor(() => expect(screen.queryByRole("article", { name: "Docs" })).toBeNull());
  });

  it("checks a target now and shows what each check saw", async () => {
    renderAt("/deploys");
    await openMenu("Website", "Check now");
    await waitFor(() =>
      expect(callsTo("POST", "/api/deploy-targets/dpt_site/check")).toHaveLength(1),
    );
    const site = await targetCard("Website");
    expect(await site.findByText("Down")).toBeTruthy();
    expect(lines(site.getByRole("list", { name: "Website checks" }))).toEqual([
      "example.com503 · 250 msExpected 200 to 399, got 503",
      "example.com/health503 · 250 msExpected 200 to 399, got 503",
    ]);
  });

  it("deletes a target after asking", async () => {
    renderAt("/deploys");
    await openMenu("Docs", "Delete");
    const confirm = within(await screen.findByRole("dialog", { name: "Delete Docs?" }));
    fireEvent.click(confirm.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callsTo("DELETE", "/api/deploy-targets/dpt_docs")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("article", { name: "Docs" })).toBeNull());
  });
});

describe("the target dialog", () => {
  it("adds a target the host deploys on merge", async () => {
    sandboxRepos = allowedRepos;
    const d = await openAddDialog();
    // Repos come from the machines and the sandbox list; one that has a target can't be picked.
    const repo = d.getByLabelText(/^Repo/) as HTMLSelectElement;
    const options = () => [...repo.options].map((o) => [o.textContent, o.disabled]);
    await waitFor(() =>
      expect(options()).toEqual([
        ["Pick a repo", true],
        ["github.com/a/api (API deploys it)", true],
        ["github.com/a/site (Website deploys it)", true],
      ]),
    );
    targets = [];
    cleanup();
    const fresh = await openAddDialog();
    expect(fresh.getByRole("radio", { name: "On merge" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.change(fresh.getByLabelText(/^Name/), { target: { value: "Website" } });
    pickRepo(fresh, "github.com/a/site");
    fillCheck(fresh, "https://example.com/");
    fireEvent.change(fresh.getByLabelText(/^Version URL/), {
      target: { value: "https://example.com/version" },
    });
    fireEvent.click(fresh.getByRole("button", { name: "Add target" }));
    await waitFor(() => expect(callsTo("POST", "/api/deploy-targets")).toHaveLength(1));
    expect(callsTo("POST", "/api/deploy-targets")[0]?.body).toEqual({
      name: "Website",
      remoteKey: "github.com/a/site",
      method: "merge",
      mergeMethod: "squash",
      checks: [{ url: "https://example.com/", status: null, contains: null }],
      versionUrl: "https://example.com/version",
      settleSeconds: 60,
      timeoutSeconds: 600,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await targetCard("Website")).toBeTruthy();
  });

  it("offers only machines that report a deploy command, and shows the command", async () => {
    targets = [];
    runners = [studioMac, lockedMac, devbox];
    const d = await openAddDialog();
    fireEvent.change(d.getByLabelText(/^Name/), { target: { value: "Website" } });
    pickRepo(d, "github.com/a/site");
    fireEvent.click(d.getByRole("radio", { name: "Command" }));
    const machine = d.getByLabelText(/^Machine/) as HTMLSelectElement;
    expect([...machine.options].map((o) => [o.textContent, o.disabled])).toEqual([
      ["Pick a machine", true],
      ["locked-mac: fly deploy (deploys are off)", true],
      ["Studio Mac: fly deploy", false],
    ]);
    // The one machine that can deploy is picked for you.
    expect(machine.value).toBe("rnr_3");
    expect(d.getByText(/on the merged commit/).textContent).toBe(
      "Runs fly deploy on the merged commit.",
    );
    fillCheck(d, "https://example.com/health");
    fireEvent.change(d.getByLabelText("Check 1 status"), { target: { value: "200" } });
    fireEvent.change(d.getByLabelText("Check 1 page contains"), { target: { value: "ok" } });
    fireEvent.click(d.getByRole("button", { name: "Add target" }));
    await waitFor(() => expect(callsTo("POST", "/api/deploy-targets")).toHaveLength(1));
    expect(callsTo("POST", "/api/deploy-targets")[0]?.body).toMatchObject({
      method: "command",
      runnerId: "rnr_3",
      checks: [{ url: "https://example.com/health", status: 200, contains: "ok" }],
      settleSeconds: 0,
    });
  });

  it("shows the line that sets a deploy command when no machine has one", async () => {
    targets = [];
    runners = [devbox];
    const d = await openAddDialog();
    fireEvent.change(d.getByLabelText(/^Name/), { target: { value: "Website" } });
    pickRepo(d, "github.com/a/site");
    fireEvent.click(d.getByRole("radio", { name: "Command" }));
    const line = 'sling-runner repo set site deploy-command "…"';
    expect(d.getByText(line)).toBeTruthy();
    expect(d.queryByLabelText(/^Machine/)).toBeNull();
    fireEvent.click(d.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(clipboard).toEqual([line]));
    expect(d.getByRole("button", { name: "Copied" })).toBeTruthy();

    fillCheck(d, "https://example.com/");
    fireEvent.click(d.getByRole("button", { name: "Add target" }));
    expect(await d.findByText("Pick the machine that deploys it.")).toBeTruthy();
    expect(callsTo("POST", "/api/deploy-targets")).toHaveLength(0);
  });

  it("adds a deploy hook with a header", async () => {
    targets = [];
    const d = await openAddDialog();
    fireEvent.change(d.getByLabelText(/^Name/), { target: { value: "Website" } });
    pickRepo(d, "github.com/a/site");
    fireEvent.click(d.getByRole("radio", { name: "Deploy hook" }));
    fireEvent.change(d.getByLabelText(/^Hook URL/), {
      target: { value: "https://api.render.com/deploy/srv-1?key=abc" },
    });
    fireEvent.click(d.getByRole("radio", { name: "GET" }));
    fireEvent.change(d.getByLabelText(/^Header \(optional\)/), {
      target: { value: "Authorization" },
    });
    fireEvent.click(d.getByRole("button", { name: "Add target" }));
    // A header name needs its value.
    expect(await d.findByText("Add the header's value, or clear its name.")).toBeTruthy();
    fireEvent.change(d.getByLabelText(/^Header value/), { target: { value: "Bearer t0k" } });
    fillCheck(d, "https://example.com/");
    fireEvent.click(d.getByRole("button", { name: "Add target" }));
    await waitFor(() => expect(callsTo("POST", "/api/deploy-targets")).toHaveLength(1));
    expect(callsTo("POST", "/api/deploy-targets")[0]?.body).toMatchObject({
      method: "hook",
      hook: {
        url: "https://api.render.com/deploy/srv-1?key=abc",
        httpMethod: "GET",
        headerName: "Authorization",
        headerValue: "Bearer t0k",
      },
    });
  });

  it("keeps a stored hook unless it's replaced", async () => {
    renderAt("/deploys");
    await openMenu("API", "Edit");
    let d = within(await screen.findByRole("dialog", { name: "Edit API" }));
    expect(d.getByText("Stored for api.render.com")).toBeTruthy();
    expect(d.queryByLabelText(/^Hook URL/)).toBeNull();
    expect((d.getByLabelText(/^Header \(optional\)/) as HTMLInputElement).placeholder).toBe(
      "Stored",
    );
    fireEvent.change(d.getByLabelText(/^Name/), { target: { value: "Public API" } });
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("PATCH", "/api/deploy-targets/dpt_api")).toHaveLength(1));
    const kept = callsTo("PATCH", "/api/deploy-targets/dpt_api")[0]?.body as Record<
      string,
      unknown
    >;
    expect(kept.name).toBe("Public API");
    expect(kept.checks).toEqual([
      { url: "https://api.example.com/health", status: 204, contains: null },
    ]);
    expect("hook" in kept).toBe(false);

    await openMenu("Public API", "Edit");
    d = within(await screen.findByRole("dialog", { name: "Edit Public API" }));
    fireEvent.click(d.getByRole("button", { name: "Replace the hook" }));
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    expect(await d.findByText("Paste the deploy hook's URL.")).toBeTruthy();
    fireEvent.change(d.getByLabelText(/^Hook URL/), {
      target: { value: "https://api.render.com/deploy/srv-2" },
    });
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("PATCH", "/api/deploy-targets/dpt_api")).toHaveLength(2));
    expect(callsTo("PATCH", "/api/deploy-targets/dpt_api")[1]?.body).toMatchObject({
      hook: { url: "https://api.render.com/deploy/srv-2", httpMethod: "POST" },
    });
  });

  it("says what's wrong in place, and sends nothing", async () => {
    const d = await openAddDialog();
    fireEvent.click(d.getByRole("button", { name: "Add target" }));
    expect(await d.findByText("Give it a name.")).toBeTruthy();
    expect(d.getByText("Pick a repo.")).toBeTruthy();
    expect(d.getByText("Add the URL to check.")).toBeTruthy();
    fireEvent.change(d.getByLabelText(/^Name/), { target: { value: "website" } });
    expect(d.getByText("Another target has this name.")).toBeTruthy();
    fillCheck(d, "example.com");
    fireEvent.change(d.getByLabelText("Check 1 status"), { target: { value: "42" } });
    expect(d.getByText("Use an http or https URL.")).toBeTruthy();
    fireEvent.change(d.getByLabelText("Check 1 URL"), { target: { value: "https://example.com" } });
    expect(d.getByText("A status is 100 to 599.")).toBeTruthy();
    expect(callsTo("POST", "/api/deploy-targets")).toHaveLength(0);
  });

  it("keeps every method's fields in place, so switching doesn't move the form", async () => {
    const d = await openAddDialog();
    const panels = () =>
      [
        ...(d.getByRole("radiogroup", { name: "How it deploys" }).parentElement?.nextElementSibling
          ?.children ?? []),
      ].map((p) => p.getAttribute("aria-hidden") === "true");
    expect(panels()).toEqual([false, true, true]);
    fireEvent.click(d.getByRole("radio", { name: "Deploy hook" }));
    expect(panels()).toEqual([true, true, false]);
    fireEvent.click(d.getByRole("radio", { name: "Command" }));
    expect(panels()).toEqual([true, false, true]);
  });

  it("adds and removes checks, up to five", async () => {
    const d = await openAddDialog();
    const add = d.getByRole("button", { name: "Add check" });
    expect(d.getByRole("button", { name: "Remove check 1" }).hasAttribute("disabled")).toBe(true);
    for (let i = 0; i < 4; i++) fireEvent.click(add);
    expect(d.getByLabelText("Check 5 URL")).toBeTruthy();
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.click(d.getByRole("button", { name: "Remove check 2" }));
    expect(d.queryByLabelText("Check 5 URL")).toBeNull();
    expect(add.hasAttribute("disabled")).toBe(false);
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
