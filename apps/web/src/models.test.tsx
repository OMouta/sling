// @vitest-environment happy-dom
import type { AssistantChoice, ModelCatalogView, PermissionMode } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatControls } from "./components/ModelPicker.tsx";
import { TwoFactorDialog } from "./components/TwoFactorDialog.tsx";

const codexModels = [
  {
    id: "gpt-6.1-sol",
    label: "GPT-6.1-Sol",
    description: "",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "low",
    fast: true,
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "",
    efforts: ["low", "medium", "high"],
    defaultEffort: "low",
    fast: false,
  },
];
const claudeModels = [
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    description: "",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    fast: true,
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    description: "",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    fast: false,
  },
];
const off = { connected: false, error: null, models: [], machines: [], login: null };
const catalog: ModelCatalogView = {
  assistant: [
    {
      provider: "codex",
      kind: "cli",
      label: "Codex",
      connected: true,
      machines: ["devbox"],
      login: "Logged in using ChatGPT",
      error: null,
      models: codexModels,
    },
    {
      provider: "claude-code",
      kind: "cli",
      label: "Claude Code",
      connected: true,
      machines: ["devbox"],
      login: "Logged in using claude.ai",
      error: null,
      models: claudeModels,
    },
    { provider: "openai", kind: "api", label: "OpenAI", ...off },
    { provider: "anthropic", kind: "api", label: "Anthropic", ...off },
    { provider: "openai-compatible", kind: "api", label: "OpenAI-compatible", ...off },
  ],
  agents: [
    {
      harness: "codex",
      label: "Codex",
      readyMachines: 1,
      defaultModel: "gpt-6.1-sol",
      models: codexModels,
    },
    {
      harness: "claude-code",
      label: "Claude Code",
      readyMachines: 1,
      defaultModel: null,
      models: claudeModels,
    },
  ],
  defaults: {
    assistant: { provider: "claude-code", model: "claude-opus-5-5", effort: null, fast: false },
    agent: { harness: "codex", model: null, effort: null, fast: false },
  },
};

let calls: { method: string; path: string; body: unknown }[] = [];
let enableFresh: () => Response = () =>
  Response.json({
    totpURI: "otpauth://totp/Sling:a@b.c?secret=JBSWY3DPEHPK3PXP&issuer=Sling",
    backupCodes: ["aaaaa-bbbbb", "ccccc-ddddd"],
  });

beforeEach(() => {
  calls = [];
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
      if (url.pathname === "/api/auth/two-factor/enable-fresh") return enableFresh();
      if (url.pathname === "/api/auth/two-factor/verify-totp") return Response.json({ ok: true });
      if (url.pathname.startsWith("/api/settings/providers/")) {
        return Response.json({
          ...catalog,
          assistant: catalog.assistant.map((p) =>
            p.provider === "openai"
              ? {
                  ...p,
                  connected: true,
                  models: [
                    {
                      id: "gpt-5.1",
                      label: "GPT-5.1",
                      description: "",
                      efforts: [],
                      defaultEffort: null,
                      fast: false,
                    },
                  ],
                }
              : p,
          ),
        });
      }
      return Response.json(null);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

/** For parts that link to other pages. */
async function wrapRouted(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <>{node}</> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: /^Model:/ });
}

function Harness({ mode = "supervised", empty }: { mode?: PermissionMode; empty?: boolean }) {
  const [assistant, setAssistant] = useState<AssistantChoice | null>(
    empty ? null : catalog.defaults.assistant,
  );
  const [m, setMode] = useState<PermissionMode>(mode);
  const c = empty
    ? { ...catalog, assistant: catalog.assistant.map((p) => ({ ...p, connected: false })) }
    : catalog;
  return (
    <ChatControls
      catalog={c}
      assistant={assistant}
      onAssistant={setAssistant}
      mode={m}
      onMode={setMode}
    />
  );
}

describe("model picker", () => {
  it("is one pill with the model and its reasoning level", () => {
    wrap(<Harness />);
    expect(screen.getByRole("button", { name: "Model: Opus 5.5, Medium" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Coding agent/ })).toBeNull();
  });

  it("lists the CLIs on your machines, not API providers without a key", () => {
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    const dialog = screen.getByRole("dialog", { name: "Choose a model" });
    expect(within(dialog).getByRole("button", { name: "Codex on devbox" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Claude Code on devbox" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /OpenAI API/ })).toBeNull();
    // It opens on the current model's provider.
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      expect.stringContaining("Claude Opus 5.5"),
      expect.stringContaining("Claude Sonnet 5.5"),
    ]);
  });

  it("shows one entry per provider, the subscription first", () => {
    const withKey = {
      ...catalog,
      assistant: catalog.assistant.map((p) =>
        p.provider === "openai" ? { ...p, connected: true, models: codexModels } : p,
      ),
    };
    wrap(<ChatControls catalog={withKey} assistant={null} onAssistant={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    const dialog = screen.getByRole("dialog", { name: "Choose a model" });
    expect(within(dialog).getByRole("button", { name: "Codex on devbox" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "OpenAI API key" })).toBeNull();
    cleanup();

    // With no machine on, the key takes its place.
    const offline = {
      ...withKey,
      assistant: withKey.assistant.map((p) =>
        p.provider === "codex" ? { ...p, connected: false, machines: [] } : p,
      ),
    };
    wrap(<ChatControls catalog={offline} assistant={null} onAssistant={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    expect(screen.getByRole("button", { name: "OpenAI API key" })).toBeTruthy();
  });

  it("picks a model and a reasoning level without typing", () => {
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    const reasoning = screen.getByRole("radiogroup", { name: "Reasoning" });
    fireEvent.click(within(reasoning).getByRole("radio", { name: /Extra High/ }));
    expect(screen.getByRole("button", { name: "Model: Opus 5.5, Extra High" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Codex on devbox" }));
    fireEvent.click(screen.getByRole("option", { name: /GPT-6\.1-Sol/ }));
    // GPT-6.1-Sol takes Extra High too, so the level carries over.
    expect(screen.getByRole("button", { name: "Model: GPT-6.1-Sol, Extra High" })).toBeTruthy();
  });

  it("searches across providers", () => {
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "5.6" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("GPT-5.6-Sol"),
    ]);
  });

  it("marks the provider of the search result it's on", () => {
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    const codex = screen.getByRole("button", { name: "Codex on devbox" });
    const claude = screen.getByRole("button", { name: "Claude Code on devbox" });
    expect(claude.getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "5.6" } });
    expect(codex.getAttribute("aria-pressed")).toBe("true");
    expect(claude.getAttribute("aria-pressed")).toBe("false");
    // Picking a provider leaves the search for its list.
    fireEvent.click(claude);
    expect((screen.getByLabelText("Search models") as HTMLInputElement).value).toBe("");
    expect(claude.getAttribute("aria-pressed")).toBe("true");
  });

  it("closes on Escape wherever focus is, and when the mode menu opens", () => {
    wrap(<Harness />);
    const pill = screen.getByRole("button", { name: /^Model:/ });
    fireEvent.click(pill);
    expect(screen.getByRole("dialog", { name: "Choose a model" })).toBeTruthy();
    fireEvent.keyDown(pill, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose a model" })).toBeNull();

    fireEvent.click(pill);
    const mode = screen.getByRole("button", { name: "Permission mode: Supervised" });
    fireEvent.pointerDown(mode);
    fireEvent.click(mode);
    expect(screen.queryByRole("dialog", { name: "Choose a model" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Full access/ })).toBeTruthy();
  });

  it("offers Fast only where the model has it", () => {
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    const fast = () =>
      within(screen.getByRole("radiogroup", { name: "Speed" })).getByRole("radio", {
        name: /Fast/,
      }) as HTMLButtonElement;
    // Opus has fast mode on Claude Code, paid from usage credits.
    expect(fast().disabled).toBe(false);
    fireEvent.click(fast());
    expect(screen.getByText("Billed to usage credits")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet 5\.5/ }));
    expect(fast().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Codex on devbox" }));
    fireEvent.click(screen.getByRole("option", { name: /GPT-6\.1-Sol/ }));
    fireEvent.click(fast());
    expect(screen.getAllByLabelText("Fast").length).toBeGreaterThan(0);
    expect(screen.queryByText("Billed to usage credits")).toBeNull();
  });

  it("keeps the permission mode beside the model, outside the picker", () => {
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    const dialog = screen.getByRole("dialog", { name: "Choose a model" });
    expect(within(dialog).queryByRole("button", { name: /Permission mode/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Permission mode: Supervised" }));
    // Each mode says what it allows.
    const full = screen.getByRole("menuitem", { name: /Full access/ });
    expect(full.textContent).toContain("without a sandbox");
    fireEvent.click(full);
    expect(screen.getByRole("button", { name: "Permission mode: Full access" })).toBeTruthy();
  });

  it("stars a model and lists it under favorites with a shortcut", () => {
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Star Claude Sonnet 5.5" }));
    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("Claude Sonnet 5.5"),
    ]);
    expect(screen.getByText("⌘1")).toBeTruthy();
  });

  it("says how to get a model when no machine can chat", async () => {
    await wrapRouted(<Harness empty />);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    expect(screen.getByText("No model to chat with yet")).toBeTruthy();
  });
});

describe("two-factor setup", () => {
  it("goes straight to the QR code after a recent sign-in and turns on with the code", async () => {
    const done = vi.fn();
    wrap(<TwoFactorDialog action="enable" email="a@b.c" onClose={() => {}} onDone={done} />);
    expect(
      await screen.findByRole("img", { name: "QR code for your authenticator app" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("123456"), { target: { value: "123 456" } });
    expect(await screen.findByText("aaaaa-bbbbb")).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/auth/two-factor/verify-totp")?.body).toMatchObject({
      code: "123456",
    });
    fireEvent.click(screen.getByRole("button", { name: "I've saved them" }));
    expect(done).toHaveBeenCalled();
  });

  it("asks for a password or passkey when the sign-in isn't recent", async () => {
    enableFresh = () => Response.json({ code: "REAUTH_REQUIRED" }, { status: 403 });
    wrap(<TwoFactorDialog action="enable" email="a@b.c" onClose={() => {}} onDone={() => {}} />);
    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use a passkey instead" })).toBeTruthy();
  });
});
