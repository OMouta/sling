// @vitest-environment happy-dom
import type { ModelCatalogView, ProviderModelsView } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";

// The auth client keeps the fetch it found at import, before the stub below.
vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signOut: async () => {},
  },
}));

const model = {
  id: "gpt-6.1-sol",
  label: "GPT-6.1-Sol",
  description: "",
  efforts: ["low"],
  defaultEffort: "low",
  fast: false,
};
const api = (provider: ProviderModelsView["provider"], label: string): ProviderModelsView => ({
  provider,
  kind: "api",
  label,
  connected: false,
  machines: [],
  login: null,
  error: null,
  models: [],
});
const catalog: ModelCatalogView = {
  assistant: [
    {
      provider: "codex",
      kind: "cli",
      label: "Codex",
      connected: true,
      machines: ["Tiagos-Air"],
      login: "Logged in using ChatGPT",
      error: null,
      models: [model],
    },
    {
      provider: "claude-code",
      kind: "cli",
      label: "Claude Code",
      connected: false,
      machines: [],
      login: "Logged in using claude.ai",
      error: "buildbox is offline.",
      models: [],
    },
    api("openai", "OpenAI"),
    api("anthropic", "Anthropic"),
    api("openai-compatible", "OpenAI-compatible"),
  ],
  agents: [],
  defaults: {
    assistant: { provider: "codex", model: "gpt-6.1-sol", effort: null, fast: false },
    agent: { harness: "codex", model: null, effort: null, fast: false },
  },
};
const provider = (id: string, label: string, needsBaseUrl = false) => ({
  id,
  label,
  needsBaseUrl,
  defaultModel: "",
  hasKey: false,
  baseUrl: null,
  connected: false,
});

let calls: { method: string; path: string; body: unknown }[] = [];
const listed = (id: string, label: string) => ({ ...model, id, label });

/** The catalog once a provider's key is saved: its models, or why it couldn't list them. */
function saved(id: string, body: { apiKey?: string; baseUrl?: string }): ModelCatalogView {
  const refused = body.apiKey === "sk-wrong";
  return {
    ...catalog,
    assistant: catalog.assistant.map((a) =>
      a.kind === "api" && a.provider === id
        ? {
            ...a,
            connected: true,
            error: refused ? "Couldn't load models: 401: Incorrect API key provided" : null,
            models: refused
              ? []
              : id === "openai-compatible"
                ? [listed("llama3.3:70b", "llama3.3:70b"), listed("qwen3:32b", "qwen3:32b")]
                : [listed("gpt-6.5", "GPT-6.5"), listed("gpt-6.1", "GPT-6.1")],
          }
        : a,
    ),
  };
}

function route(method: string, path: string, body: unknown): unknown {
  const keyFor = /^\/api\/settings\/providers\/([^/]+)$/.exec(path)?.[1];
  if (keyFor && method === "PUT") return saved(keyFor, body as { apiKey?: string });
  if (keyFor && method === "DELETE") return catalog;
  if (path === "/api/settings/chat-defaults" && method === "PUT") {
    return { ...catalog.defaults, ...(body as object) };
  }
  switch (path) {
    case "/api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "/api/models":
      return catalog;
    case "/api/settings":
      return {
        defaultMode: "supervised",
        modes: ["read-only", "supervised", "auto", "full-access"],
        providers: [
          provider("openai", "OpenAI"),
          provider("anthropic", "Anthropic"),
          provider("openai-compatible", "OpenAI-compatible", true),
        ],
        model: null,
      };
    case "/api/conversations":
    case "/api/approvals":
    case "/api/runners":
    case "/api/connectors":
    case "/api/installations":
      return [];
    default:
      return null;
  }
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
  calls = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      return Response.json(route(method, url.pathname, body));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function providers() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/settings"] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
  return within(await screen.findByRole("list", { name: "Model providers" }));
}

describe("the default permission mode in Settings", () => {
  it("asks before making Full access the default", async () => {
    await providers();
    fireEvent.click(screen.getByRole("radio", { name: /Full access/ }));
    const ask = within(await screen.findByRole("dialog", { name: "Switch to Full access?" }));
    expect(calls.some((c) => c.path === "/api/settings/mode")).toBe(false);
    fireEvent.click(ask.getByRole("button", { name: "Switch to Full access" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/settings/mode")?.body).toEqual({
        defaultMode: "full-access",
      }),
    );
  });
});

describe("model providers in Settings", () => {
  it("shows one row per provider, the subscription and the API key together", async () => {
    const list = await providers();
    const rows = await list.findAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("p")?.textContent)).toEqual([
      "OpenAIReady",
      "Anthropic",
      "Local or other",
    ]);
    const [openai, anthropic] = rows as [HTMLElement, HTMLElement];
    expect(
      within(openai).getByText("Through Codex on Tiagos-Air. Logged in using ChatGPT."),
    ).toBeTruthy();
    // An offline machine is named, not reported as logged out.
    expect(within(anthropic).getByText("buildbox is offline.")).toBeTruthy();
    expect(screen.queryByText(/Not logged in/)).toBeNull();
  });

  it("adds an API key a step at a time: the key, then the model new chats use", async () => {
    const list = await providers();
    const [openai] = (await list.findAllByRole("listitem")) as [HTMLElement];
    // Nothing to type on the row itself.
    expect(within(openai).queryByLabelText("API key for OpenAI")).toBeNull();
    fireEvent.click(within(openai).getByRole("button", { name: "Add API key" }));
    const d = within(await screen.findByRole("dialog", { name: "Add an OpenAI API key" }));
    expect(d.getByRole("heading", { name: "Paste your OpenAI API key" })).toBeTruthy();
    expect(d.getByRole("link", { name: /platform\.openai\.com/ }).getAttribute("href")).toBe(
      "https://platform.openai.com/api-keys",
    );
    const next = () => d.getByRole("button", { name: /^(Continue|Finish)$/ }) as HTMLButtonElement;
    expect(next().disabled).toBe(true);
    fireEvent.change(d.getByLabelText("API key for OpenAI"), { target: { value: "sk-good" } });
    fireEvent.click(next());

    // What the key can see, with what new chats use now first.
    await d.findByRole("heading", { name: "Which model should new chats use?" });
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ apiKey: "sk-good" });
    expect(d.getByText("2 models on this key")).toBeTruthy();
    expect(d.getAllByRole("radio").map((r) => r.textContent)).toEqual([
      "Keep GPT-6.1-SolWhat new chats start with now",
      "GPT-6.5gpt-6.5",
      "GPT-6.1gpt-6.1",
    ]);
    expect(d.getByRole("radio", { name: /Keep/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(d.getByRole("radio", { name: /GPT-6\.5/ }));
    fireEvent.click(next());
    await d.findByText("OpenAI is connected");
    expect(d.getByText("2 models · New chats use GPT-6.5")).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/settings/chat-defaults")?.body).toEqual({
      assistant: { provider: "openai", model: "gpt-6.5", effort: null, fast: false },
    });
  });

  it("doesn't keep a key the provider refuses, and says why in place", async () => {
    const list = await providers();
    const [openai] = (await list.findAllByRole("listitem")) as [HTMLElement];
    fireEvent.click(within(openai).getByRole("button", { name: "Add API key" }));
    const d = within(await screen.findByRole("dialog", { name: "Add an OpenAI API key" }));
    fireEvent.change(d.getByLabelText("API key for OpenAI"), { target: { value: "sk-wrong" } });
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    expect((await d.findByRole("alert")).textContent).toContain("Incorrect API key provided");
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.path === "/api/settings/providers/openai"),
      ).toBe(true),
    );
    expect(d.getByRole("heading", { name: "Paste your OpenAI API key" })).toBeTruthy();
  });

  it("connects a local server: which one, where it is, then the model", async () => {
    const list = await providers();
    const rows = (await list.findAllByRole("listitem")) as HTMLElement[];
    fireEvent.click(within(rows[2] as HTMLElement).getByRole("button", { name: "Set up" }));
    const d = within(await screen.findByRole("dialog", { name: "Connect a model server" }));
    expect(d.getByRole("heading", { name: "Which server is it?" })).toBeTruthy();
    fireEvent.click(d.getByRole("radio", { name: /Ollama/ }));
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    expect(d.getByRole("heading", { name: "Where is Ollama?" })).toBeTruthy();
    // Filled in for Ollama on the Docker host; a key is optional.
    expect((d.getByLabelText("Address") as HTMLInputElement).value).toBe(
      "http://host.docker.internal:11434/v1",
    );
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    await d.findByRole("heading", { name: "Which model should new chats use?" });
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      path: "/api/settings/providers/openai-compatible",
      body: { baseUrl: "http://host.docker.internal:11434/v1" },
    });
    expect(d.getByText("2 models on Ollama")).toBeTruthy();
    // Keeping what new chats use changes nothing else.
    fireEvent.click(d.getByRole("button", { name: "Finish" }));
    await d.findByText("Ollama is connected");
    expect(calls.some((c) => c.path === "/api/settings/chat-defaults")).toBe(false);
  });

  it("asks OpenRouter for its key, with where to make one", async () => {
    const list = await providers();
    const rows = (await list.findAllByRole("listitem")) as HTMLElement[];
    fireEvent.click(within(rows[2] as HTMLElement).getByRole("button", { name: "Set up" }));
    const d = within(await screen.findByRole("dialog", { name: "Connect a model server" }));
    fireEvent.click(d.getByRole("radio", { name: /OpenRouter/ }));
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    expect(d.getByRole("link", { name: /openrouter\.ai/ })).toBeTruthy();
    const next = d.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.change(d.getByLabelText("API key"), { target: { value: "sk-or-1" } });
    expect(next.disabled).toBe(false);
  });
});
