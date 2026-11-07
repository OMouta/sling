// @vitest-environment happy-dom
import {
  type ExtensionPreview,
  PERSONALITY_TOOL_INFO,
  PERSONALITY_TOOLS,
  type PersonalityTemplateView,
  type PersonalityView,
} from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewDialog } from "./components/extensions/PreviewDialog.tsx";
import type { PreviewSource } from "./lib/extensionApi.ts";
import { createAppRouter } from "./router.tsx";
import { agendaPreview, notesPreview, ntfyAssistantUpdate } from "./test/fixtures.ts";

vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signOut: async () => {},
  },
}));

let posts: { path: string; body: unknown }[] = [];

const personalityTemplates: PersonalityTemplateView[] = [
  {
    key: "ops",
    group: "Your machines",
    name: "Ops",
    description: "Checks your servers.",
    instructions: "You are Ops. Leave code alone.",
    tools: ["commands"],
    color: "amber",
    shape: "ripple",
  },
  {
    key: "travel",
    group: "Everyday",
    name: "Travel",
    description: "Plans trips around your dates.",
    instructions: "You are Travel.",
    tools: [],
    color: "blue",
    shape: "orbit",
  },
];
let previews: Record<string, ExtensionPreview> = {};

function route(method: string, path: string, body: unknown): unknown {
  if (method === "POST") {
    posts.push({ path, body });
    if (path === "/api/extensions/preview") {
      return previews[(body as { extensionId: string }).extensionId];
    }
    const update = /^\/api\/extensions\/([^/]+)\/update\/preview$/.exec(path)?.[1];
    if (update) return previews[`${update}@${(body as { version: string }).version}`];
    if (path === "/api/personalities") {
      return { ...(body as object), id: "per_new" } as PersonalityView;
    }
    return { ok: true };
  }
  if (path === "/api/status") {
    return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
  }
  if (path === "/api/personalities/templates") return personalityTemplates;
  if (path === "/api/personalities" || path === "/api/conversations" || path === "/api/runners") {
    return [];
  }
  return null;
}

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  send() {}
  close() {}
}

beforeEach(() => {
  posts = [];
  previews = {
    agenda: agendaPreview,
    "acme-notes": notesPreview,
    "ntfy@1.1.0": ntfyAssistantUpdate,
  };
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return Response.json(route(init?.method ?? "GET", url.pathname, body));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderAt(path: string) {
  const queryClient = client();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
}

function openPreview(source: PreviewSource) {
  render(
    <QueryClientProvider client={client()}>
      <PreviewDialog source={source} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("personality tool groups", () => {
  it("offers apps, deploys, and setup, with what each lets it do", async () => {
    renderAt("/personalities/new");
    const apps = await screen.findByRole("switch", { name: "Apps and workflows" });
    const deploys = screen.getByRole("switch", { name: "Deploys" });
    expect(screen.getByRole("switch", { name: "Change Sling's setup" })).toBeTruthy();
    expect(screen.getByText(PERSONALITY_TOOL_INFO.apps.description)).toBeTruthy();
    expect(screen.getByText(PERSONALITY_TOOL_INFO.deploys.description)).toBeTruthy();
    expect(screen.getByText(PERSONALITY_TOOL_INFO.setup.description)).toBeTruthy();
    expect(screen.getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual(
      PERSONALITY_TOOLS.map((t) => PERSONALITY_TOOL_INFO[t].label),
    );
    expect(PERSONALITY_TOOLS.slice(2, 5)).toEqual(["apps", "deploys", "setup"]);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "On call" } });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Keep the site up." },
    });
    fireEvent.click(deploys);
    fireEvent.click(apps);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts.some((p) => p.path === "/api/personalities")).toBe(true));
    expect(posts.find((p) => p.path === "/api/personalities")?.body).toMatchObject({
      name: "On call",
      tools: ["apps", "deploys"],
    });
  });
});

describe("new personality", () => {
  it("makes one from a template a step at a time, each step filled in from it", async () => {
    renderAt("/personalities");
    fireEvent.click(await screen.findByRole("button", { name: "New personality" }));
    const d = within(await screen.findByRole("dialog", { name: "New personality" }));
    const next = () => d.getByRole("button", { name: /^(Continue|Create)$/ }) as HTMLButtonElement;
    expect(d.getByRole("heading", { name: "What should it start from?" })).toBeTruthy();
    expect(next().disabled).toBe(true);
    // Templates under their group headings.
    expect(await d.findByText("Your machines")).toBeTruthy();
    fireEvent.click(d.getByRole("radio", { name: /Ops/ }));
    fireEvent.click(next());

    expect(d.getByRole("heading", { name: "What's it called?" })).toBeTruthy();
    const name = d.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Ops");
    fireEvent.change(name, { target: { value: "" } });
    expect(next().disabled).toBe(true);
    fireEvent.change(name, { target: { value: "Servers" } });
    fireEvent.click(next());

    expect(d.getByRole("heading", { name: "How should it look?" })).toBeTruthy();
    expect(d.getByRole("radio", { name: /Ripple/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(d.getByRole("radio", { name: "Green" }));
    fireEvent.click(next());

    expect(d.getByRole("heading", { name: "What can it use?" })).toBeTruthy();
    const tools = within(d.getByRole("group", { name: "Tools" }));
    expect(
      tools
        .getAllByRole("checkbox")
        .filter((c) => c.getAttribute("aria-checked") === "true")
        .map((c) => c.textContent),
    ).toEqual([
      `${PERSONALITY_TOOL_INFO.commands.label}${PERSONALITY_TOOL_INFO.commands.description}`,
    ]);
    fireEvent.click(tools.getByRole("checkbox", { name: /Deploys/ }));
    fireEvent.click(next());

    expect(d.getByRole("heading", { name: "What are its instructions?" })).toBeTruthy();
    expect((d.getByLabelText("Instructions") as HTMLTextAreaElement).value).toBe(
      "You are Ops. Leave code alone.",
    );
    fireEvent.click(next());
    await waitFor(() => expect(posts.some((p) => p.path === "/api/personalities")).toBe(true));
    expect(posts.find((p) => p.path === "/api/personalities")?.body).toEqual({
      name: "Servers",
      description: "Checks your servers.",
      instructions: "You are Ops. Leave code alone.",
      tools: ["commands", "deploys"],
      color: "green",
      shape: "ripple",
      templateKey: "ops",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("needs instructions when it starts blank", async () => {
    renderAt("/personalities");
    fireEvent.click(await screen.findByRole("button", { name: "New personality" }));
    const d = within(await screen.findByRole("dialog", { name: "New personality" }));
    fireEvent.click(await d.findByRole("radio", { name: /Blank/ }));
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    fireEvent.change(d.getByLabelText("Name"), { target: { value: "Notes" } });
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    // Nothing ticked to start with.
    expect(
      within(d.getByRole("group", { name: "Tools" }))
        .getAllByRole("checkbox")
        .every((c) => c.getAttribute("aria-checked") === "false"),
    ).toBe(true);
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    const create = d.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(d.getByLabelText("Instructions"), { target: { value: "Keep notes." } });
    fireEvent.click(create);
    await waitFor(() => expect(posts.some((p) => p.path === "/api/personalities")).toBe(true));
    const body = posts.find((p) => p.path === "/api/personalities")?.body as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ name: "Notes", instructions: "Keep notes.", tools: [] });
    expect(body.templateKey).toBeUndefined();
  });
});

describe("extension dialogs", () => {
  it("lists the nodes the assistant can use when installing, marking the ones that send", async () => {
    openPreview({
      kind: "catalog",
      catalogId: "included",
      extensionId: "agenda",
      version: "1.0.0",
      name: "Agenda",
    });
    const list = within(await screen.findByRole("list", { name: "The assistant can use" }));
    const items = list.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["List agenda items", "Add an agenda itemSends"]);
  });

  it("says so in the update dialog when a new version lets the assistant use a node", async () => {
    openPreview({ kind: "update", extensionId: "ntfy", version: "1.1.0", name: "ntfy" });
    const list = within(await screen.findByRole("list", { name: "The assistant can use" }));
    expect(list.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Publish to ntfySends",
    ]);
    expect(screen.getByText("Permission changes")).toBeTruthy();
  });

  it("leaves the section out when the assistant can't use any of its nodes", async () => {
    openPreview({
      kind: "catalog",
      catalogId: "cat_acme",
      extensionId: "acme-notes",
      version: "2.0.0",
      name: "Acme Notes",
    });
    expect(await screen.findByText("Adds")).toBeTruthy();
    expect(screen.queryByText("The assistant can use")).toBeNull();
  });
});
