// @vitest-environment happy-dom
import type { ConnectorView, RunnerView, SetupResultView } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";
import { devbox } from "./test/fixtures.ts";

vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signOut: async () => {},
  },
}));

const mac: RunnerView = {
  ...devbox,
  id: "rnr_mac",
  name: "Studio Mac",
  channels: [
    { kind: "imessage", name: "imessage", allowedSenders: 1, ready: true, missing: "" },
    { kind: "signal", name: "work", allowedSenders: 0, ready: true, missing: "" },
    {
      kind: "signal",
      name: "signal",
      allowedSenders: 2,
      ready: false,
      missing: "signal-cli isn't linked to this account. Run `signal-cli link -n Sling`.",
    },
  ],
};

/** As the server describes it, from its zod schemas. */
const imessage: ConnectorView = {
  id: "imessage",
  name: "iMessage",
  description: "Message Sling from iMessage, through your Mac.",
  setupHelp: null,
  credentialsSchema: { type: "object", properties: {} },
  secretFields: [],
  configSchema: {
    type: "object",
    properties: {
      runnerId: {
        type: "string",
        minLength: 1,
        step: "Which Mac?",
        title: "Mac",
        picker: true,
        lookup: true,
      },
      channel: {
        type: "string",
        minLength: 1,
        step: "Which Mac?",
        title: "Channel",
        picker: true,
        advanced: true,
      },
    },
    required: ["runnerId", "channel"],
  },
  nodeTypes: ["imessage.message_received", "imessage.send_message"],
  isExecutionProvider: false,
  hasSource: false,
  hasSetup: true,
  extension: null,
};

let runners: RunnerView[] = [];
let lookup: SetupResultView = {};
let calls: { method: string; path: string; body: unknown }[] = [];

function route(method: string, path: string, body: unknown): unknown {
  const key = `${method} ${path}`;
  if (key === "GET /api/status") {
    return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
  }
  if (key === "GET /api/runners") return runners;
  if (key === "GET /api/connectors") return [imessage];
  if (key === "POST /api/connectors/imessage/setup") return lookup;
  if (key === "POST /api/installations") {
    const b = body as { name?: string; config: Record<string, unknown> };
    return {
      id: "ins_new",
      connectorId: "imessage",
      name: b.name ?? "iMessage",
      enabled: true,
      status: "idle",
      statusDetail: null,
      config: b.config,
      hasCredentials: true,
      createdAt: "2026-11-07T12:00:00.000Z",
      updatedAt: "2026-11-07T12:00:00.000Z",
    };
  }
  if (["/api/installations", "/api/conversations", "/api/personalities"].includes(path)) return [];
  return method === "GET" ? null : { ok: true };
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
  runners = [];
  lookup = {};
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

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
}

describe("channels on Machines", () => {
  it("lists each channel with what it still needs", async () => {
    runners = [mac];
    renderAt("/machines");
    const list = within(await screen.findByRole("list", { name: "Channel list for Studio Mac" }));
    const rows = list.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("iMessage");
    expect(rows[0]?.textContent).toContain("1 sender allowed");
    expect(within(rows[0] as HTMLElement).getByText("Ready")).toBeTruthy();
    // A second Signal channel goes by its name.
    expect(rows[1]?.textContent).toContain("Signalwork");
    expect(rows[1]?.textContent).toContain("sling-runner channel allow work <number>");
    expect(rows[2]?.textContent).toContain("signal-cli isn't linked");
    expect(within(rows[2] as HTMLElement).getByText("Not ready")).toBeTruthy();
  });

  it("shows no section for a machine without channels", async () => {
    runners = [devbox];
    renderAt("/machines");
    expect(await screen.findByRole("region", { name: `Repos on ${devbox.name}` })).toBeTruthy();
    expect(screen.queryByRole("region", { name: `Channels on ${devbox.name}` })).toBeNull();
  });
});

describe("iMessage setup", () => {
  it("says what to run on the Mac, and waits for it", async () => {
    lookup = {
      notes: [{ tone: "info", text: "On your Mac, run: sling-runner channel add imessage" }],
      retryAfterMs: 5_000,
    };
    renderAt("/connectors");
    fireEvent.click(await screen.findByRole("button", { name: "Add iMessage" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Add iMessage" }));
    expect(await dialog.findByText(/sling-runner channel add imessage/)).toBeTruthy();
    expect(dialog.getByText("Which Mac?")).toBeTruthy();
    await waitFor(() =>
      expect((dialog.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
  });

  it("picks the only Mac and its channel, with nothing to type", async () => {
    lookup = {
      options: {
        runnerId: [{ value: "rnr_mac", label: "Studio Mac", detail: "1 sender allowed" }],
        channel: [{ value: "imessage", label: "imessage", detail: "1 sender allowed" }],
      },
      config: { runnerId: "rnr_mac", channel: "imessage" },
      name: "iMessage on Studio Mac",
      notes: [{ field: "runnerId", tone: "ok", text: "1 sender allowed" }],
    };
    renderAt("/connectors");
    fireEvent.click(await screen.findByRole("button", { name: "Add iMessage" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Add iMessage" }));
    const picker = (await dialog.findByRole("combobox")) as HTMLSelectElement;
    expect(picker.value).toBe("rnr_mac");
    expect(picker.selectedOptions[0]?.textContent).toBe("Studio Mac · 1 sender allowed");
    expect(dialog.queryAllByRole("textbox")).toHaveLength(0);
    // Picking the Mac looks again, for its channels.
    const lookups = () => calls.filter((c) => c.path === "/api/connectors/imessage/setup").length;
    await waitFor(() => expect(lookups()).toBe(2));
    const add = dialog.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST" && c.path === "/api/installations")).toEqual([
        {
          method: "POST",
          path: "/api/installations",
          body: {
            connectorId: "imessage",
            name: "iMessage on Studio Mac",
            credentials: {},
            config: { runnerId: "rnr_mac", channel: "imessage" },
            check: true,
          },
        },
      ]),
    );
    expect(await dialog.findByText("iMessage on Studio Mac is connected")).toBeTruthy();
  });
});
