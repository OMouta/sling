// @vitest-environment happy-dom
import type { ConversationSummaryView } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";

vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signOut: async () => {},
  },
}));

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();

function chat(over: Partial<ConversationSummaryView>): ConversationSummaryView {
  return {
    id: "cnv_1",
    title: "Desktop items",
    mode: "auto",
    settings: { assistant: null, agent: null },
    personalityId: null,
    createdAt: ago(60_000),
    updatedAt: ago(60_000),
    preview: "Your Desktop has two files.",
    previewRole: "assistant",
    lastMessageAt: ago(60_000),
    taskCount: 0,
    activeTasks: 0,
    waiting: false,
    agentStatus: "idle",
    source: "app",
    ...over,
  };
}

let conversations: ConversationSummaryView[] = [];
let requests: { method: string; path: string; search: string }[] = [];

beforeEach(() => {
  requests = [];
  conversations = [
    chat({}),
    chat({
      id: "cnv_2",
      title: "Fix the footer",
      updatedAt: ago(3 * 86_400_000),
      lastMessageAt: ago(3 * 86_400_000),
      preview: "Started a task.",
      taskCount: 2,
      activeTasks: 1,
      waiting: true,
    }),
  ];
  class FakeSocket {
    readyState = 0;
    onopen = null;
    onclose = null;
    onmessage = null;
    send() {}
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      requests.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search });
      if (url.pathname.startsWith("/api/auth/")) return new Response("null");
      if (url.pathname === "/api/status") {
        return Response.json({ needsSetup: false, signedIn: true, email: "a@b.c", version: "1" });
      }
      if (url.pathname === "/api/conversations") {
        const q = url.searchParams.get("q")?.toLowerCase();
        return Response.json(
          q ? conversations.filter((c) => c.preview?.toLowerCase().includes(q)) : conversations,
        );
      }
      if (["/api/approvals", "/api/runners", "/api/tasks"].includes(url.pathname)) {
        return Response.json([]);
      }
      return Response.json(null);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
  return router;
}

describe("chats", () => {
  it("opens the composer for a new chat, without making an empty conversation", async () => {
    const router = open("/tasks");
    const [button] = await screen.findAllByRole("button", { name: "New chat" });
    fireEvent.click(button as HTMLElement);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(requests.some((r) => r.method === "POST" && r.path === "/api/conversations")).toBe(
      false,
    );
  });

  it("groups the sidebar's chats by day and marks what waits for you", async () => {
    open("/tasks");
    await screen.findByText("Desktop items");
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Previous 7 days")).toBeTruthy();
    const footer = screen.getByText("Fix the footer").closest("a") as HTMLElement;
    expect(within(footer).getByTitle("Waiting for you")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Filter chats" }));
    fireEvent.change(screen.getByLabelText("Filter chats by name"), {
      target: { value: "foot" },
    });
    expect(screen.queryByText("Desktop items")).toBeNull();
    expect(screen.getByText("Fix the footer")).toBeTruthy();
  });

  it("filters the Chats page and searches what was said", async () => {
    open("/chats");
    const main = within(await screen.findByRole("main"));
    expect(await main.findByText("Your Desktop has two files.")).toBeTruthy();
    expect(main.getByText("1 of 2 tasks running")).toBeTruthy();
    fireEvent.click(main.getByRole("tab", { name: /Waiting for you/ }));
    expect(main.queryByText("Desktop items")).toBeNull();
    expect(main.getByText("Fix the footer")).toBeTruthy();
    fireEvent.click(main.getByRole("tab", { name: "All chats" }));
    fireEvent.change(main.getByLabelText("Search chats"), { target: { value: "two files" } });
    await waitFor(() => expect(main.queryByText("Fix the footer")).toBeNull());
    expect(requests.some((r) => r.search === "?q=two%20files")).toBe(true);
  });
});
