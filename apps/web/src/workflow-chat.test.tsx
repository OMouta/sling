// @vitest-environment happy-dom
import type {
  ConversationSummaryView,
  MessageView,
  PersonalityView,
  ServerEvent,
  SetupChangeView,
  ToolStep,
} from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";

vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signOut: async () => {},
  },
}));

const T = "2026-11-07T10:00:00.000Z";

function personality(over: Partial<PersonalityView>): PersonalityView {
  return {
    id: "per_sling",
    name: "Sling",
    description: "",
    instructions: "",
    tools: ["commands", "coding", "apps", "deploys", "setup", "memory"],
    color: "violet",
    shape: "orbit",
    isDefault: true,
    position: 0,
    revision: 1,
    templateKey: null,
    assistant: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function chat(over: Partial<ConversationSummaryView>): ConversationSummaryView {
  return {
    id: "cnv_1",
    title: "Weekly calendar",
    mode: "auto",
    settings: { assistant: null, agent: null },
    personalityId: null,
    startedBy: null,
    archived: false,
    createdAt: T,
    updatedAt: T,
    preview: "Done.",
    previewRole: "assistant",
    lastMessageAt: T,
    taskCount: 0,
    activeTasks: 0,
    waiting: false,
    agentStatus: "idle",
    source: "app",
    ...over,
  };
}

const create: SetupChangeView = {
  title: "Create workflow Weekly calendar?",
  doing: "Creating Weekly calendar",
  done: "Created Weekly calendar",
  rows: [
    { label: "Name", after: "Weekly calendar" },
    { label: "Discord", after: "Sling bot" },
    { label: "On", after: "On" },
  ],
  secrets: [],
  workflow: {
    steps: [
      { nodeId: "monday", text: "Every Monday at 09:00", sends: false },
      { nodeId: "week", text: "Read the next 7 days of the calendar", sends: false },
      { nodeId: "post", text: "Send to Discord #general", sends: true },
    ],
    workflowId: null,
  },
};

function step(over: Partial<ToolStep>, change: SetupChangeView, state: "pending" | "approved") {
  return {
    kind: "tool" as const,
    id: "t1",
    name: "create_workflow",
    input: {},
    status: "running" as const,
    output: null,
    approval: {
      id: "cap_1",
      kind: "change" as const,
      state,
      machine: "",
      summary: change.title,
      change,
    },
    ...over,
  };
}

let messages: MessageView[] = [];
let agentStatus = "idle";
let conversations: ConversationSummaryView[] = [];
let personalities: PersonalityView[] = [];
let posts: { path: string; body: unknown }[] = [];

function route(path: string): unknown {
  switch (path) {
    case "/api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "/api/conversations/cnv_1":
      return {
        conversation: {
          id: "cnv_1",
          title: "Weekly calendar",
          mode: "auto",
          settings: { assistant: null, agent: null },
          personalityId: null,
          startedBy: null,
          archived: false,
          createdAt: T,
          updatedAt: T,
        },
        messages,
        tasks: [],
        agentStatus,
        live: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    case "/api/conversations":
      return { items: conversations, nextCursor: null, counts: { waiting: 0, working: 0 } };
    case "/api/personalities":
      return personalities;
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
  messages = [];
  agentStatus = "idle";
  conversations = [];
  personalities = [personality({})];
  posts = [];
  socket = null;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      if (init?.method === "POST") {
        posts.push({ path: url.pathname, body: JSON.parse(String(init.body ?? "null")) });
        return Response.json({ ok: true });
      }
      return Response.json(route(url.pathname));
    }),
  );
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function open(path = "/c/cnv_1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
  return router;
}

const reply = (steps: ToolStep[]): MessageView => ({
  id: "msg_2",
  conversationId: "cnv_1",
  role: "assistant",
  text: "Done.",
  taskIds: [],
  attachments: [],
  personalityId: null,
  research: false,
  feedback: null,
  replaceable: false,
  createdAt: T,
  trace: { ms: 1000, steps },
});

describe("the workflow card", () => {
  it("lists the steps in order, marks the one that sends, and applies", async () => {
    agentStatus = "thinking";
    open();
    await screen.findAllByText("Thinking");
    emit({ type: "agent.tool", conversationId: "cnv_1", step: step({}, create, "pending") });
    const list = screen.getByRole("list", { name: "Workflow steps" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "1Every Monday at 09:00",
      "2Read the next 7 days of the calendar",
      "3Send to Discord #generalSends",
    ]);
    // The steps lead, then what it's called and the accounts it uses.
    expect(screen.getByText("Sling bot")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open in editor" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: "/api/conversations/cnv_1/commands/cap_1",
        body: { decision: "approve" },
      }),
    );
  });

  it("keeps an applied workflow to one line that opens the editor, with its steps on a click", async () => {
    messages = [
      reply([
        step(
          { status: "done", output: '{"applied":true,"workflow":{"id":"wfl_1"}}' },
          { ...create, workflow: { steps: create.workflow?.steps ?? [], workflowId: "wfl_1" } },
          "approved",
        ),
      ]),
    ];
    open();
    const line = await screen.findByRole("button", { name: "Created Weekly calendar" });
    expect(screen.getByRole("link", { name: "Open in editor" }).getAttribute("href")).toBe(
      "/workflows/wfl_1",
    );
    expect(screen.queryByRole("list", { name: "Workflow steps" })).toBeNull();
    fireEvent.click(line);
    expect(screen.getByRole("list", { name: "Workflow steps" })).toBeTruthy();
  });

  it("puts what changes first on a change, and says when a graph was refused", async () => {
    messages = [
      reply([
        {
          kind: "tool",
          id: "t0",
          name: "create_workflow",
          input: {},
          status: "done",
          output:
            '{"error":"The workflow isn\'t valid.","issues":["post has no data input called text"]}',
        },
        step(
          { id: "t2", name: "change_workflow" },
          {
            ...create,
            title: "Change workflow Weekly calendar?",
            rows: [
              { label: "Step", before: "Every Monday at 09:00", after: "Every Tuesday at 09:00" },
            ],
          },
          "pending",
        ),
      ]),
    ];
    agentStatus = "thinking";
    open();
    expect(await screen.findByText("Couldn't create the workflow")).toBeTruthy();
    const card = screen
      .getByText("Change workflow Weekly calendar?")
      .closest("div.overflow-hidden");
    const text = card?.textContent ?? "";
    expect(text.indexOf("Every Tuesday at 09:00")).toBeLessThan(
      text.indexOf("Read the next 7 days"),
    );
  });
});

describe("Make this a workflow", () => {
  it("sends the request as your message, from the chat's menu", async () => {
    conversations = [chat({})];
    open("/chats");
    const main = within(await screen.findByRole("main"));
    fireEvent.click(await main.findByRole("button", { name: "Actions for Weekly calendar" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Make this a workflow" }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: "/api/conversations/cnv_1/messages",
        body: { text: "Turn what we did in this chat into a workflow" },
      }),
    );
  });

  it("isn't offered where the personality can't change the setup, or the chat is empty", async () => {
    personalities = [personality({}), personality({ id: "per_plan", tools: [], isDefault: false })];
    conversations = [
      chat({ id: "cnv_2", title: "Planning", personalityId: "per_plan" }),
      chat({ id: "cnv_3", title: "Empty", lastMessageAt: null }),
    ];
    open("/chats");
    const main = within(await screen.findByRole("main"));
    for (const title of ["Planning", "Empty"]) {
      fireEvent.click(await main.findByRole("button", { name: `Actions for ${title}` }));
      expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: "Make this a workflow" })).toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
    }
  });
});
