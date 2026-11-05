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
  busySandbox,
  connectors as integrationConnectors,
  installations as integrationInstallations,
  providerConnectors,
  sandboxList,
} from "./test/fixtures.ts";

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

function route(method: string, path: string, _body: unknown): unknown {
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
    case "GET /api/sandbox-repos":
      return sandboxRepos;
    case "GET /api/settings/sandboxes":
      return settings;
    case "POST /api/sandboxes/sbx_1/destroy": {
      const released = { ...busySandbox, state: "releasing" as const };
      sandboxes = {
        ...sandboxes,
        sandboxes: sandboxes.sandboxes.map((s) => (s.id === released.id ? released : s)),
      };
      return released;
    }
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
