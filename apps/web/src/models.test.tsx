// @vitest-environment happy-dom
import type { AgentChoice, AssistantChoice, ModelCatalogView } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatControls } from "./components/ModelPicker.tsx";
import { TwoFactorDialog } from "./components/TwoFactorDialog.tsx";

const catalog: ModelCatalogView = {
  assistant: [
    { provider: "openai", label: "OpenAI", connected: false, error: null, models: [] },
    {
      provider: "anthropic",
      label: "Anthropic",
      connected: true,
      error: null,
      models: [
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
      ],
    },
    {
      provider: "openai-compatible",
      label: "OpenAI-compatible",
      connected: false,
      error: null,
      models: [],
    },
  ],
  agents: [
    {
      harness: "codex",
      label: "Codex",
      readyMachines: 1,
      defaultModel: "gpt-6.1-sol",
      models: [
        {
          id: "gpt-6.1-sol",
          label: "GPT-6.1-Sol",
          description: "Latest workhorse",
          efforts: ["low", "medium", "high"],
          defaultEffort: "low",
          fast: true,
        },
      ],
    },
    {
      harness: "claude-code",
      label: "Claude Code",
      readyMachines: 0,
      defaultModel: null,
      models: [],
    },
  ],
  defaults: {
    assistant: { provider: "anthropic", model: "claude-opus-5-5", effort: null, fast: false },
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
  await screen.findByRole("button", { name: /Assistant model/ });
}

function Harness({ onMode }: { onMode?: (m: string) => void }) {
  const [assistant, setAssistant] = useState<AssistantChoice | null>(catalog.defaults.assistant);
  const [agent, setAgent] = useState<AgentChoice>(catalog.defaults.agent);
  return (
    <ChatControls
      catalog={catalog}
      assistant={assistant}
      agent={agent}
      onAssistant={setAssistant}
      onAgent={setAgent}
      mode="supervised"
      onMode={(m) => onMode?.(m)}
    />
  );
}

describe("model picker", () => {
  it("shows the assistant model and the coding agent in the composer", () => {
    wrap(<Harness />);
    expect(screen.getByRole("button", { name: "Assistant model: Opus 5.5" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Coding agent: Codex, Default" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Permission mode: Supervised" })).toBeTruthy();
  });

  it("picks a model and a reasoning level without typing", () => {
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Assistant model: Opus 5.5" }));
    const dialog = screen.getByRole("dialog", { name: "Choose models" });
    const reasoning = within(dialog).getByRole("radiogroup", { name: "Reasoning" });
    // The model's default level is marked.
    expect(
      within(reasoning)
        .getByRole("radio", { name: /Medium/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(within(reasoning).getByRole("radio", { name: /Extra High/ }));
    expect(
      screen.getByRole("button", { name: "Assistant model: Opus 5.5, Extra High" }),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("option", { name: /Claude Sonnet 5\.5/ }));
    // Sonnet takes Extra High too, so the level carries over.
    expect(
      screen.getByRole("button", { name: "Assistant model: Sonnet 5.5, Extra High" }),
    ).toBeTruthy();
  });

  it("offers Fast only where the model has it", () => {
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Assistant model: Opus 5.5" }));
    const speed = screen.getByRole("radiogroup", { name: "Speed" });
    fireEvent.click(within(speed).getByRole("radio", { name: /Fast/ }));
    expect(screen.getAllByLabelText("Fast").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet 5\.5/ }));
    expect(
      (
        within(screen.getByRole("radiogroup", { name: "Speed" })).getByRole("radio", {
          name: /Fast/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("picks the coding agent's model from what the machines report", () => {
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Coding agent: Codex, Default" }));
    fireEvent.click(screen.getByRole("option", { name: /GPT-6\.1-Sol/ }));
    expect(screen.getByRole("button", { name: "Coding agent: Codex, GPT-6.1-Sol" })).toBeTruthy();
    // An agent with no ready machine says so.
    fireEvent.click(screen.getByRole("button", { name: "Claude Code (no machine ready)" }));
    expect(screen.getByText(/No machine has Claude Code ready/)).toBeTruthy();
  });

  it("connects a provider right in the picker", async () => {
    await wrapRouted(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Assistant model: Opus 5.5" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenAI (not connected)" }));
    fireEvent.change(screen.getByLabelText("API key for OpenAI"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/settings/providers/openai")?.body).toEqual({
        apiKey: "sk-test",
      }),
    );
  });

  it("stars a model and lists it under favorites", () => {
    wrap(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Assistant model: Opus 5.5" }));
    fireEvent.click(screen.getByRole("button", { name: "Star Claude Sonnet 5.5" }));
    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Claude Sonnet 5.5"),
    ]);
    expect(screen.getByText("⌘1")).toBeTruthy();
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
