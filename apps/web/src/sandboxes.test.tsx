// @vitest-environment happy-dom
import type {
  ApprovalView,
  ConnectorView,
  InstallationView,
  RunnerView,
  SandboxListView,
  SandboxRepoView,
  SandboxSettingsView,
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
  buildbox,
  busySandbox,
  devbox,
  dockerInstallation,
  fallbackApproval,
  connectors as integrationConnectors,
  installations as integrationInstallations,
  machineTask,
  providerConnectors,
  sandboxList,
  sandboxRunner,
  sandboxSettings,
  sandboxTask,
  waitingTask,
} from "./test/fixtures.ts";

// The auth client keeps the fetch it found at import, before the stub below, so
// the Settings page's sign-in section would reach for a real server.
vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signOut: async () => {},
  },
}));

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[] = [];
let sandboxes: SandboxListView = sandboxList;
let runners: RunnerView[] = [];
let sandboxRepos: SandboxRepoView[] = [];
let settings: SandboxSettingsView | null = null;
let approvals: ApprovalView[] = [];
let tasks: TaskView[] = [];
let connectors: ConnectorView[] = [];
let installations: InstallationView[] = [];

function route(method: string, path: string, body: unknown): unknown {
  const key = `${method} ${path}`;
  switch (key) {
    case "GET /api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "GET /api/conversations":
      return [];
    case "GET /api/approvals":
      return approvals;
    case "GET /api/sandboxes":
      return sandboxes;
    case "GET /api/connectors":
      return connectors;
    case "GET /api/installations":
      return installations;
    case "GET /api/runners":
      return runners;
    case "GET /api/conversations/cnv_1":
      return {
        conversation: {
          id: "cnv_1",
          title: "Site chores",
          mode: "supervised",
          createdAt: "2026-11-05T10:00:00.000Z",
          updatedAt: "2026-11-05T10:05:00.000Z",
        },
        messages: [],
        tasks: tasks.filter((t) => t.conversationId === "cnv_1"),
        agentStatus: "idle",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    case "GET /api/sandbox-repos":
      return sandboxRepos;
    case "GET /api/settings/sandboxes":
      return settings;
    case "GET /api/settings":
      return {
        defaultMode: "supervised",
        modes: ["read-only", "supervised", "auto", "full-access"],
        providers: [
          { id: "openai", label: "OpenAI", needsBaseUrl: false, defaultModel: "gpt-5.1" },
        ],
        model: { provider: "openai", model: "gpt-5.1", baseUrl: null, hasKey: true },
      };
    case "PUT /api/settings/sandboxes":
      if (!settings) throw new Error("no settings");
      settings = { ...settings, ...(body as object) };
      return settings;
    case "PUT /api/settings/sandboxes/secrets": {
      if (!settings) throw new Error("no settings");
      const next = { ...settings.secrets };
      for (const [k, v] of Object.entries(body as Record<string, string>)) {
        next[k as keyof typeof next] = v !== "";
      }
      settings = { ...settings, secrets: next };
      return settings;
    }
    case "POST /api/approvals/apv_fb":
      approvals = approvals.filter((a) => a.id !== "apv_fb");
      return { ok: true };
    case "POST /api/sandboxes/sbx_1/destroy": {
      const released = { ...busySandbox, state: "releasing" as const };
      sandboxes = {
        ...sandboxes,
        sandboxes: sandboxes.sandboxes.map((s) => (s.id === released.id ? released : s)),
      };
      return released;
    }
  }
  const remote = /^\/api\/sandbox-repos\/([^/]+)$/.exec(path)?.[1];
  if (remote && method === "PUT") {
    const b = body as Omit<SandboxRepoView, "remoteKey" | "createdAt">;
    const repo = {
      ...b,
      remoteKey: decodeURIComponent(remote),
      createdAt: "2026-11-05T12:00:00.000Z",
    };
    sandboxRepos = [...sandboxRepos.filter((r) => r.remoteKey !== repo.remoteKey), repo];
    return repo;
  }
  if (remote && method === "DELETE") {
    sandboxRepos = sandboxRepos.filter((r) => r.remoteKey !== decodeURIComponent(remote));
    return undefined;
  }
  const task = method === "GET" && /^\/api\/tasks\/([^/]+)$/.exec(path)?.[1];
  const found = task && tasks.find((t) => t.id === task);
  if (found) return { task: found, events: [] };
  throw new Error(`unmocked ${key}`);
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

/** Delivers a server event the way the realtime socket would. */
function emit(ev: ServerEvent) {
  act(() => socket?.onmessage?.({ data: JSON.stringify(ev) }));
}

beforeEach(() => {
  calls = [];
  sandboxes = sandboxList;
  runners = [];
  sandboxRepos = [];
  settings = null;
  approvals = [];
  tasks = [];
  connectors = [...integrationConnectors, ...providerConnectors];
  installations = integrationInstallations;
  socket = null;
  vi.stubGlobal("WebSocket", FakeSocket);
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
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

/** The card for a sandbox, found by its task's title. */
async function sandboxCard(taskTitle: string) {
  const link = await screen.findByText(taskTitle);
  return within(link.closest("li") as HTMLElement);
}

describe("sandboxes page", () => {
  it("lists sandboxes with their provider, task, image, minutes, and failure", async () => {
    const requestedAt = new Date(Date.now() - 65_000).toISOString();
    sandboxes = {
      ...sandboxList,
      sandboxes: [{ ...busySandbox, requestedAt }, ...sandboxList.sandboxes.slice(1)],
    };
    renderAt("/sandboxes");
    const busy = await sandboxCard("Fix the signup form");
    expect(busy.getByText("busy")).toBeTruthy();
    expect(busy.getByText("Docker host")).toBeTruthy();
    await waitFor(() => expect(busy.getByText("Docker")).toBeTruthy());
    expect(busy.getByText("ghcr.io/sling/sling-sandbox:latest")).toBeTruthy();
    expect(busy.getByText(/4 min used/)).toBeTruthy();
    expect(busy.getByText(/Running for 1m 0\ds/)).toBeTruthy();
    expect(busy.getByText("3f9c2a1b7d4e8f60a1b2c3d4e5f60718293a4b5c6d7e8f90")).toBeTruthy();
    expect(busy.getByText("Fix the signup form").getAttribute("href")).toBe("/tasks/tsk_sbx");

    const failed = await sandboxCard("Bump the linter");
    expect(failed.getByText("failed")).toBeTruthy();
    expect(failed.getByText("The Runner didn't connect within 10 minutes.")).toBeTruthy();
    expect(failed.getByText("Ran 10m 00s")).toBeTruthy();
    expect(failed.getByRole("button", { name: /Destroy/ })).toBeTruthy();

    const destroyed = await sandboxCard("Add a changelog");
    expect(destroyed.getByText("destroyed")).toBeTruthy();
    expect(destroyed.getByText("Ran 12m 10s")).toBeTruthy();
    expect(destroyed.queryByRole("button", { name: /Destroy/ })).toBeNull();
  });

  it("shows minutes against the budget, running against the limit, and spend", async () => {
    renderAt("/sandboxes");
    const meter = await screen.findByRole("meter", { name: "Sandbox minutes this month" });
    expect(meter.getAttribute("value")).toBe("150");
    expect(meter.getAttribute("max")).toBe("600");
    expect(screen.getByText("150 min of 600 min")).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.getByText("Estimated spend")).toBeTruthy();
    expect(
      screen.getByText((1.25).toLocaleString(undefined, { minimumFractionDigits: 2 })),
    ).toBeTruthy();
  });

  it("leaves out spend when no provider has a cost, and warns when the budget is used up", async () => {
    sandboxes = {
      ...sandboxList,
      usage: { ...sandboxList.usage, monthMinutes: 600, estimatedMonthCost: null },
    };
    renderAt("/sandboxes");
    expect(await screen.findByText(/The budget is used up/)).toBeTruthy();
    expect(screen.queryByText("Estimated spend")).toBeNull();
  });

  it("destroys a sandbox after you confirm", async () => {
    renderAt("/sandboxes");
    const busy = await sandboxCard("Fix the signup form");
    fireEvent.click(
      busy.getByRole("button", { name: "Destroy the sandbox for Fix the signup form" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Its task stops and is marked interrupted/)).toBeTruthy();
    expect(callsTo("POST", "/api/sandboxes/sbx_1/destroy")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Destroy" }));
    await waitFor(() => expect(callsTo("POST", "/api/sandboxes/sbx_1/destroy")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await busy.findByText("releasing")).toBeTruthy();
  });

  it("cancelling the confirm destroys nothing", async () => {
    renderAt("/sandboxes");
    const busy = await sandboxCard("Fix the signup form");
    fireEvent.click(busy.getByRole("button", { name: /Destroy/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(callsTo("POST", "/api/sandboxes/sbx_1/destroy")).toHaveLength(0);
  });

  it("updates live from sandbox events", async () => {
    renderAt("/sandboxes");
    const busy = await sandboxCard("Fix the signup form");
    expect(busy.getByText("busy")).toBeTruthy();
    const released = { ...busySandbox, state: "releasing" as const, minutes: 5 };
    sandboxes = {
      sandboxes: [released, ...sandboxList.sandboxes.slice(1)],
      usage: { ...sandboxList.usage, monthMinutes: 151, running: 0 },
    };
    emit({ type: "sandbox.updated", sandbox: released });
    expect(await busy.findByText("releasing")).toBeTruthy();
    expect(busy.getByText(/5 min used/)).toBeTruthy();
    // Usage isn't in the event, so a change of state refetches it.
    expect(await screen.findByText("0 of 2")).toBeTruthy();
    expect(screen.getByText("151 min of 600 min")).toBeTruthy();
    const requested = {
      ...busySandbox,
      id: "sbx_new",
      state: "requested" as const,
      taskTitle: "Brand new task",
    };
    sandboxes = { ...sandboxes, sandboxes: [requested, ...sandboxes.sandboxes] };
    emit({ type: "sandbox.updated", sandbox: requested });
    expect(await screen.findByText("Brand new task")).toBeTruthy();
  });

  it("explains what sandboxes are when there are none", async () => {
    sandboxes = { ...sandboxList, sandboxes: [] };
    renderAt("/sandboxes");
    expect(await screen.findByText("No sandboxes yet")).toBeTruthy();
    expect(screen.getAllByText("Sandboxes").length).toBeGreaterThan(0);
  });
});

describe("settings: sandboxes", () => {
  async function section() {
    const heading = await screen.findByRole("heading", { name: "Sandboxes" });
    return within(heading.parentElement as HTMLElement);
  }

  it("saves the default agent, the limits, and each provider's cost", async () => {
    settings = sandboxSettings;
    installations = [...integrationInstallations, dockerInstallation];
    renderAt("/settings");
    const s = await section();
    const agent = (await s.findByLabelText(/Default coding agent/)) as HTMLSelectElement;
    expect([...agent.options].map((o) => o.textContent)).toEqual(["Codex", "Claude Code"]);
    expect(agent.value).toBe("codex");
    fireEvent.change(agent, { target: { value: "claude-code" } });
    fireEvent.change(s.getByLabelText(/Concurrent sandboxes/), { target: { value: "1" } });
    fireEvent.change(s.getByLabelText(/Minutes a month/), { target: { value: "300" } });
    // Only provider installations get a cost.
    const cost = await s.findByLabelText("Cost per hour for Docker host");
    expect(s.queryByLabelText("Cost per hour for Work mail")).toBeNull();
    fireEvent.change(cost, { target: { value: "0.12" } });
    fireEvent.click(s.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo("PUT", "/api/settings/sandboxes")).toHaveLength(1));
    expect(callsTo("PUT", "/api/settings/sandboxes")[0]?.body).toEqual({
      defaultHarness: "claude-code",
      concurrentLimit: 1,
      lifetimeMinutes: 60,
      monthlyMinutesBudget: 300,
      costPerHour: { ins_docker: 0.12 },
    });
    expect(await s.findByText("Saved.")).toBeTruthy();
    expect(callsTo("PUT", "/api/settings/sandboxes/secrets")).toHaveLength(0);
  });

  it("won't save a lifetime under a minute", async () => {
    settings = sandboxSettings;
    renderAt("/settings");
    const s = await section();
    fireEvent.change(await s.findByLabelText(/Lifetime/), { target: { value: "0" } });
    expect((s.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(s.getByText(/at least 1/)).toBeTruthy();
  });

  it("sends only the secrets you type, and never shows stored ones", async () => {
    settings = sandboxSettings;
    renderAt("/settings");
    const s = await section();
    const openai = (await s.findByLabelText("OpenAI API key")) as HTMLInputElement;
    const anthropic = s.getByLabelText("Anthropic API key") as HTMLInputElement;
    const github = s.getByLabelText("GitHub token") as HTMLInputElement;
    for (const input of [openai, anthropic, github]) expect(input.type).toBe("password");
    expect(openai.value).toBe("");
    expect(openai.placeholder).toMatch(/Stored/);
    expect(s.getAllByText("Stored")).toHaveLength(1);
    expect(s.getAllByText("Not set")).toHaveLength(2);
    const save = s.getByRole("button", { name: "Save secrets" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(anthropic, { target: { value: "sk-ant-123" } });
    fireEvent.click(save);
    await waitFor(() => expect(callsTo("PUT", "/api/settings/sandboxes/secrets")).toHaveLength(1));
    expect(callsTo("PUT", "/api/settings/sandboxes/secrets")[0]?.body).toEqual({
      anthropicApiKey: "sk-ant-123",
    });
    await waitFor(() => expect(s.getAllByText("Stored")).toHaveLength(2));
    expect(anthropic.value).toBe("");
    expect(callsTo("PUT", "/api/settings/sandboxes")).toHaveLength(0);
  });

  it("clears a stored secret with an empty string after you confirm", async () => {
    settings = sandboxSettings;
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    renderAt("/settings");
    const s = await section();
    fireEvent.click(await s.findByRole("button", { name: "Clear OpenAI API key" }));
    expect(confirm).toHaveBeenCalledWith("Clear the stored OpenAI API key?");
    expect(callsTo("PUT", "/api/settings/sandboxes/secrets")).toHaveLength(0);

    confirm.mockReturnValue(true);
    fireEvent.click(s.getByRole("button", { name: "Clear OpenAI API key" }));
    await waitFor(() => expect(callsTo("PUT", "/api/settings/sandboxes/secrets")).toHaveLength(1));
    expect(callsTo("PUT", "/api/settings/sandboxes/secrets")[0]?.body).toEqual({
      openaiApiKey: "",
    });
    await waitFor(() => expect(s.getAllByText("Not set")).toHaveLength(3));
    expect(s.queryByRole("button", { name: /^Clear / })).toBeNull();
  });

  it("says how to scope the GitHub token", async () => {
    settings = sandboxSettings;
    renderAt("/settings");
    const s = await section();
    expect(await s.findByText(/fine-grained token limited to the repos you allow/)).toBeTruthy();
    expect(s.getByText("docs/sandboxes.md")).toBeTruthy();
  });
});

describe("machines", () => {
  async function machineCard(name: string) {
    const title = await screen.findByText(name);
    return within(title.closest(".rounded-xl") as HTMLElement);
  }

  it("shows labels, with the automatic ones set apart", async () => {
    runners = [devbox, buildbox];
    renderAt("/machines");
    const card = await machineCard("devbox");
    const labels = within(card.getByRole("list", { name: "Labels" }));
    expect(labels.getByText("ios")).toBeTruthy();
    expect(labels.getByText("os:macos").getAttribute("title")).toBe("Set automatically");
    expect(labels.getByText("arch:aarch64").getAttribute("title")).toBe("Set automatically");
    expect(labels.getByText("ios").getAttribute("title")).toBeNull();
    expect((await machineCard("buildbox")).getByText("gpu")).toBeTruthy();
  });

  it("never lists a sandbox's Runner", async () => {
    runners = [devbox, sandboxRunner, buildbox];
    renderAt("/machines");
    expect(await screen.findByText("devbox")).toBeTruthy();
    expect(screen.getByText("buildbox")).toBeTruthy();
    expect(screen.queryByText("sandbox-sbx_1")).toBeNull();
  });

  it("shows which coding agents each machine has, and whether they're ready", async () => {
    runners = [devbox, buildbox];
    renderAt("/machines");
    const dev = await machineCard("devbox");
    expect(dev.getByText("Codex 0.166.0")).toBeTruthy();
    expect(dev.getByText("Claude Code 2.1.4 · not ready")).toBeTruthy();
    expect(dev.getByText(/Claude Code: Not logged in/)).toBeTruthy();
    expect(dev.getByText("git 2.47.1")).toBeTruthy();
    const build = await machineCard("buildbox");
    expect(build.getByText("Codex · not installed")).toBeTruthy();
    expect(build.getByText("Claude Code 2.1.4")).toBeTruthy();
  });

  it("allows a repo in sandboxes by its remote, and disallows it", async () => {
    runners = [devbox, buildbox];
    sandboxRepos = allowedRepos;
    renderAt("/machines");
    const build = await machineCard("buildbox");
    await waitFor(() =>
      expect(
        build.getByRole("switch", { name: "Allow api in sandboxes" }).getAttribute("aria-checked"),
      ).toBe("true"),
    );
    const dev = await machineCard("devbox");
    const site = dev.getByRole("switch", { name: "Allow site in sandboxes" });
    expect(site.getAttribute("aria-checked")).toBe("false");
    expect(dev.getByText(/clones the repo from its remote, so local files/)).toBeTruthy();

    fireEvent.click(site);
    const path = "/api/sandbox-repos/github.com%2Fa%2Fsite";
    await waitFor(() => expect(callsTo("PUT", path)).toHaveLength(1));
    expect(callsTo("PUT", path)[0]?.body).toEqual({
      cloneUrl: "https://github.com/a/site.git",
      defaultBranch: "main",
      network: false,
    });
    await waitFor(() => expect(site.getAttribute("aria-checked")).toBe("true"));
    await waitFor(() => expect((site as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(site);
    await waitFor(() => expect(callsTo("DELETE", path)).toHaveLength(1));
    await waitFor(() => expect(site.getAttribute("aria-checked")).toBe("false"));
    expect(sandboxRepos.map((r) => r.remoteKey)).toEqual(["github.com/a/api"]);
  });

  it("explains why a repo without a remote can't go to a sandbox", async () => {
    runners = [devbox];
    renderAt("/machines");
    const dev = await machineCard("devbox");
    expect(dev.getByText("notes")).toBeTruthy();
    expect(dev.getByText("No remote, so a sandbox has nothing to clone")).toBeTruthy();
    expect(dev.queryByRole("switch", { name: "Allow notes in sandboxes" })).toBeNull();
  });
});

describe("task card", () => {
  it("says which machine and agent, and why it picked that machine", async () => {
    tasks = [machineTask];
    renderAt("/tasks/tsk_1");
    expect(await screen.findByText("Codex task")).toBeTruthy();
    expect(screen.getByText("on devbox")).toBeTruthy();
    expect(screen.getByText("What Codex was asked")).toBeTruthy();
    const why = screen.getByText("Why here?").closest("details") as HTMLDetailsElement;
    expect(why.open).toBe(false);
    const w = within(why);
    expect(w.getByText("devbox has site and Codex ready, and the most free slots.")).toBeTruthy();
    // Eligible machines first, whatever order the router looked at them in.
    const rows = within(w.getByRole("list", { name: "Machines considered" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((r) => r.textContent)).toEqual([
      "devboxpickedEligible. 2 of 2 slots free.",
      "buildboxNot eligible. Offline.",
    ]);
  });

  it("shows the sandbox, its provider and state, and links to the Sandboxes page", async () => {
    tasks = [sandboxTask];
    renderAt("/tasks/tsk_sbx");
    expect(await screen.findByText("Claude Code task")).toBeTruthy();
    const badge = screen.getByText("in a sandbox on Docker host");
    expect(badge.closest("a")?.getAttribute("href")).toBe("/sandboxes");
    expect(within(badge.closest("a") as HTMLElement).getByText("busy")).toBeTruthy();
    expect(screen.getByText(/^running \d/)).toBeTruthy();
    expect(screen.getByText("What Claude Code was asked")).toBeTruthy();
    expect(screen.queryByText("picked")).toBeNull();
  });

  it("follows the sandbox's state live", async () => {
    tasks = [sandboxTask];
    renderAt("/tasks/tsk_sbx");
    expect(await screen.findByText("busy")).toBeTruthy();
    emit({ type: "sandbox.updated", sandbox: { ...busySandbox, state: "releasing" } });
    expect(await screen.findByText("releasing")).toBeTruthy();
  });

  it("says what a task with no machine yet is waiting for", async () => {
    tasks = [{ ...waitingTask, conversationId: "cnv_1" }];
    renderAt("/c/cnv_1");
    expect(await screen.findByText("waiting for a sandbox")).toBeTruthy();
    expect(screen.queryByText(/null/)).toBeNull();
    expect(screen.getByText("No machine can take it right now.")).toBeTruthy();
  });
});

describe("sandbox fallback approval", () => {
  /** The paragraph that says exactly what approving does. */
  const plan = (_: string, el: Element | null) =>
    el?.textContent === "Clone github.com/a/site into a sandbox on Docker host and run Codex.";

  it("says why no machine can take the task and exactly what approving does", async () => {
    approvals = [fallbackApproval];
    renderAt("/approvals");
    const title = await screen.findByText("Update the README badges");
    expect(title.getAttribute("href")).toBe("/tasks/tsk_wait");
    expect(screen.getByText("No machine can take this right now.")).toBeTruthy();
    expect(screen.getByText("devbox: Offline.")).toBeTruthy();
    expect(screen.getByText("buildbox: Doesn't have site.")).toBeTruthy();
    expect(screen.getByText(plan)).toBeTruthy();
  });

  it("approves on the Approvals page", async () => {
    approvals = [fallbackApproval];
    renderAt("/approvals");
    await screen.findByText("Update the README badges");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(callsTo("POST", "/api/approvals/apv_fb")).toHaveLength(1));
    expect(callsTo("POST", "/api/approvals/apv_fb")[0]?.body).toEqual({ decision: "approve" });
    expect(await screen.findByText("Nothing waiting")).toBeTruthy();
  });

  it("rejects on the Approvals page", async () => {
    approvals = [fallbackApproval];
    renderAt("/approvals");
    await screen.findByText("Update the README badges");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(callsTo("POST", "/api/approvals/apv_fb")).toHaveLength(1));
    expect(callsTo("POST", "/api/approvals/apv_fb")[0]?.body).toEqual({ decision: "reject" });
  });

  it("stands in for the task's card in the conversation, and approving brings the card back", async () => {
    tasks = [waitingTask];
    approvals = [fallbackApproval];
    renderAt("/c/cnv_1");
    expect(await screen.findByText(plan)).toBeTruthy();
    expect(screen.getByText("waiting for approval")).toBeTruthy();
    expect(screen.queryByText("Codex task")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(callsTo("POST", "/api/approvals/apv_fb")).toHaveLength(1));
    expect(callsTo("POST", "/api/approvals/apv_fb")[0]?.body).toEqual({ decision: "approve" });
    expect(await screen.findByText("Codex task")).toBeTruthy();
    expect(screen.getByText("waiting for a sandbox")).toBeTruthy();
    expect(screen.queryByText(plan)).toBeNull();
  });

  it("rejecting in the conversation cancels the task", async () => {
    tasks = [waitingTask];
    approvals = [fallbackApproval];
    renderAt("/c/cnv_1");
    await screen.findByText(plan);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(callsTo("POST", "/api/approvals/apv_fb")).toHaveLength(1));
    expect(callsTo("POST", "/api/approvals/apv_fb")[0]?.body).toEqual({ decision: "reject" });
    emit({ type: "task.updated", task: { ...waitingTask, state: "cancelled" } });
    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("no sandbox started")).toBeTruthy();
  });

  it("doesn't hold back a task that already has a machine", async () => {
    tasks = [machineTask];
    approvals = [
      {
        ...fallbackApproval,
        taskId: "tsk_1",
        payload: { ...fallbackApproval.payload, taskId: "tsk_1" },
      },
    ];
    renderAt("/c/cnv_1");
    expect(await screen.findByText("Codex task")).toBeTruthy();
    expect(screen.queryByText(plan)).toBeNull();
  });
});
