// @vitest-environment happy-dom
import type {
  CatalogView,
  ConnectorView,
  DiscoverEntryView,
  ExtensionDetailView,
  ExtensionPreview,
  ExtensionView,
  PublisherView,
  ServerEvent,
} from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";
import {
  acmeDetail,
  acmeExtension,
  acmeUpdatePreview,
  catalog,
  catalogs as catalogFixtures,
  connectors as connectorFixtures,
  deployPackPreview,
  devExtension,
  discoverEntries,
  extensionList,
  flyPreview,
  installations,
  notesPreview,
  ntfyConnector,
  ntfyDetail,
  ntfyExtension,
  ntfyPreview,
  packageTemplate,
  publishers as publisherFixtures,
  templates,
  version1,
  workflowDetail,
  workflowSummary,
} from "./test/fixtures.ts";

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
  contentType: string | null;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let calls: Call[] = [];
let extensions: ExtensionView[] = [];
let details: Record<string, ExtensionDetailView> = {};
let discover: DiscoverEntryView[] = [];
let catalogs: CatalogView[] = [];
let publishers: PublisherView[] = [];
let connectors: ConnectorView[] = [];
/** What the next upload previews as. */
let uploads: ExtensionPreview[] = [];
let previews: Record<string, ExtensionPreview> = {};
/** Set to make the next install fail. */
let installError: HttpError | null = null;

/** The view the server would answer an install with. */
function installedFrom(p: ExtensionPreview): ExtensionView {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    version: p.version,
    source: p.source,
    catalogId: p.catalogId,
    publisher: p.publisher ? { ...p.publisher, trusted: true } : null,
    signed: p.signed,
    enabled: true,
    status: "stopped",
    statusDetail: null,
    kinds: p.kinds,
    contents: p.contents,
    permissions: p.permissions,
    update: null,
    revoked: null,
    usedBy: { installations: 0, workflows: 0 },
    hasIcon: false,
    homepage: null,
    installedAt: "2026-11-05T12:00:00.000Z",
    updatedAt: "2026-11-05T12:00:00.000Z",
  };
}

const staged = new Map<string, ExtensionPreview>();

function route(method: string, path: string, body: unknown): unknown {
  const key = `${method} ${path}`;
  switch (key) {
    case "GET /api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "GET /api/conversations":
    case "GET /api/approvals":
    case "GET /api/tasks":
    case "GET /api/runners":
      return [];
    case "GET /api/sandboxes":
      return {
        sandboxes: [],
        usage: {
          monthMinutes: 0,
          monthlyMinutesBudget: 600,
          running: 0,
          concurrentLimit: 2,
          estimatedMonthCost: null,
        },
      };
    case "GET /api/extensions":
      return extensions;
    case "GET /api/extensions/discover":
      return discover;
    case "GET /api/extension-catalogs":
      return catalogs;
    case "GET /api/extension-publishers":
      return publishers;
    case "GET /api/connectors":
      return connectors;
    case "GET /api/installations":
      return installations;
    case "GET /api/sandbox-repos":
      return [];
    case "GET /api/settings/sandboxes":
      return null;
    case "GET /api/templates":
      return [...templates, packageTemplate];
    case "GET /api/workflows":
      return [workflowSummary];
    case "GET /api/workflows/wf_1":
      return workflowDetail;
    case "GET /api/workflow-nodes":
      return catalog;
    case "GET /api/workflows/wf_1/versions":
      return [version1];
    case "POST /api/extensions/preview": {
      const p =
        body instanceof Blob
          ? uploads.shift()
          : previews[(body as { extensionId: string }).extensionId];
      if (!p) throw new HttpError(400, "Nothing to preview");
      staged.set(p.stagingId, p);
      return p;
    }
    case "POST /api/extensions/install": {
      if (installError) {
        const err = installError;
        installError = null;
        throw err;
      }
      const p = staged.get((body as { stagingId: string }).stagingId);
      if (!p) throw new HttpError(410, "This preview expired");
      const view = installedFrom(p);
      extensions = [...extensions.filter((x) => x.id !== view.id), view];
      discover = discover.map((e) =>
        e.id === view.id
          ? { ...e, installed: { version: view.version, updateAvailable: false } }
          : e,
      );
      return view;
    }
    case "POST /api/extension-catalogs": {
      const created: CatalogView = {
        id: "cat_new",
        url: (body as { url: string }).url,
        name: "Weather tools",
        enabled: true,
        included: false,
        fetchedAt: "2026-11-05T12:00:00.000Z",
        error: null,
        extensionCount: 2,
      };
      catalogs = [...catalogs, created];
      return created;
    }
  }
  const ext = /^\/api\/extensions\/([^/]+)(\/.*)?$/.exec(path);
  if (ext) {
    const id = decodeURIComponent(ext[1] ?? "");
    const rest = ext[2] ?? "";
    if (method === "GET" && rest === "") {
      const d = details[id];
      if (!d) throw new HttpError(404, "No such extension");
      return d;
    }
    if (method === "PATCH" && rest === "") {
      const enabled = (body as { enabled: boolean }).enabled;
      const prev = extensions.find((x) => x.id === id);
      if (!prev) throw new HttpError(404, "No such extension");
      const next: ExtensionView = {
        ...prev,
        enabled,
        status: enabled ? "stopped" : "disabled",
      };
      extensions = extensions.map((x) => (x.id === id ? next : x));
      return next;
    }
    if (method === "DELETE" && rest === "") {
      extensions = extensions.filter((x) => x.id !== id);
      return undefined;
    }
    if (method === "POST" && rest === "/update/preview") {
      const p = previews[`${id}@${(body as { version: string }).version}`];
      if (!p) throw new HttpError(400, "No such version");
      staged.set(p.stagingId, p);
      return p;
    }
  }
  const cat = /^\/api\/extension-catalogs\/([^/]+)(\/refresh)?$/.exec(path);
  if (cat) {
    const id = cat[1] ?? "";
    if (method === "POST" && cat[2]) {
      const refreshed = catalogs.find((c) => c.id === id);
      if (!refreshed) throw new HttpError(404, "No such catalog");
      const next = { ...refreshed, fetchedAt: new Date().toISOString(), extensionCount: 4 };
      catalogs = catalogs.map((c) => (c.id === id ? next : c));
      return next;
    }
    if (method === "DELETE") {
      catalogs = catalogs.filter((c) => c.id !== id);
      return undefined;
    }
  }
  const pub = /^\/api\/extension-publishers\/([^/]+)$/.exec(path)?.[1];
  if (pub && method === "DELETE") {
    publishers = publishers.filter((p) => p.keyId !== pub);
    return undefined;
  }
  if (key === "POST /api/workflows/wf_1/export-package") {
    return new Response(new Blob(["slx"]), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="important-email-1.0.0.slx"',
      },
    });
  }
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

function emit(ev: ServerEvent) {
  act(() => socket?.onmessage?.({ data: JSON.stringify(ev) }));
}

beforeEach(() => {
  calls = [];
  extensions = [...extensionList, devExtension];
  details = { ntfy: ntfyDetail, "acme-crm": acmeDetail };
  discover = discoverEntries;
  catalogs = catalogFixtures;
  publishers = publisherFixtures;
  connectors = [...connectorFixtures, ntfyConnector];
  uploads = [];
  previews = {
    "fly-machines": flyPreview,
    "acme-notes": notesPreview,
    ntfy: ntfyPreview,
    "acme-crm@1.1.0": acmeUpdatePreview,
  };
  installError = null;
  staged.clear();
  socket = null;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("DOMMatrixReadOnly", FakeDOMMatrixReadOnly);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      const method = init?.method ?? "GET";
      const raw = init?.body instanceof Blob ? init.body : undefined;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : raw;
      const contentType = new Headers(init?.headers).get("content-type");
      calls.push({ method, path: url.pathname, body, contentType });
      try {
        const data = route(method, url.pathname, body);
        if (data instanceof Response) return data;
        return new Response(data === undefined ? "" : JSON.stringify(data), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: message }), { status });
      }
    }),
  );
});

afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 0));
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

async function card(name: string) {
  return within(await screen.findByRole("article", { name }));
}

async function dialog() {
  return within(await screen.findByRole("dialog"));
}

describe("installed extensions", () => {
  it("shows each extension's version, publisher, status, and what it adds", async () => {
    renderAt("/extensions");
    const ntfy = await card("ntfy");
    expect(ntfy.getByText("1.0.0")).toBeTruthy();
    expect(ntfy.getByText("Included with Sling")).toBeTruthy();
    expect(ntfy.getByText("running")).toBeTruthy();
    expect(ntfy.getByText("ntfy connector")).toBeTruthy();
    expect(ntfy.getByText("1 action and 1 trigger")).toBeTruthy();
    expect(ntfy.queryByRole("button", { name: /Update to/ })).toBeNull();
    const article = screen.getByRole("article", { name: "ntfy" });
    expect(article.querySelector("img")?.getAttribute("src")).toBe(
      "/api/extensions/ntfy/icon?v=1.0.0",
    );

    const acme = await card("Acme CRM");
    expect(acme.getByText("Acme")).toBeTruthy();
    expect(acme.getByText("(trusted)")).toBeTruthy();
    expect(acme.getByText("idle")).toBeTruthy();
    expect(acme.getByRole("button", { name: "Update to 1.1.0" })).toBeTruthy();

    // A workflow package runs no code, so it has no process status.
    const alerts = await card("Task alerts");
    expect(alerts.getByText("Notify when a task finishes template")).toBeTruthy();
    expect(alerts.queryByText("idle")).toBeNull();

    const weather = await card("Weather");
    expect(weather.getByText("Unsigned")).toBeTruthy();
    expect(weather.getByText("unsupported")).toBeTruthy();
    expect(weather.getByText("Needs Node 26 to run extension code.")).toBeTruthy();

    expect(screen.getByRole("tab", { name: /Installed/ }).textContent).toContain("4");
    expect(screen.getByText("1 update")).toBeTruthy();
  });

  it("shows a revoked version with the catalog's reason, once", async () => {
    const reason = "Sends contact data to the wrong host.";
    extensions = [
      {
        ...acmeExtension,
        enabled: false,
        status: "disabled",
        statusDetail: reason,
        revoked: { reason },
      },
    ];
    renderAt("/extensions");
    const acme = await card("Acme CRM");
    expect(acme.getByRole("alert").textContent).toBe(
      `Its catalog revoked version 1.0.0: ${reason}`,
    );
    expect(acme.getAllByText(new RegExp(reason))).toHaveLength(1);
    expect(acme.getByText("disabled")).toBeTruthy();
  });

  it("turns an extension off", async () => {
    renderAt("/extensions");
    const ntfy = await card("ntfy");
    fireEvent.click(ntfy.getByRole("switch", { name: "Disable ntfy" }));
    await waitFor(() => expect(callsTo("PATCH", "/api/extensions/ntfy")).toHaveLength(1));
    expect(callsTo("PATCH", "/api/extensions/ntfy")[0]?.body).toEqual({ enabled: false });
    expect(await ntfy.findByText("disabled")).toBeTruthy();
    expect(ntfy.getByRole("switch", { name: "Enable ntfy" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("points an empty list at Discover", async () => {
    extensions = [];
    renderAt("/extensions");
    fireEvent.click(await screen.findByRole("button", { name: "Browse extensions" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Discover/ }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    expect(await screen.findByRole("article", { name: "Fly Machines" })).toBeTruthy();
  });

  it("shows details: the README as Markdown, permissions, versions, digest, and the log", async () => {
    renderAt("/extensions");
    fireEvent.click((await card("ntfy")).getByRole("button", { name: "Details" }));
    const d = await dialog();
    expect(await d.findByText(/Sends push notifications through/)).toBeTruthy();
    expect(d.getByRole("link", { name: "ntfy" }).getAttribute("href")).toBe("https://ntfy.sh");
    // Raw HTML in a README is never rendered.
    expect(screen.getByRole("dialog").querySelector("b")).toBeNull();
    expect(d.getByText("Connect to ntfy.sh")).toBeTruthy();
    expect(d.getByText(ntfyDetail.digest)).toBeTruthy();
    expect(within(d.getByRole("list", { name: "Versions" })).getByText("installed")).toBeTruthy();
    expect(d.getByText("Subscribed to alerts")).toBeTruthy();
    expect(d.getByText("Reconnecting after a dropped socket")).toBeTruthy();
    expect(d.getByRole("link", { name: /ntfy\.sh/ }).getAttribute("target")).toBe("_blank");

    fireEvent.click(d.getByRole("switch", { name: "Disable ntfy" }));
    await waitFor(() => expect(callsTo("PATCH", "/api/extensions/ntfy")).toHaveLength(1));
    expect(await d.findByText("Off")).toBeTruthy();
  });

  it("lists the installations and workflows that use an extension before removing it", async () => {
    renderAt("/extensions");
    fireEvent.click((await card("ntfy")).getByRole("button", { name: "Remove ntfy" }));
    const d = await dialog();
    const removed = await d.findByRole("list", { name: "Installations removed" });
    expect(within(removed).getByText("Phone alerts")).toBeTruthy();
    const using = d.getByRole("list", { name: "Workflows that use it" });
    expect(within(using).getByRole("link", { name: "Deploy pings" }).getAttribute("href")).toBe(
      "/workflows/wf_ntfy",
    );
    expect(callsTo("DELETE", "/api/extensions/ntfy")).toHaveLength(0);
    fireEvent.click(d.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(callsTo("DELETE", "/api/extensions/ntfy")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("article", { name: "ntfy" })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when nothing uses an extension", async () => {
    renderAt("/extensions");
    fireEvent.click((await card("Acme CRM")).getByRole("button", { name: "Remove Acme CRM" }));
    const d = await dialog();
    expect(await d.findByText(/Nothing uses it\./)).toBeTruthy();
    expect(d.queryByRole("list")).toBeNull();
  });
});

describe("discover", () => {
  it("shows every catalog's entries with publisher, trust, permissions, and install state", async () => {
    renderAt("/extensions?tab=discover");
    const fly = await card("Fly Machines");
    expect(fly.getByText("Included with Sling")).toBeTruthy();
    expect(fly.getByText("Connect to api.machines.dev, and 1 more")).toBeTruthy();
    expect(fly.getByRole("button", { name: "Install Fly Machines" })).toBeTruthy();

    expect((await card("ntfy")).getByText("Installed")).toBeTruthy();
    const acme = await card("Acme CRM");
    expect(acme.getByText("· Acme extensions")).toBeTruthy();
    expect(acme.getByRole("button", { name: "Update Acme CRM to 1.1.0" })).toBeTruthy();

    const notes = await card("Acme Notes");
    expect(notes.getByText("Beta Labs")).toBeTruthy();
    expect(notes.getByText("· not trusted yet")).toBeTruthy();

    const legacy = await card("Acme Legacy");
    expect(legacy.getByText("unavailable")).toBeTruthy();
    expect(legacy.getByText(/Every version needs SDK/)).toBeTruthy();
    expect(legacy.queryByRole("button")).toBeNull();
  });

  it("filters by search and by kind, all on one request", async () => {
    renderAt("/extensions?tab=discover");
    await card("Fly Machines");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search extensions" }), {
      target: { value: "acme" },
    });
    await waitFor(() => expect(screen.queryByRole("article", { name: "Fly Machines" })).toBeNull());
    expect(screen.getAllByRole("article")).toHaveLength(3);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search extensions" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sandbox providers" }));
    expect(
      screen.getByRole("button", { name: "Sandbox providers" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual([
      "Fly Machines",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Workflow packages" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search extensions" }), {
      target: { value: "zzz" },
    });
    expect(await screen.findByText("No matches")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getAllByRole("article")).toHaveLength(discoverEntries.length);
    expect(callsTo("GET", "/api/extensions/discover")).toHaveLength(1);
  });
});

describe("installing", () => {
  it("previews, then installs what the user saw", async () => {
    renderAt("/extensions?tab=discover");
    fireEvent.click(
      (await card("Fly Machines")).getByRole("button", { name: "Install Fly Machines" }),
    );
    const d = await dialog();
    expect(await d.findByText("Fly Machines sandbox provider")).toBeTruthy();
    expect(callsTo("POST", "/api/extensions/preview")[0]?.body).toEqual({
      catalogId: "included",
      extensionId: "fly-machines",
      version: "1.0.0",
    });
    const perms = d.getByRole("list", { name: "Permissions" });
    const high = within(perms)
      .getByText(/receive each sandbox's secrets/)
      .closest("li");
    expect(high && within(high).getByText("High risk")).toBeTruthy();
    expect(within(perms).getAllByText("High risk")).toHaveLength(1);
    expect(
      d.getByText(
        "It runs in its own process, with no access to files, other credentials, or your machines.",
      ),
    ).toBeTruthy();
    expect(d.queryByText(/Trust/)).toBeNull();

    fireEvent.click(d.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(callsTo("POST", "/api/extensions/install")).toHaveLength(1));
    expect(callsTo("POST", "/api/extensions/install")[0]?.body).toEqual({
      stagingId: "stg_fly",
      digest: "sha256:fly",
      permissions: flyPreview.permissionsKey,
      trustPublisher: false,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Discover refetches, so the card now says it's installed.
    expect(await (await card("Fly Machines")).findByText("Installed")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Installed/ }));
    expect(await screen.findByRole("article", { name: "Fly Machines" })).toBeTruthy();
  });

  it("asks to trust a new publisher's key, next to its fingerprint", async () => {
    renderAt("/extensions?tab=discover");
    fireEvent.click((await card("Acme Notes")).getByRole("button", { name: "Install Acme Notes" }));
    const d = await dialog();
    expect(await d.findByText("Trust Beta Labs?")).toBeTruthy();
    expect(d.getByText("9b8c 7d6e 5f4a 3b2c")).toBeTruthy();
    expect(d.queryByRole("button", { name: "Install" })).toBeNull();
    const before = callsTo("GET", "/api/extension-publishers").length;
    fireEvent.click(d.getByRole("button", { name: "Trust and install" }));
    await waitFor(() => expect(callsTo("POST", "/api/extensions/install")).toHaveLength(1));
    expect(callsTo("POST", "/api/extensions/install")[0]?.body).toMatchObject({
      stagingId: "stg_notes",
      trustPublisher: true,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Not on screen, so nothing refetches until Sources opens.
    expect(callsTo("GET", "/api/extension-publishers")).toHaveLength(before);
  });

  it("blocks the install while the preview has problems", async () => {
    previews["fly-machines"] = {
      ...flyPreview,
      problems: ["A sandbox provider needs the sandboxes permission."],
    };
    renderAt("/extensions?tab=discover");
    fireEvent.click(
      (await card("Fly Machines")).getByRole("button", { name: "Install Fly Machines" }),
    );
    const d = await dialog();
    const alert = await d.findByRole("alert");
    expect(
      within(alert).getByText("A sandbox provider needs the sandboxes permission."),
    ).toBeTruthy();
    expect((d.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers to preview again when the staged package expired", async () => {
    installError = new HttpError(410, "This preview expired. Preview the package again.");
    renderAt("/extensions?tab=discover");
    fireEvent.click(
      (await card("Fly Machines")).getByRole("button", { name: "Install Fly Machines" }),
    );
    const d = await dialog();
    fireEvent.click(await d.findByRole("button", { name: "Install" }));
    expect(await d.findByText("This preview expired.")).toBeTruthy();
    expect(callsTo("POST", "/api/extensions/preview")).toHaveLength(1);
    fireEvent.click(d.getByRole("button", { name: "Preview again" }));
    await waitFor(() => expect(callsTo("POST", "/api/extensions/preview")).toHaveLength(2));
    fireEvent.click(await d.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("notices on its own when a preview runs out of time", async () => {
    previews["fly-machines"] = {
      ...flyPreview,
      expiresAt: new Date(Date.now() + 300).toISOString(),
    };
    renderAt("/extensions?tab=discover");
    fireEvent.click(
      (await card("Fly Machines")).getByRole("button", { name: "Install Fly Machines" }),
    );
    const d = await dialog();
    expect(await d.findByRole("button", { name: "Install" })).toBeTruthy();
    expect(await d.findByText("This preview expired.", {}, { timeout: 2000 })).toBeTruthy();
    expect(d.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("shows a refusal from the server in the dialog", async () => {
    delete previews["fly-machines"];
    renderAt("/extensions?tab=discover");
    fireEvent.click(
      (await card("Fly Machines")).getByRole("button", { name: "Install Fly Machines" }),
    );
    const d = await dialog();
    expect(await d.findByText("Nothing to preview")).toBeTruthy();
    expect(d.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("uploads a .slx file and lists what it needs, installing a requirement from a catalog", async () => {
    discover = discoverEntries.map((e) => (e.id === "ntfy" ? { ...e, installed: null } : e));
    extensions = extensions.filter((x) => x.id !== "ntfy");
    uploads = [
      deployPackPreview,
      {
        ...deployPackPreview,
        stagingId: "stg_pack_2",
        missing: { extensions: [], connectors: ["discord"] },
      },
    ];
    renderAt("/extensions");
    const input = (await screen.findByLabelText("Extension package file")) as HTMLInputElement;
    const file = new File(["slx"], "deploy-pings-1.0.0.slx", { type: "application/octet-stream" });
    fireEvent.change(input, { target: { files: [file] } });

    const d = await dialog();
    expect(await d.findByText("Install Deploy pings")).toBeTruthy();
    const upload = callsTo("POST", "/api/extensions/preview")[0];
    expect(upload?.contentType).toBe("application/octet-stream");
    expect(upload?.body).toBeInstanceOf(Blob);
    expect(d.getByText("Unsigned")).toBeTruthy();
    expect(d.getByText(/Nobody signed this package/)).toBeTruthy();
    expect(d.getByText("It adds templates only and runs no code.")).toBeTruthy();

    const missing = d.getByRole("list", { name: "Missing requirements" });
    expect(within(missing).getByText("The discord connector")).toBeTruthy();
    fireEvent.click(await within(missing).findByRole("button", { name: "Install ntfy" }));

    expect(await d.findByText("Install ntfy")).toBeTruthy();
    fireEvent.click(await d.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(callsTo("POST", "/api/extensions/install")).toHaveLength(1));
    expect(callsTo("POST", "/api/extensions/install")[0]?.body).toMatchObject({
      stagingId: "stg_ntfy",
    });

    // Back to the package, previewed again now that ntfy is in.
    expect(await d.findByText("Install Deploy pings")).toBeTruthy();
    await waitFor(() => expect(callsTo("POST", "/api/extensions/preview")).toHaveLength(3));
    await waitFor(() => expect(d.queryByRole("button", { name: "Install ntfy" })).toBeNull());
    fireEvent.click(await d.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(callsTo("POST", "/api/extensions/install")).toHaveLength(2));
    expect(callsTo("POST", "/api/extensions/install")[1]?.body).toMatchObject({
      stagingId: "stg_pack_2",
    });
  });
});

describe("updating", () => {
  it("shows the permissions an update adds and removes before confirming", async () => {
    renderAt("/extensions");
    fireEvent.click((await card("Acme CRM")).getByRole("button", { name: "Update to 1.1.0" }));
    const d = await dialog();
    expect(await d.findByText("Update Acme CRM")).toBeTruthy();
    expect(callsTo("POST", "/api/extensions/acme-crm/update/preview")[0]?.body).toEqual({
      version: "1.1.0",
    });
    expect(d.getByText(/1\.0\.0/)).toBeTruthy();
    const added = d.getByRole("list", { name: "Permissions added" });
    expect(within(added).getByText(/Connect to acme.test and its subdomains/)).toBeTruthy();
    expect(within(added).getByText(/local network/)).toBeTruthy();
    expect(within(added).getAllByText("High risk")).toHaveLength(1);
    const removed = d.getByRole("list", { name: "Permissions removed" });
    expect(within(removed).getByText(/Connect to api.acme.test/)).toBeTruthy();

    fireEvent.click(d.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(callsTo("POST", "/api/extensions/install")).toHaveLength(1));
    expect(callsTo("POST", "/api/extensions/install")[0]?.body).toEqual({
      stagingId: "stg_acme",
      digest: "sha256:acme110",
      permissions: acmeUpdatePreview.permissionsKey,
      trustPublisher: false,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const acme = await card("Acme CRM");
    expect(await acme.findByText("1.1.0")).toBeTruthy();
    expect(acme.queryByRole("button", { name: /Update to/ })).toBeNull();
  });

  it("updates from a Discover card too", async () => {
    renderAt("/extensions?tab=discover");
    fireEvent.click(
      (await card("Acme CRM")).getByRole("button", { name: "Update Acme CRM to 1.1.0" }),
    );
    expect(await (await dialog()).findByText("Update Acme CRM")).toBeTruthy();
  });
});

describe("sources", () => {
  it("lists catalogs with the included one first and fixed, and refreshes or removes the rest", async () => {
    renderAt("/extensions?tab=sources");
    const list = within(await screen.findByRole("list", { name: "Catalogs" }));
    const rows = list.getAllByRole("listitem");
    expect(rows[0]?.textContent).toContain("Included with Sling");
    expect(rows[0]?.textContent).toContain("Ships with Sling");
    expect(within(rows[0] as HTMLElement).queryByRole("button")).toBeNull();
    const acme = within(rows[1] as HTMLElement);
    expect(acme.getByText("https://extensions.acme.test/catalog.json")).toBeTruthy();
    expect(rows[1]?.textContent).toContain("3 extensions · fetched");

    fireEvent.click(list.getByRole("button", { name: "Refresh Acme extensions" }));
    await waitFor(() =>
      expect(callsTo("POST", "/api/extension-catalogs/cat_acme/refresh")).toHaveLength(1),
    );
    await waitFor(() =>
      expect(list.getAllByRole("listitem")[1]?.textContent).toContain(
        "4 extensions · fetched just now",
      ),
    );

    fireEvent.click(list.getByRole("button", { name: "Remove Acme extensions" }));
    const d = await dialog();
    expect(d.getByText(/stay installed, but Sling stops checking it for updates/)).toBeTruthy();
    fireEvent.click(d.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(callsTo("DELETE", "/api/extension-catalogs/cat_acme")).toHaveLength(1),
    );
    await waitFor(() => expect(list.queryByText("Acme extensions")).toBeNull());
  });

  it("adds a catalog by URL", async () => {
    renderAt("/extensions?tab=sources");
    await screen.findByRole("list", { name: "Catalogs" });
    fireEvent.click(screen.getByRole("button", { name: "Add catalog" }));
    const d = await dialog();
    const add = d.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(d.getByLabelText(/^URL/), {
      target: { value: "https://weather.test/catalog.json" },
    });
    fireEvent.click(add);
    await waitFor(() => expect(callsTo("POST", "/api/extension-catalogs")).toHaveLength(1));
    expect(callsTo("POST", "/api/extension-catalogs")[0]?.body).toEqual({
      url: "https://weather.test/catalog.json",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Weather tools")).toBeTruthy();
  });

  it("lists trusted publishers and what's pinned to them, and removes one after a warning", async () => {
    renderAt("/extensions?tab=sources");
    const list = within(await screen.findByRole("list", { name: "Trusted publishers" }));
    expect(list.getByText("Acme")).toBeTruthy();
    expect(list.getByText("3f2a 91c0 7d4e 22b1")).toBeTruthy();
    expect(list.getByText(/^Signs Acme CRM/)).toBeTruthy();

    fireEvent.click(list.getByRole("button", { name: "Stop trusting Acme" }));
    const d = await dialog();
    expect(
      d.getByText(/New installs and updates signed by this key will be refused\./),
    ).toBeTruthy();
    expect(d.getByText(/Acme CRM stays installed and keeps running\./)).toBeTruthy();
    fireEvent.click(d.getByRole("button", { name: "Stop trusting" }));
    await waitFor(() =>
      expect(callsTo("DELETE", "/api/extension-publishers/3f2a91c07d4e22b1")).toHaveLength(1),
    );
    expect(await screen.findByText("No trusted publishers")).toBeTruthy();
  });
});

describe("realtime", () => {
  it("patches a card's status, adds new extensions, and drops removed ones", async () => {
    renderAt("/extensions");
    const acme = await card("Acme CRM");
    expect(acme.getByText("idle")).toBeTruthy();
    emit({ type: "extension.updated", extension: { ...acmeExtension, status: "running" } });
    expect(await acme.findByText("running")).toBeTruthy();

    emit({
      type: "extension.updated",
      extension: { ...ntfyExtension, id: "pager", name: "Pager", hasIcon: false },
    });
    expect(await screen.findByRole("article", { name: "Pager" })).toBeTruthy();

    emit({ type: "extension.removed", id: "acme-crm" });
    await waitFor(() => expect(screen.queryByRole("article", { name: "Acme CRM" })).toBeNull());
  });

  it("refetches connectors when an extension changes what it adds", async () => {
    renderAt("/connectors");
    expect(await screen.findByText("From ntfy 1.0.0")).toBeTruthy();
    const before = callsTo("GET", "/api/connectors").length;
    connectors = [
      ...connectorFixtures,
      {
        ...ntfyConnector,
        extension: { id: "ntfy", name: "ntfy", version: "1.1.0", hasIcon: true },
      },
    ];
    emit({ type: "extension.updated", extension: { ...ntfyExtension, version: "1.1.0" } });
    expect(await screen.findByText("From ntfy 1.1.0")).toBeTruthy();
    expect(callsTo("GET", "/api/connectors")).toHaveLength(before + 1);
  });
});

describe("elsewhere", () => {
  it("shows which extension a connector came from, with its icon", async () => {
    renderAt("/connectors");
    const from = await screen.findByText("From ntfy 1.0.0");
    const cardEl = from.closest(".rounded-xl") as HTMLElement;
    const img = cardEl.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/api/extensions/ntfy/icon?v=1.0.0");
    expect(screen.queryByText(/From Discord/)).toBeNull();
  });

  it("shows which package a template came from", async () => {
    renderAt("/workflows");
    fireEvent.click(await screen.findByRole("button", { name: "From template" }));
    const d = await dialog();
    expect(await d.findByText("From Task alerts")).toBeTruthy();
    expect(d.getAllByText(/^From /)).toHaveLength(1);
  });

  it("exports a workflow as a package from the editor", async () => {
    const saved: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:slx");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    renderAt("/workflows/wf_1?tab=versions");
    fireEvent.click(await screen.findByRole("button", { name: "Export" }, { timeout: 3000 }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export as package" }));
    const d = await dialog();
    expect(d.getByText("Built from version 1, the active one.")).toBeTruthy();
    expect((d.getByLabelText("Name") as HTMLInputElement).value).toBe("Important email to Discord");
    const id = d.getByLabelText("ID") as HTMLInputElement;
    expect(id.value).toBe("important-email-to-discord");
    expect((d.getByLabelText("Version") as HTMLInputElement).value).toBe("1.0.0");

    // The ID follows the name until it's edited, and must be a valid ID.
    fireEvent.change(d.getByLabelText("Name"), { target: { value: "Important email" } });
    expect(id.value).toBe("important-email");
    fireEvent.change(id, { target: { value: "9-bad" } });
    expect((d.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(id, { target: { value: "important-email" } });

    fireEvent.click(d.getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(callsTo("POST", "/api/workflows/wf_1/export-package")).toHaveLength(1),
    );
    expect(callsTo("POST", "/api/workflows/wf_1/export-package")[0]?.body).toEqual({
      id: "important-email",
      version: "1.0.0",
      name: "Important email",
    });
    await waitFor(() => expect(saved).toEqual(["important-email-1.0.0.slx"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
