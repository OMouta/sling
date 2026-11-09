// @vitest-environment happy-dom
import type { ApprovalView, InstallationView } from "@sling/core";
import type { PublishResult } from "@sling/workflow";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";
import {
  approvalPage,
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
/** The connection check's error when adding an installation with `check: true`. */
let installFails: string | null = null;
/** Answers a request in place of `route`, for failures and conflicts. Null passes it on. */
let respond: ((method: string, path: string, body: unknown) => Response | null) | null = null;

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The draft as another tab saved it: the fixture without its last step. */
const theirs = {
  ...workflowDetail.draft,
  nodes: workflowDetail.draft.nodes.filter((n) => n.id !== "n_send"),
  edges: workflowDetail.draft.edges.filter(
    (e) => e.from.node !== "n_send" && e.to.node !== "n_send",
  ),
};
const conflict409 = () =>
  json(409, {
    error: "The draft was changed somewhere else.",
    conflict: { revision: 7, draft: theirs, updatedAt: "2026-11-05T10:30:00.000Z" },
  });

function route(method: string, path: string, body: unknown): unknown {
  const key = `${method} ${path}`;
  switch (key) {
    case "GET /api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "GET /api/conversations":
      return [];
    case "GET /api/approvals":
      return approvalPage(approvals);
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
    case "PUT /api/workflows/wf_1/draft": {
      const b = body as { definition: unknown; revision: number };
      return { ...workflowDetail, draft: b.definition, draftRevision: b.revision + 1 };
    }
    case "POST /api/workflows/wf_1/validate":
      return { issues: [] };
    case "POST /api/workflows/wf_1/publish":
      return publishResult;
    case "POST /api/workflows":
      return { ...workflowDetail, id: "wf_new" };
    case "POST /api/installations": {
      const b = body as { connectorId: string; name?: string; config: Record<string, unknown> };
      const created: InstallationView = {
        id: "ins_new",
        connectorId: b.connectorId,
        name: b.name ?? b.connectorId,
        enabled: true,
        status: "idle",
        statusDetail: null,
        config: b.config,
        hasCredentials: true,
        createdAt: "2026-11-05T12:00:00.000Z",
        updatedAt: "2026-11-05T12:00:00.000Z",
      };
      // Listed from then on, like the server; afterEach drops it again.
      installations.push(created);
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
  respond = null;
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
      const answered = respond?.(method, url.pathname, body);
      if (answered) return answered;
      if (
        installFails &&
        method === "POST" &&
        url.pathname === "/api/installations" &&
        (body as { check?: boolean }).check
      ) {
        return new Response(JSON.stringify({ error: installFails, check: "failed" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        });
      }
      try {
        const data = route(method, url.pathname, body);
        // Like the server: a publish that fails validation is a 422.
        const failedPublish =
          method === "POST" && url.pathname.endsWith("/publish") && !(data as PublishResult).ok;
        return new Response(JSON.stringify(data), {
          status: failedPublish ? 422 : 200,
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
  for (let i = installations.length - 1; i >= 0; i--) {
    if (installations[i]?.id === "ins_new") installations.splice(i, 1);
  }
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

interface DraftSave {
  revision: number;
  definition: {
    nodes: { id: string; type: string; label?: string; config: Record<string, unknown> }[];
    edges: { from: { node: string; port: string }; to: { node: string } }[];
  };
}

/** The `n`th draft save the editor sent. */
function draftSave(n: number): DraftSave {
  const call = callsTo("PUT", "/api/workflows/wf_1/draft")[n];
  if (!call) throw new Error(`no draft save ${n}`);
  return call.body as DraftSave;
}

async function findNode(id: string) {
  return screen.findByTestId(`node-${id}`, {}, { timeout: 3000 });
}

describe("workflows list", () => {
  it("shows each workflow's triggers, last run, and state", async () => {
    renderAt("/workflows");
    const row = (await screen.findByText("Important email to Discord")).closest("tr");
    if (!row) throw new Error("no row");
    const r = within(row);
    expect(r.getByText("On New email")).toBeTruthy();
    expect(r.getByText("failed")).toBeTruthy();
    expect(r.getByText("Unpublished changes")).toBeTruthy();
    expect(r.getByText("v1")).toBeTruthy();
    const assistant = screen.getByText("Sling Assistant").closest("tr");
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

  it("creates a workflow from a template a step at a time: template, accounts, name", async () => {
    renderAt("/workflows");
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    const d = within(await screen.findByRole("dialog", { name: "New workflow" }));
    expect(d.getByRole("heading", { name: "What should it start from?" })).toBeTruthy();
    const next = () => d.getByRole("button", { name: /^(Continue|Create)$/ }) as HTMLButtonElement;
    // Nothing picked yet.
    expect(next().disabled).toBe(true);
    const card = await d.findByRole("radio", { name: /Important email to Discord/ });
    expect(card.textContent).toContain("Needs Mailbox, Discord bot");
    fireEvent.click(card);
    fireEvent.click(next());

    // One account per binding, each picked for you when it's the only one.
    expect(d.getByRole("heading", { name: "Which Email account should it use?" })).toBeTruthy();
    expect(d.getByRole("radio", { name: "Work mail" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(next());
    expect(d.getByRole("heading", { name: "Which Discord account should it use?" })).toBeTruthy();
    expect(d.getByRole("radio", { name: /Sling bot/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(next());

    // The template's name to start with.
    expect(d.getByRole("heading", { name: "What should it be called?" })).toBeTruthy();
    const name = d.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Important email to Discord");
    fireEvent.change(name, { target: { value: "VIP mail" } });
    expect(next().textContent).toBe("Create");
    fireEvent.click(next());
    await waitFor(() => expect(callsTo("POST", "/api/workflows")).toHaveLength(1));
    expect(callsTo("POST", "/api/workflows")[0]?.body).toEqual({
      templateKey: "important-email-to-discord",
      bindings: { $email: "ins_email", $discord: "ins_discord" },
      name: "VIP mail",
    });
    // Then the editor.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("adds a missing account in place and picks it", async () => {
    const at = installations.findIndex((i) => i.id === "ins_discord");
    const [discord] = installations.splice(at, 1);
    try {
      renderAt("/workflows");
      fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
      const d = within(await screen.findByRole("dialog", { name: "New workflow" }));
      fireEvent.click(await d.findByRole("radio", { name: /Important email to Discord/ }));
      fireEvent.click(d.getByRole("button", { name: "Continue" }));
      fireEvent.click(d.getByRole("button", { name: "Continue" }));
      expect(d.getByText("No Discord account yet.")).toBeTruthy();
      expect((d.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
        true,
      );

      fireEvent.click(d.getByRole("button", { name: "Add Discord" }));
      const setup = within(await screen.findByRole("dialog", { name: "Add Discord" }));
      fireEvent.change(setup.getByLabelText(/Bot token/), { target: { value: "secret-token" } });
      fireEvent.click(setup.getByRole("button", { name: "Add" }));
      await waitFor(() => expect(callsTo("POST", "/api/installations")).toHaveLength(1));

      // Back on the step, with the new account picked.
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add Discord" })).toBeNull());
      expect(d.getByRole("radio", { name: "discord" }).getAttribute("aria-checked")).toBe("true");
      fireEvent.click(d.getByRole("button", { name: "Continue" }));
      fireEvent.click(d.getByRole("button", { name: "Create" }));
      await waitFor(() => expect(callsTo("POST", "/api/workflows")).toHaveLength(1));
      expect(callsTo("POST", "/api/workflows")[0]?.body).toMatchObject({
        bindings: { $email: "ins_email", $discord: "ins_new" },
      });
    } finally {
      if (discord) installations.splice(at, 0, discord);
    }
  });

  it("creates a blank workflow", async () => {
    renderAt("/workflows");
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    const d = within(await screen.findByRole("dialog", { name: "New workflow" }));
    fireEvent.click(await d.findByRole("radio", { name: /Blank/ }));
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    const create = d.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(d.getByLabelText("Name"), { target: { value: "Ping" } });
    fireEvent.click(create);
    await waitFor(() => expect(callsTo("POST", "/api/workflows")).toHaveLength(1));
    expect(callsTo("POST", "/api/workflows")[0]?.body).toEqual({ name: "Ping" });
  });
});

describe("workflow editor", () => {
  it("loads the draft with its nodes, and says what starts it", async () => {
    renderAt("/workflows/wf_1");
    expect(await findNode("n_trigger")).toBeTruthy();
    expect(screen.getByText("From a VIP?")).toBeTruthy();
    expect(screen.getByText("Summarize")).toBeTruthy();
    expect(screen.getByText("DM me")).toBeTruthy();
    expect(screen.getByText("v1 active")).toBeTruthy();
    expect(screen.getByText("Unpublished changes")).toBeTruthy();
    expect(screen.getByText("Runs when")).toBeTruthy();
    // New mail starts this one, so there's nothing to run by hand.
    const run = screen.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.title).toMatch(/Manual run trigger/);
    // No settings panel until something is selected.
    expect(screen.queryByRole("complementary", { name: "Step settings" })).toBeNull();
    // Exec and data ports are distinct handles.
    const ifNode = await findNode("n_if");
    expect(ifNode.querySelector('[data-port="x:true"] .sling-handle-exec')).toBeTruthy();
    expect(ifNode.querySelector('[data-port="d:value"] .sling-handle-data')).toBeTruthy();
    expect(ifNode.querySelector('[data-port="x:error"]')).toBeTruthy();
  });

  it("adds a step after the selected one and connects it", async () => {
    renderAt("/workflows/wf_1");
    fireEvent.click(await findNode("n_send"));
    expect(screen.getByRole("complementary", { name: "Step settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    const menu = within(screen.getByRole("dialog", { name: "Add a step" }));
    fireEvent.change(menu.getByLabelText("Search steps"), { target: { value: "http" } });
    fireEvent.click(menu.getByText("HTTP request"));
    expect(screen.queryByRole("dialog", { name: "Add a step" })).toBeNull();
    await waitFor(() => expect(callsTo("PUT", "/api/workflows/wf_1/draft")).toHaveLength(1), {
      timeout: 3000,
    });
    const saved = draftSave(0).definition;
    const added = saved.nodes.find((n) => n.type === "http.request");
    expect(saved.edges).toContainEqual(
      expect.objectContaining({
        from: { node: "n_send", port: "next" },
        to: expect.objectContaining({ node: added?.id }),
      }),
    );
  });

  it("explains how workflows work", async () => {
    renderAt("/workflows/wf_1");
    await findNode("n_trigger");
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    expect(screen.getByRole("region", { name: "How workflows work" })).toBeTruthy();
    expect(screen.getByText("A trigger starts a run.")).toBeTruthy();
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
    const saved = draftSave(0).definition;
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
    const saved = draftSave(0).definition;
    expect(saved.nodes.find((n) => n.id === "n_if")?.label).toBe("VIP?");
  });

  it("stops saving on a conflict, and loads theirs or saves over it", async () => {
    let refuse = true;
    respond = (method, path) =>
      method === "PUT" && path === "/api/workflows/wf_1/draft" && refuse ? conflict409() : null;
    const { queryClient } = renderAt("/workflows/wf_1");
    fireEvent.click(await findNode("n_if"));
    fireEvent.change(await screen.findByLabelText("Label"), { target: { value: "VIP?" } });
    const dialog = await screen.findByRole("dialog", { name: "The draft changed somewhere else" });
    expect(draftSave(0).revision).toBe(3);
    expect(within(dialog).getByText(/^3 steps, saved/)).toBeTruthy();
    expect(within(dialog).getByText("4 steps, not saved")).toBeTruthy();
    expect(screen.getByText("Not saved")).toBeTruthy();

    // Closed, it waits in the save status, and nothing more is sent.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "VIP!" } });
    await new Promise((r) => setTimeout(r, 900));
    expect(callsTo("PUT", "/api/workflows/wf_1/draft")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    // Overwriting saves the canvas over the revision the conflict reported.
    refuse = false;
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Overwrite theirs" }),
    );
    await waitFor(() => expect(callsTo("PUT", "/api/workflows/wf_1/draft")).toHaveLength(2));
    const over = draftSave(1);
    expect(over.revision).toBe(7);
    expect(over.definition.nodes.find((n) => n.id === "n_if")?.label).toBe("VIP!");
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      (queryClient.getQueryData(["workflow", "wf_1"]) as { draftRevision: number }).draftRevision,
    ).toBe(8);
  });

  it("loads the other draft in place of the canvas", async () => {
    respond = (method, path) =>
      method === "PUT" && path === "/api/workflows/wf_1/draft" ? conflict409() : null;
    renderAt("/workflows/wf_1");
    fireEvent.click(await findNode("n_if"));
    fireEvent.change(await screen.findByLabelText("Label"), { target: { value: "VIP?" } });
    const dialog = await screen.findByRole("dialog", { name: "The draft changed somewhere else" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Load theirs" }));
    await waitFor(() => expect(screen.queryByTestId("node-n_send")).toBeNull());
    expect(await findNode("n_ai")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    // The next edit builds on their revision.
    respond = null;
    fireEvent.click(await findNode("n_ai"));
    fireEvent.change(await screen.findByLabelText("Label"), { target: { value: "Sum" } });
    await waitFor(() => expect(callsTo("PUT", "/api/workflows/wf_1/draft")).toHaveLength(2), {
      timeout: 3000,
    });
    expect(draftSave(1).revision).toBe(7);
  });

  it("holds navigation while a save fails, with retry or discard", async () => {
    let failing = true;
    respond = (method, path) =>
      method === "PUT" && path === "/api/workflows/wf_1/draft" && failing
        ? json(500, { error: "Database is down" })
        : null;
    const { router } = renderAt("/workflows/wf_1");
    fireEvent.click(await findNode("n_if"));
    fireEvent.change(await screen.findByLabelText("Label"), { target: { value: "VIP?" } });
    void router.navigate({ to: "/workflows" });
    const dialog = await screen.findByRole("dialog", { name: "Your changes aren't saved" });
    expect(within(dialog).getByText("Database is down")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/workflows/wf_1");

    // Staying keeps the editor, still unsaved.
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Couldn't save")).toBeTruthy();

    // A retry that saves lets the navigation go on.
    void router.navigate({ to: "/workflows" });
    const again = await screen.findByRole("dialog", { name: "Your changes aren't saved" });
    failing = false;
    fireEvent.click(within(again).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
    const last = draftSave(callsTo("PUT", "/api/workflows/wf_1/draft").length - 1);
    expect(last.definition.nodes.find((n) => n.id === "n_if")?.label).toBe("VIP?");
  });

  it("discards unsaved changes when leaving on purpose", async () => {
    respond = (method, path) =>
      method === "PUT" && path === "/api/workflows/wf_1/draft"
        ? json(500, { error: "Database is down" })
        : null;
    const { router } = renderAt("/workflows/wf_1");
    fireEvent.click(await findNode("n_if"));
    fireEvent.change(await screen.findByLabelText("Label"), { target: { value: "VIP?" } });
    void router.navigate({ to: "/workflows" });
    const dialog = await screen.findByRole("dialog", { name: "Your changes aren't saved" });
    const tries = callsTo("PUT", "/api/workflows/wf_1/draft").length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
    await new Promise((r) => setTimeout(r, 50));
    expect(callsTo("PUT", "/api/workflows/wf_1/draft")).toHaveLength(tries);
  });

  it("switches tabs without waiting on a save", async () => {
    const { router } = renderAt("/workflows/wf_1");
    fireEvent.click(await findNode("n_if"));
    fireEvent.change(await screen.findByLabelText("Label"), { target: { value: "VIP?" } });
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "runs" }));
    expect(callsTo("PUT", "/api/workflows/wf_1/draft")).toHaveLength(0);
  });

  it("keeps changes whose last save failed, and saves them when the editor opens again", async () => {
    respond = (method, path) =>
      method === "PUT" && path === "/api/workflows/wf_1/draft"
        ? json(503, { error: "Offline" })
        : null;
    renderAt("/workflows/wf_1");
    fireEvent.click(await findNode("n_if"));
    fireEvent.change(await screen.findByLabelText("Label"), { target: { value: "Kept" } });
    // The editor goes away without a navigation, as when the session ends.
    cleanup();
    await waitFor(() => expect(callsTo("PUT", "/api/workflows/wf_1/draft")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));

    respond = null;
    renderAt("/workflows/wf_1");
    await findNode("n_if");
    await waitFor(() => expect(callsTo("PUT", "/api/workflows/wf_1/draft")).toHaveLength(2));
    const saved = draftSave(1);
    expect(saved.revision).toBe(3);
    expect(saved.definition.nodes.find((n) => n.id === "n_if")?.label).toBe("Kept");
    expect(await screen.findByText("Saved")).toBeTruthy();
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
    const select = (await screen.findByLabelText("Account")) as HTMLSelectElement;
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
    expect(callsTo("POST", "/api/workflows/wf_1/publish")[0]?.body).toEqual({
      note: "v2",
      revision: 3,
    });
    const node = await findNode("n_ai");
    // React Flow hides nodes until it has measured them, which happy-dom never does,
    // so role queries can't see inside nodes.
    expect(node.querySelector('[aria-label="1 problem"]')).toBeTruthy();
    expect(node.querySelector('[data-port="d:context"]')?.className).toContain("has-issue");
    // Clicking the issue selects its node.
    fireEvent.click(screen.getByText("Prompt needs a context input"));
    const settings = await screen.findByRole("complementary", { name: "Step settings" });
    expect(within(settings).getByText("Asks the model and returns its text.")).toBeTruthy();
  });

  it("shows the conflict when the reviewed revision is no longer the draft", async () => {
    respond = (method, path) =>
      method === "POST" && path === "/api/workflows/wf_1/publish" ? conflict409() : null;
    renderAt("/workflows/wf_1");
    await findNode("n_ai");
    fireEvent.click(screen.getByText("Publish"));
    const publish = await screen.findByRole("dialog", { name: "Publish" });
    fireEvent.click(within(publish).getByRole("button", { name: "Publish" }));
    expect(
      await screen.findByRole("dialog", { name: "The draft changed somewhere else" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Publish" })).toBeNull();
    expect(callsTo("POST", "/api/workflows/wf_1/publish")[0]?.body).toEqual({
      note: "",
      revision: 3,
    });
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
    // No name to type: the server names it after the connector.
    expect(within(dialog).queryByLabelText("Name")).toBeNull();
    // The setup steps stay closed until asked for.
    expect(within(dialog).queryByText(/Message Content intent\./)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Where to find these" }));
    expect(within(dialog).getByText(/Message Content intent\./)).toBeTruthy();
    fireEvent.change(token, { target: { value: "secret-token" } });
    const users = within(dialog).getByLabelText("Add to Allowed user ids");
    fireEvent.change(users, { target: { value: "42" } });
    fireEvent.keyDown(users, { key: "Enter" });
    fireEvent.click(within(dialog).getByText("Add"));
    await waitFor(() => expect(callsTo("POST", "/api/installations")).toHaveLength(1));
    // It checks the connection before saving.
    expect(callsTo("POST", "/api/installations")[0]?.body).toEqual({
      connectorId: "discord",
      credentials: { botToken: "secret-token" },
      config: { allowedUserIds: ["42"], approverUserIds: [] },
      check: true,
    });
  });

  it("offers to add anyway when the connection check fails", async () => {
    installFails = "Discord says the bot token isn't valid";
    try {
      renderAt("/connectors");
      fireEvent.click(await screen.findByRole("button", { name: "Add Discord" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText(/Bot token/), {
        target: { value: "wrong" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
      expect((await within(dialog).findByRole("alert")).textContent).toContain(
        "bot token isn't valid",
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Add anyway" }));
      await waitFor(() => expect(callsTo("POST", "/api/installations")).toHaveLength(2));
      expect(callsTo("POST", "/api/installations")[1]?.body).toMatchObject({ check: false });
      // Added anyway, it ends like any other add.
      expect(await within(dialog).findByText(/is connected$/)).toBeTruthy();
    } finally {
      installFails = null;
    }
  });

  it("sends only changed values when editing, never stored secrets", async () => {
    renderAt("/connectors");
    const card = (await screen.findByText("Sling bot")).closest("article") as HTMLElement;
    fireEvent.click(within(card).getByText("Edit"));
    const dialog = await screen.findByRole("dialog");
    // Editing opens on what's set, and a secret only says it's stored.
    const settings = within(dialog).getByRole("list", { name: "Settings" });
    expect(within(settings).getByText("Bot token").closest("button")?.textContent).toContain(
      "Stored",
    );
    fireEvent.click(within(settings).getByText("Bot token"));
    const token = within(dialog).getByLabelText(/Bot token/) as HTMLInputElement;
    expect(token.value).toBe("");
    expect(token.placeholder).toBe("Stored (hidden)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    fireEvent.change(within(dialog).getByDisplayValue("Sling bot"), {
      target: { value: "Home bot" },
    });
    fireEvent.click(within(dialog).getByText("Save"));
    await waitFor(() => expect(callsTo("PATCH", "/api/installations/ins_discord")).toHaveLength(1));
    expect(callsTo("PATCH", "/api/installations/ins_discord")[0]?.body).toEqual({
      name: "Home bot",
    });
  });

  it("shows no listening status for a connector that has no event source", async () => {
    connectors.push({
      id: "calendar",
      name: "Calendar",
      description: "Your calendar.",
      setupHelp: null,
      credentialsSchema: {},
      secretFields: [],
      configSchema: {},
      nodeTypes: ["calendar.list_events"],
      hasSource: false,
      extension: null,
    });
    installations.push({
      id: "ins_cal",
      connectorId: "calendar",
      name: "My calendar",
      enabled: true,
      status: "idle",
      statusDetail: null,
      config: {},
      hasCredentials: true,
      createdAt: "2026-11-05T10:00:00.000Z",
      updatedAt: "2026-11-05T10:00:00.000Z",
    });
    try {
      renderAt("/connectors");
      const card = (await screen.findByText("My calendar")).closest("article") as HTMLElement;
      expect(within(card).queryByText(/Not listening/)).toBeNull();
      expect(within(card).queryByText("idle")).toBeNull();
    } finally {
      connectors.pop();
      installations.pop();
    }
  });

  it("asks one step at a time, and says it's connected", async () => {
    connectors.push({
      id: "mailish",
      name: "Mailish",
      description: "Mail.",
      setupHelp: null,
      credentialsSchema: {
        type: "object",
        properties: {
          address: { type: "string", title: "Email address", step: "Your email address" },
          password: { type: "string", title: "Password", step: "Password" },
          host: { type: "string", title: "Server", step: "Server", advanced: true, default: "mx" },
        },
        required: ["address", "password", "host"],
      },
      secretFields: ["password"],
      configSchema: { type: "object", properties: {} },
      nodeTypes: [],
      hasSource: false,
      extension: null,
    });
    try {
      renderAt("/connectors");
      fireEvent.click(await screen.findByRole("button", { name: "Add Mailish" }));
      const d = within(await screen.findByRole("dialog"));
      expect(d.getByRole("heading", { name: "Your email address" })).toBeTruthy();
      expect(
        d.getAllByRole("listitem").filter((li) => li.getAttribute("aria-current")),
      ).toHaveLength(1);
      const next = d.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
      expect(next.disabled).toBe(true);
      fireEvent.change(d.getByLabelText("Email address"), { target: { value: "a@b.co" } });
      fireEvent.click(next);
      // The server step has its answer already, so it waits under More settings.
      expect(await d.findByRole("heading", { name: "Password" })).toBeTruthy();
      expect(d.getByRole("button", { name: "More settings" })).toBeTruthy();
      expect(d.queryByText("*")).toBeNull();
      fireEvent.click(d.getByRole("button", { name: "Back" }));
      expect((d.getByLabelText("Email address") as HTMLInputElement).value).toBe("a@b.co");
      fireEvent.click(d.getByRole("button", { name: "Continue" }));
      fireEvent.change(await d.findByLabelText("Password"), { target: { value: "pw" } });
      fireEvent.click(d.getByRole("button", { name: "Add" }));
      expect(await d.findByText("mailish is connected")).toBeTruthy();
      expect(callsTo("POST", "/api/installations").at(-1)?.body).toMatchObject({
        connectorId: "mailish",
        credentials: { address: "a@b.co", password: "pw", host: "mx" },
        check: true,
      });
      fireEvent.click(d.getByRole("button", { name: "Done" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      connectors.pop();
    }
  });

  it("tests an installation", async () => {
    renderAt("/connectors");
    const card = (await screen.findByText("Sling bot")).closest("article") as HTMLElement;
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
