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
    startedBy: null,
    archived: false,
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
/** What the archive endpoint answers, to try a failure. */
let archiveStatus = 200;

const MATCH: Record<string, (c: ConversationSummaryView) => boolean> = {
  all: (c) => !c.archived,
  waiting: (c) => !c.archived && c.waiting,
  working: (c) => !c.archived && (c.agentStatus === "thinking" || c.activeTasks > 0),
  tasks: (c) => !c.archived && c.taskCount > 0,
  archived: (c) => c.archived,
};

let listStatus = 200;

beforeEach(() => {
  requests = [];
  archiveStatus = 200;
  listStatus = 200;
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
        if (listStatus !== 200) {
          return Response.json({ error: "The server is busy." }, { status: listStatus });
        }
        const q = url.searchParams.get("q")?.toLowerCase();
        const matched = q
          ? conversations.filter((c) => c.preview?.toLowerCase().includes(q))
          : conversations;
        const filter = MATCH[url.searchParams.get("filter") ?? "all"] ?? MATCH.all;
        return Response.json({
          items: matched.filter(filter as (c: ConversationSummaryView) => boolean),
          nextCursor: null,
          counts: {
            waiting: matched.filter(MATCH.waiting as never).length,
            working: matched.filter(MATCH.working as never).length,
          },
        });
      }
      const archive = /^\/api\/conversations\/(\w+)\/(archive|restore)$/.exec(url.pathname);
      if (archive && init?.method === "POST") {
        if (archiveStatus !== 200) {
          return Response.json({ error: "The server is busy." }, { status: archiveStatus });
        }
        const c = conversations.find((x) => x.id === archive[1]);
        if (c) c.archived = archive[2] === "archive";
        return Response.json(c);
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
  sessionStorage.clear();
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

  it("keeps chats off the sidebar, which links to the Chats page with how many wait for you", async () => {
    open("/tasks");
    const sidebar = within(await screen.findByRole("navigation"));
    const link = sidebar.getByRole("link", { name: /^Chats/ });
    expect(link.getAttribute("href")).toBe("/chats");
    await waitFor(() => expect(link.textContent).toBe("Chats1"));
    expect(screen.queryByText("Desktop items")).toBeNull();
  });

  it("groups the Chats page by day and marks what waits for you", async () => {
    open("/chats");
    const main = within(await screen.findByRole("main"));
    expect(await main.findByRole("region", { name: "Today" })).toBeTruthy();
    const week = within(main.getByRole("region", { name: "Previous 7 days" }));
    expect(week.getByText("Fix the footer")).toBeTruthy();
    // Once, as a badge, not also as a dot.
    expect(week.getAllByText("Waiting for you")).toHaveLength(1);
    expect(week.queryByTitle("Waiting for you")).toBeNull();
  });

  it("filters the Chats page and searches what was said", async () => {
    open("/chats");
    const main = within(await screen.findByRole("main"));
    expect(await main.findByText("Your Desktop has two files.")).toBeTruthy();
    expect(main.getByText("1 of 2 tasks running")).toBeTruthy();
    fireEvent.click(main.getByRole("tab", { name: /Waiting for you/ }));
    expect(await main.findByText("Fix the footer")).toBeTruthy();
    expect(main.queryByText("Desktop items")).toBeNull();
    expect(requests.some((r) => r.search === "?filter=waiting")).toBe(true);
    fireEvent.click(main.getByRole("tab", { name: "All chats" }));
    expect(await main.findByText("Desktop items")).toBeTruthy();
    fireEvent.change(main.getByLabelText("Search chats"), { target: { value: "two files" } });
    await waitFor(() => expect(main.queryByText("Fix the footer")).toBeNull());
    expect(requests.some((r) => r.search === "?filter=all&q=two+files")).toBe(true);
  });

  it("keeps the Chats tab and search in the URL, so Back returns to them", async () => {
    const router = open("/chats");
    const main = within(await screen.findByRole("main"));
    fireEvent.click(await main.findByRole("tab", { name: /Waiting for you/ }));
    fireEvent.change(main.getByLabelText("Search chats"), { target: { value: "footer" } });
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ filter: "waiting", q: "footer" }),
    );
    await router.navigate({ to: "/c/$id", params: { id: "cnv_2" } });
    router.history.back();
    const back = within(await screen.findByRole("main"));
    await waitFor(() =>
      expect(back.getByRole("tab", { name: /Waiting for you/ }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    expect((back.getByLabelText("Search chats") as HTMLInputElement).value).toBe("footer");
  });

  it("finds any chat from the search palette, which holds focus until it closes", async () => {
    const router = open("/chats");
    const main = within(await screen.findByRole("main"));
    await main.findByText("Desktop items");
    const button = screen.getAllByRole("button", { name: "Search" })[0] as HTMLElement;
    button.focus();
    fireEvent.click(button);
    const palette = within(await screen.findByRole("dialog", { name: "Search" }));
    const input = palette.getByRole("textbox", { name: "Search" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    // The page behind can't be reached.
    expect(main.getByRole("tab", { name: "All chats" }).closest("[inert]")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    const again = within(await screen.findByRole("dialog", { name: "Search" }));
    fireEvent.change(again.getByRole("textbox", { name: "Search" }), {
      target: { value: "an old chat" },
    });
    fireEvent.click(again.getByRole("option", { name: "Search chats for “an old chat”" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ q: "an old chat" }));
  });

  it("says the list didn't load, rather than that there are no chats, and tries again", async () => {
    listStatus = 500;
    open("/chats");
    const main = within(await screen.findByRole("main"));
    expect(await main.findByText("Couldn't load chats")).toBeTruthy();
    expect(main.queryByText("No chats yet")).toBeNull();
    listStatus = 200;
    fireEvent.click(main.getByRole("button", { name: "Try again" }));
    expect(await main.findByText("Fix the footer")).toBeTruthy();
    expect(main.queryByText("Couldn't load chats")).toBeNull();
  });

  it("archives a chat into the Archived tab, and restores it from there", async () => {
    open("/chats");
    const main = within(await screen.findByRole("main"));
    fireEvent.click(await main.findByRole("button", { name: "Actions for Desktop items" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(main.queryByText("Desktop items")).toBeNull());
    expect(
      requests.some((r) => r.method === "POST" && r.path === "/api/conversations/cnv_1/archive"),
    ).toBe(true);

    fireEvent.click(main.getByRole("tab", { name: "Archived" }));
    fireEvent.click(await main.findByRole("button", { name: "Actions for Desktop items" }));
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(main.queryByText("Desktop items")).toBeNull());
    fireEvent.click(main.getByRole("tab", { name: "All chats" }));
    expect(await main.findByText("Desktop items")).toBeTruthy();
  });

  it("says why archiving failed, keeps the chat, and tries again", async () => {
    archiveStatus = 500;
    open("/chats");
    const main = within(await screen.findByRole("main"));
    fireEvent.click(await main.findByRole("button", { name: "Actions for Desktop items" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText('Couldn\'t archive "Desktop items"')).toBeTruthy();
    expect(dialog.getByText("The server is busy.")).toBeTruthy();
    expect(main.getByText("Desktop items")).toBeTruthy();

    archiveStatus = 200;
    fireEvent.click(dialog.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(main.queryByText("Desktop items")).toBeNull());
  });
});
