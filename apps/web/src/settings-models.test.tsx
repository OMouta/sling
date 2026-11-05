// @vitest-environment happy-dom
import type { ModelCatalogView, ProviderModelsView } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

function route(path: string): unknown {
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
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      return Response.json(route(url.pathname));
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

  it("keeps the API key behind a button on the same row", async () => {
    const list = await providers();
    const [openai] = (await list.findAllByRole("listitem")) as [HTMLElement];
    expect(within(openai).queryByLabelText("API key for OpenAI")).toBeNull();
    fireEvent.click(within(openai).getByRole("button", { name: "Add API key" }));
    expect(within(openai).getByLabelText("API key for OpenAI")).toBeTruthy();
  });
});
