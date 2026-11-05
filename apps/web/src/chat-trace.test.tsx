// @vitest-environment happy-dom
import type { MessageView, ServerEvent } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";

vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signOut: async () => {},
  },
}));

const reply: MessageView = {
  id: "msg_2",
  conversationId: "cnv_1",
  role: "assistant",
  text: "Your Mac has 2 repos:\n\n| Repo | Branch |\n|---|---|\n| site | main |\n| api | trunk |",
  taskIds: [],
  createdAt: "2026-11-05T10:01:00.000Z",
  trace: {
    ms: 3200,
    steps: [
      { kind: "thinking", text: "The user wants their **repos**." },
      {
        kind: "tool",
        id: "t1",
        name: "list_machines",
        input: {},
        status: "done",
        output: '[{"name":"devbox","repos":["site","api"]}]',
      },
    ],
  },
};

let agentStatus = "idle";
let messages: MessageView[] = [];

function route(path: string): unknown {
  switch (path) {
    case "/api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "/api/conversations/cnv_1":
      return {
        conversation: {
          id: "cnv_1",
          title: "Repos",
          mode: "auto",
          settings: { assistant: null, agent: null },
          createdAt: "2026-11-05T10:00:00.000Z",
          updatedAt: "2026-11-05T10:01:00.000Z",
        },
        messages,
        tasks: [],
        agentStatus,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    case "/api/conversations":
    case "/api/approvals":
    case "/api/runners":
      return [];
    default:
      return null;
  }
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
function emit(ev: ServerEvent) {
  act(() => socket?.onmessage?.({ data: JSON.stringify(ev) }));
}

beforeEach(() => {
  agentStatus = "idle";
  messages = [];
  socket = null;
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

function open() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/c/cnv_1"] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
}

describe("chat replies", () => {
  it("renders Markdown tables", async () => {
    messages = [reply];
    open();
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Repo", "Branch"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });

  it("folds a reply's thinking and tool calls into one line that opens", async () => {
    messages = [reply];
    open();
    const toggle = await screen.findByRole("button", {
      name: "Thought for 3s · Listed machines",
    });
    expect(screen.queryByText(/The user wants their/)).toBeNull();
    fireEvent.click(toggle);
    const steps = within(screen.getByRole("list", { name: "Steps" }));
    expect(steps.getByText("repos").tagName).toBe("STRONG");
    fireEvent.click(steps.getByRole("button", { name: "Listed machines" }));
    expect(steps.getByText(/"name": "devbox"/)).toBeTruthy();
  });

  it("shows thinking and tool calls live while the reply comes in", async () => {
    agentStatus = "thinking";
    open();
    // The header says so too.
    expect((await screen.findAllByText("Thinking")).length).toBe(2);
    emit({ type: "agent.thinking", conversationId: "cnv_1", text: "Checking the " });
    emit({ type: "agent.thinking", conversationId: "cnv_1", text: "machines." });
    expect(screen.getByText("Checking the machines.")).toBeTruthy();
    emit({
      type: "agent.tool",
      conversationId: "cnv_1",
      step: {
        kind: "tool",
        id: "t1",
        name: "list_machines",
        input: {},
        status: "running",
        output: null,
      },
    });
    expect(screen.getAllByText("Listing machines").length).toBeGreaterThan(0);
    emit({
      type: "agent.tool",
      conversationId: "cnv_1",
      step: {
        kind: "tool",
        id: "t1",
        name: "list_machines",
        input: {},
        status: "done",
        output: "[]",
      },
    });
    expect(screen.getByText("Listed machines")).toBeTruthy();
    emit({ type: "agent.delta", conversationId: "cnv_1", text: "You have **one**." });
    expect(screen.getByText("one").tagName).toBe("STRONG");
  });
});
