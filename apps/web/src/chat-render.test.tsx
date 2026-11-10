// @vitest-environment happy-dom
import type { MessageView, PersonalityView, ServerEvent } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";

/** How many times a Markdown text was parsed. */
const parsed = vi.hoisted(() => ({ count: 0 }));
vi.mock("react-markdown", async (original) => {
  const m = (await original()) as { default: (props: unknown) => unknown };
  return {
    ...m,
    default: (props: unknown) => {
      parsed.count++;
      return m.default(props);
    },
  };
});

vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signOut: async () => {},
  },
}));

const personality: PersonalityView = {
  id: "prs_1",
  name: "Chef",
  description: "",
  instructions: "You are Chef.",
  tools: [],
  color: "amber",
  shape: "bloom",
  isDefault: true,
  position: 0,
  revision: 1,
  templateKey: null,
  assistant: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
};

const messages: MessageView[] = Array.from({ length: 10 }, (_, i) => ({
  id: `msg_${i}`,
  conversationId: "cnv_1",
  role: i % 2 ? "assistant" : "user",
  text: i % 2 ? `Reply **${i}** with \`code\`.` : `Question ${i}`,
  taskIds: [],
  createdAt: new Date(Date.parse("2026-11-07T10:00:00.000Z") + i * 1000).toISOString(),
  trace: i % 2 ? { steps: [], ms: 1, followUps: [] } : null,
  attachments: [],
  personalityId: null,
  research: false,
  feedback: null,
  replaceable: false,
}));

let agentStatus = "idle";
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

function route(path: string): unknown {
  switch (path) {
    case "/api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "/api/conversations/cnv_1":
      return {
        conversation: {
          id: "cnv_1",
          title: "Dinner",
          mode: "auto",
          settings: { assistant: null, agent: null },
          createdAt: "2026-11-07T10:00:00.000Z",
          updatedAt: "2026-11-07T10:00:00.000Z",
        },
        personality,
        messages,
        tasks: [],
        agentStatus,
        live: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    case "/api/personalities":
      return [personality];
    case "/api/conversations":
    case "/api/approvals":
    case "/api/runners":
      return [];
    default:
      return null;
  }
}

beforeEach(() => {
  agentStatus = "idle";
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
  sessionStorage.clear();
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

describe("a long chat", () => {
  it("doesn't parse the loaded replies again as you type", async () => {
    open();
    const box = await screen.findByRole("textbox", { name: "Message" });
    await screen.findByText("9", { selector: "strong" });
    parsed.count = 0;
    for (const value of ["H", "He", "Hel", "Hell", "Hello"]) {
      fireEvent.change(box, { target: { value } });
    }
    expect(parsed.count).toBe(0);
  });

  it("parses only the streaming reply as its text comes in", async () => {
    agentStatus = "thinking";
    open();
    await screen.findByText("9", { selector: "strong" });
    emit({ type: "agent.delta", conversationId: "cnv_1", text: "Start" });
    await screen.findByText("Start");
    parsed.count = 0;
    for (let i = 0; i < 5; i++) {
      emit({ type: "agent.delta", conversationId: "cnv_1", text: ` word${i}` });
    }
    expect(parsed.count).toBe(5);
  });
});
