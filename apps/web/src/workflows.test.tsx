// @vitest-environment happy-dom
import type { ApprovalView, InstallationView } from "@sling/core";
import type { PublishResult } from "@sling/workflow";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";
import {
  assistantSummary,
  catalog,
  connectors,
  installations,
  run,
  runDetail,
  templates,
  version1,
  workflowDetail,
  workflowSummary,
} from "./test/fixtures.ts";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[] = [];
let publishResult: PublishResult = { ok: true, version: 2, issues: [] };
let approvals: ApprovalView[] = [];

function route(method: string, path: string, body: unknown): unknown {
  const key = `${method} ${path}`;
  switch (key) {
    case "GET /api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "GET /api/conversations":
      return [];
    case "GET /api/approvals":
      return approvals;
    case "GET /api/workflows":
      return [workflowSummary, assistantSummary];
    case "GET /api/workflows/wf_1":
      return workflowDetail;
    case "GET /api/workflow-nodes":
      return catalog;
    case "GET /api/installations":
      return installations;
    case "GET /api/connectors":
      return connectors;
    case "GET /api/templates":
      return templates;
    case "GET /api/workflows/wf_1/runs":
      return [run];
    case "GET /api/workflows/wf_1/versions":
      return [version1];
    case "GET /api/workflows/wf_1/versions/1":
      return version1;
    case "GET /api/runs/run_1":
      return runDetail;
    case "PATCH /api/workflows/wf_1":
      return { ...workflowSummary, ...(body as object) };
    case "PUT /api/workflows/wf_1/draft":
      return { ...workflowDetail, draft: body };
    case "POST /api/workflows/wf_1/validate":
      return { issues: [] };
    case "POST /api/workflows/wf_1/publish":
      return publishResult;
    case "POST /api/workflows":
      return { ...workflowDetail, id: "wf_new" };
    case "POST /api/installations": {
      const b = body as { connectorId: string; name: string; config: Record<string, unknown> };
      const created: InstallationView = {
        id: "ins_new",
        connectorId: b.connectorId,
        name: b.name,
        enabled: true,
        status: "idle",
        statusDetail: null,
        config: b.config,
        hasCredentials: true,
        createdAt: "2026-11-05T12:00:00.000Z",
        updatedAt: "2026-11-05T12:00:00.000Z",
      };
      return created;
    }
    case "PATCH /api/installations/ins_discord":
      return { ...installations[1], ...(body as object) };
    case "POST /api/installations/ins_discord/test":
      return { ok: false, error: "Message Content intent is off" };
  }
  throw new Error(`unmocked ${key}`);
}

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  send() {}
  close() {}
}

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class FakeDOMMatrixReadOnly {
  m22 = 1;
  a = 1;
  d = 1;
  e = 0;
  f = 0;
}

beforeEach(() => {
  calls = [];
  approvals = [];
  publishResult = { ok: true, version: 2, issues: [] };
  vi.stubGlobal("WebSocket", FakeSocket);
  // React Flow measures nodes and reads the viewport transform with these.
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("DOMMatrixReadOnly", FakeDOMMatrixReadOnly);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      try {
        return new Response(JSON.stringify(route(method, url.pathname, body)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }),
  );
});

afterEach(async () => {
  cleanup();
  // Closing the editor saves pending changes; let that reach the mocked fetch.
  await new Promise((r) => setTimeout(r, 0));
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

async function findNode(id: string) {
  return screen.findByTestId(`node-${id}`, {}, { timeout: 3000 });
}

describe("workflows list", () => {
  it("shows each workflow's triggers, last run, and state", async () => {
    renderAt("/workflows");
    const row = (await screen.findByText("Important email to Discord")).closest("li");
    if (!row) throw new Error("no row");
    const r = within(row);
    expect(r.getByText("On New email")).toBeTruthy();
    expect(r.getByText("failed")).toBeTruthy();
    expect(r.getByText("Unpublished changes")).toBeTruthy();
    expect(r.getByText("v1")).toBeTruthy();
    const assistant = screen.getByText("Sling Assistant").closest("li");
    if (!assistant) throw new Error("no row");
    expect(within(assistant).getByText("Not published")).toBeTruthy();
    expect(within(assistant).getByText("Never run")).toBeTruthy();
    expect(screen.getAllByText("Workflows").length).toBeGreaterThan(0);
  });

  it("toggles a workflow", async () => {
    renderAt("/workflows");
    const toggle = await screen.findByRole("switch", {
      name: "Disable Important email to Discord",
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(callsTo("PATCH", "/api/workflows/wf_1")).toHaveLength(1));
    expect(callsTo("PATCH", "/api/workflows/wf_1")[0]?.body).toEqual({ enabled: false });
    await screen.findByRole("switch", { name: "Enable Important email to Discord" });
  });

  it("creates a workflow from a template with an installation for each binding", async () => {
    renderAt("/workflows");
    fireEvent.click(await screen.findByText("From template"));
    fireEvent.click(
      await screen.findByText("Summarizes mail from allowlisted senders and DMs you."),
    );
    const create = await screen.findByText("Create workflow");
    await waitFor(() =>
      expect((create.closest("button") as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(create);
    await waitFor(() => expect(callsTo("POST", "/api/workflows")).toHaveLength(1));
    expect(callsTo("POST", "/api/workflows")[0]?.body).toEqual({
      templateKey: "important-email-to-discord",
      bindings: { $email: "ins_email", $discord: "ins_discord" },
    });
  });

  it("creates a blank workflow", async () => {
    renderAt("/workflows");
    fireEvent.click(await screen.findByText("New workflow"));
    fireEvent.change(await screen.findByPlaceholderText("Website health monitor"), {
      target: { value: "Ping" },
    });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(callsTo("POST", "/api/workflows")).toHaveLength(1));
    expect(callsTo("POST", "/api/workflows")[0]?.body).toEqual({ name: "Ping" });
  });
});

describe("workflow editor", () => {
  it("loads the draft and renders its nodes and the palette", async () => {
    renderAt("/workflows/wf_1");
    expect(await findNode("n_trigger")).toBeTruthy();
    expect(screen.getByText("From a VIP?")).toBeTruthy();
    expect(screen.getByText("Summarize")).toBeTruthy();
    expect(screen.getByText("DM me")).toBeTruthy();
    expect(screen.getByText("v1 active")).toBeTruthy();
    expect(screen.getByText("Unpublished changes")).toBeTruthy();
    // Palette, grouped by category.
    expect(screen.getByRole("searchbox", { name: "Search nodes" })).toBeTruthy();
    expect(screen.getAllByText("Triggers").length).toBeGreaterThan(0);
    expect(screen.getByText("HTTP request")).toBeTruthy();
    // Exec and data ports are distinct handles.
    const ifNode = await findNode("n_if");
    expect(ifNode.querySelector('[data-port="x:true"] .sling-handle-exec')).toBeTruthy();
    expect(ifNode.querySelector('[data-port="d:value"] .sling-handle-data')).toBeTruthy();
    expect(ifNode.querySelector('[data-port="x:error"]')).toBeTruthy();
  });

  it("edits a field in the inspector and saves the draft", async () => {
    renderAt("/workflows/wf_1");
    fireEvent.click(await findNode("n_if"));
    const expr = await screen.findByLabelText("Condition expression");
    // Fields from the connected email input are offered.
    expect(screen.getByText("inputs.value.subject")).toBeTruthy();
    fireEvent.change(expr, { target: { value: "inputs.value.subject = 'Hi'" } });
    await waitFor(() => expect(callsTo("PUT", "/api/workflows/wf_1/draft")).toHaveLength(1), {
      timeout: 3000,
    });
    const saved = callsTo("PUT", "/api/workflows/wf_1/draft")[0]?.body as {
      nodes: { id: string; config: Record<string, unknown> }[];
    };
    expect(saved.nodes.find((n) => n.id === "n_if")?.config.condition).toBe(
      "={{ inputs.value.subject = 'Hi' }}",
    );
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("saves pending changes when the editor closes", async () => {
    renderAt("/workflows/wf_1");
    fireEvent.click(await findNode("n_if"));
    fireEvent.change(await screen.findByLabelText("Label"), { target: { value: "VIP?" } });
    expect(callsTo("PUT", "/api/workflows/wf_1/draft")).toHaveLength(0);
    cleanup();
    await waitFor(() => expect(callsTo("PUT", "/api/workflows/wf_1/draft")).toHaveLength(1));
    const saved = callsTo("PUT", "/api/workflows/wf_1/draft")[0]?.body as {
      nodes: { id: string; label?: string }[];
    };
    expect(saved.nodes.find((n) => n.id === "n_if")?.label).toBe("VIP?");
  });

  it("switches a field between a fixed value and an expression", async () => {
    renderAt("/workflows/wf_1");
    fireEvent.click(await findNode("n_ai"));
    const toggle = await screen.findByRole("switch", { name: "Use an expression for Prompt" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    const expr = await screen.findByLabelText("Prompt expression");
    expect((expr as HTMLTextAreaElement).value).toBe('"Summarize this email."');
  });

  it("offers installations of the node's connector", async () => {
    renderAt("/workflows/wf_1");
    fireEvent.click(await findNode("n_send"));
    const select = (await screen.findByLabelText("Installation id")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Choose an installation",
      "Sling bot",
    ]);
    expect(select.value).toBe("ins_discord");
  });

  it("shows publish issues on the nodes they belong to", async () => {
    publishResult = {
      ok: false,
      version: null,
      issues: [
        {
          code: "required_input",
          message: "Prompt needs a context input",
          nodeId: "n_ai",
          port: "context",
        },
        { code: "no_trigger_path", message: "Something else is wrong" },
      ],
    };
    renderAt("/workflows/wf_1");
    await findNode("n_ai");
    fireEvent.click(screen.getByText("Publish"));
    fireEvent.change(await screen.findByLabelText("Note"), { target: { value: "v2" } });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Prompt needs a context input")).toBeTruthy();
    expect(screen.getByText("2 problems")).toBeTruthy();
    expect(callsTo("POST", "/api/workflows/wf_1/publish")[0]?.body).toEqual({ note: "v2" });
    const node = await findNode("n_ai");
    // React Flow hides nodes until it has measured them, which happy-dom never does,
    // so role queries can't see inside nodes.
    expect(node.querySelector('[aria-label="1 problem"]')).toBeTruthy();
    expect(node.querySelector('[data-port="d:context"]')?.className).toContain("has-issue");
    // Clicking the issue selects its node.
    fireEvent.click(screen.getByText("Prompt needs a context input"));
    expect(await screen.findByText("Asks the model and returns its text.")).toBeTruthy();
  });

  it("reports a clean validation", async () => {
    renderAt("/workflows/wf_1");
    await findNode("n_ai");
    fireEvent.click(screen.getByText("Validate"));
    expect(await screen.findByText("No problems found.")).toBeTruthy();
  });

  it("lists runs and versions", async () => {
    renderAt("/workflows/wf_1?tab=runs");
    expect(await screen.findByText("Discord said 403")).toBeTruthy();
    expect(screen.getByText("Email received")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    expect(await screen.findByText("Version 1")).toBeTruthy();
    expect(screen.getByText("First version")).toBeTruthy();
  });
});

describe("run view", () => {
  it("colors nodes by status and shows each step's data", async () => {
    renderAt("/workflows/wf_1/runs/run_1");
    expect(await screen.findByText("Run run_1")).toBeTruthy();
    expect(screen.getAllByText("Discord said 403").length).toBeGreaterThan(0);
    const send = await findNode("n_send");
    await waitFor(() => expect(send.getAttribute("data-status")).toBe("failed"));
    expect((await findNode("n_ai")).getAttribute("data-status")).toBe("succeeded");
    // Steps in order, with their outputs one click away.
    const steps = screen.getByText("Steps").parentElement as HTMLElement;
    const labels = within(steps)
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
    expect(labels[0]).toContain("New email");
    expect(labels[3]).toContain("DM me");
    fireEvent.click(within(steps).getByText("Summarize"));
    expect(await screen.findByText(/Numbers are up/)).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });
});

describe("connectors", () => {
  it("lists installations and creates one from the connector's schema", async () => {
    renderAt("/connectors");
    expect(await screen.findByText("Sling bot")).toBeTruthy();
    expect(screen.getAllByText("Message Content intent is off").length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole("button", { name: "Add Discord" }));
    const dialog = await screen.findByRole("dialog");
    const token = within(dialog).getByLabelText(/Bot token/) as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(within(dialog).getByText(/Message Content intent\./)).toBeTruthy();
    fireEvent.change(token, { target: { value: "secret-token" } });
    const users = within(dialog).getByLabelText("Add to Allowed user ids");
    fireEvent.change(users, { target: { value: "42" } });
    fireEvent.keyDown(users, { key: "Enter" });
    fireEvent.click(within(dialog).getByText("Add"));
    await waitFor(() => expect(callsTo("POST", "/api/installations")).toHaveLength(1));
    expect(callsTo("POST", "/api/installations")[0]?.body).toEqual({
      connectorId: "discord",
      name: "Discord",
      credentials: { botToken: "secret-token" },
      config: { allowedUserIds: ["42"], approverUserIds: [] },
    });
  });

  it("sends only changed values when editing, never stored secrets", async () => {
    renderAt("/connectors");
    const card = (await screen.findByText("Sling bot")).closest("div.space-y-3") as HTMLElement;
    fireEvent.click(within(card).getByText("Edit"));
    const dialog = await screen.findByRole("dialog");
    const token = within(dialog).getByLabelText(/Bot token/) as HTMLInputElement;
    expect(token.value).toBe("");
    expect(token.placeholder).toBe("Stored (hidden)");
    fireEvent.change(within(dialog).getByDisplayValue("Sling bot"), {
      target: { value: "Home bot" },
    });
    fireEvent.click(within(dialog).getByText("Save"));
    await waitFor(() => expect(callsTo("PATCH", "/api/installations/ins_discord")).toHaveLength(1));
    expect(callsTo("PATCH", "/api/installations/ins_discord")[0]?.body).toEqual({
      name: "Home bot",
    });
  });

  it("tests an installation", async () => {
    renderAt("/connectors");
    const card = (await screen.findByText("Sling bot")).closest("div.space-y-3") as HTMLElement;
    fireEvent.click(within(card).getByText("Test"));
    expect(await within(card).findByRole("status")).toBeTruthy();
  });
});

describe("approvals", () => {
  it("links a workflow approval to its run", async () => {
    approvals = [
      {
        id: "apv_9",
        kind: "workflow",
        title: "Send this reply?",
        state: "pending",
        expiresAt: "2026-11-06T10:00:00.000Z",
        createdAt: "2026-11-05T10:00:00.000Z",
        taskId: null,
        actionId: null,
        actionKind: null,
        task: null,
        prTitle: null,
        prBody: null,
        runId: "run_1",
        payload: { draft: "Thanks!" },
      },
    ];
    renderAt("/approvals");
    expect(await screen.findByText("Send this reply?")).toBeTruthy();
    const link = await screen.findByText("view run");
    expect(link.getAttribute("href")).toBe("/workflows/wf_1/runs/run_1");
    expect(screen.getByText("Important email to Discord")).toBeTruthy();
  });
});
