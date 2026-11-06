// @vitest-environment happy-dom
import type { LiveReplyView, MessageView, ServerEvent, TaskView } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";
import { machineTask } from "./test/fixtures.ts";

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
let tasks: TaskView[] = [];
let live: LiveReplyView | null = null;
let posts: { path: string; body: unknown }[] = [];

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
        tasks,
        agentStatus,
        live,
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
  tasks = [];
  live = null;
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

  it("keeps a reply's work in the history, in order, above the answer", async () => {
    messages = [reply];
    open();
    const steps = within(await screen.findByRole("list", { name: "Steps" }));
    // Thinking is one line with a preview, and opens on a click.
    const thought = steps.getByRole("button", { name: "Thought" });
    expect(thought.getAttribute("aria-expanded")).toBe("false");
    expect(thought.textContent).toContain("The user wants their repos.");
    fireEvent.click(thought);
    expect(steps.getByText("repos").tagName).toBe("STRONG");
    fireEvent.click(steps.getByRole("button", { name: "Looked at your machines" }));
    expect(steps.getByText(/"name": "devbox"/)).toBeTruthy();
  });

  it("shows the work live, in order, and keeps it once the answer starts", async () => {
    agentStatus = "thinking";
    open();
    // The header says so too.
    expect((await screen.findAllByText("Thinking")).length).toBe(2);
    emit({ type: "agent.thinking", conversationId: "cnv_1", text: "Checking the " });
    emit({ type: "agent.thinking", conversationId: "cnv_1", text: "machines." });
    // Thinking shows as it comes in.
    expect(screen.getByText("Checking the machines.")).toBeTruthy();
    // Said before a tool call: part of the work, inline with it.
    emit({ type: "agent.delta", conversationId: "cnv_1", text: "I'll look." });
    const tool = (status: "running" | "done") =>
      emit({
        type: "agent.tool",
        conversationId: "cnv_1",
        step: { kind: "tool", id: "t1", name: "list_machines", input: {}, status, output: "[]" },
      });
    tool("running");
    const steps = () =>
      within(screen.getByRole("list", { name: "Steps" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent);
    expect(steps()).toEqual([
      "ThoughtChecking the machines.",
      "I'll look.",
      "Looking at your machines",
    ]);
    tool("done");
    expect(steps().at(-1)).toBe("Looked at your machines");

    emit({ type: "agent.delta", conversationId: "cnv_1", text: "You have **one**." });
    expect(screen.getByText("one").tagName).toBe("STRONG");
    expect(steps()).toEqual([
      "ThoughtChecking the machines.",
      "I'll look.",
      "Looked at your machines",
    ]);
  });

  it("shows a command with where it ran, and its output on a click", async () => {
    messages = [
      {
        ...reply,
        text: "Your Desktop has two files.",
        trace: {
          ms: 900,
          steps: [
            {
              kind: "tool",
              id: "t1",
              name: "run_command",
              input: { command: "ls ~/Desktop" },
              status: "done",
              output: JSON.stringify({
                machine: "devbox",
                sandboxed: true,
                exitCode: 0,
                durationMs: 42,
                output: "notes.txt\nplan.md\n",
              }),
            },
          ],
        },
      },
    ];
    open();
    const command = await screen.findByRole("button", { name: "$ ls ~/Desktop" });
    expect(command.textContent).toContain("devbox");
    expect(within(command).getByLabelText("Sandboxed")).toBeTruthy();
    expect(screen.queryByText(/plan\.md/)).toBeNull();
    fireEvent.click(command);
    expect(screen.getByText(/plan\.md/)).toBeTruthy();
  });

  it("asks right in the chat before a command leaves the sandbox", async () => {
    agentStatus = "thinking";
    open();
    await screen.findAllByText("Thinking");
    emit({
      type: "agent.tool",
      conversationId: "cnv_1",
      step: {
        kind: "tool",
        id: "t1",
        name: "run_command",
        input: { command: "rm ~/Desktop/old.txt", outsideSandbox: true },
        status: "running",
        output: null,
        approval: { id: "cap_1", state: "pending", machine: "devbox" },
      },
    });
    expect(screen.getByText(/outside the sandbox\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: "/api/conversations/cnv_1/commands/cap_1",
        body: { decision: "approve" },
      }),
    );
  });

  it("shows a task inside the reply that started it, once", async () => {
    tasks = [{ ...machineTask, conversationId: "cnv_1", title: "List Desktop items" }];
    messages = [
      {
        ...reply,
        text: "I started it.",
        trace: {
          ms: 900,
          steps: [
            {
              kind: "tool",
              id: "t1",
              name: "delegate_coding_task",
              input: { title: "List Desktop items" },
              status: "done",
              output: JSON.stringify({ taskId: machineTask.id }),
            },
          ],
        },
      },
    ];
    open();
    const steps = within(await screen.findByRole("list", { name: "Steps" }));
    expect(steps.getByText("List Desktop items")).toBeTruthy();
    expect(screen.getAllByText("List Desktop items")).toHaveLength(1);
    // The chat already shows the mode, and the machine says why it was picked.
    expect(steps.queryByText("Auto")).toBeNull();
    expect(steps.queryByText("Why here?")).toBeNull();
    expect(steps.getByText("on devbox").getAttribute("title")).toContain("most free slots");
  });

  it("shows a reply already being written when the chat opens", async () => {
    agentStatus = "thinking";
    live = {
      text: "",
      startedAt: Date.now(),
      steps: [
        {
          kind: "tool",
          id: "t1",
          name: "run_command",
          input: { command: "touch x" },
          status: "running",
          output: null,
          approval: { id: "cap_9", state: "pending", machine: "devbox" },
        },
      ],
    };
    open();
    expect(await screen.findByRole("button", { name: "Run it" })).toBeTruthy();
  });

  it("marks a finished task in the history as it was then", async () => {
    tasks = [{ ...machineTask, conversationId: "cnv_1", title: "List Desktop items" }];
    messages = [
      {
        id: "msg_9",
        conversationId: "cnv_1",
        role: "system",
        text: `Task "List Desktop items" (${machineTask.id}) on devbox, repo site: succeeded.`,
        taskIds: [machineTask.id],
        createdAt: "2026-11-05T10:05:00.000Z",
        trace: null,
      },
    ];
    open();
    const note = (await screen.findByText("finished")).parentElement as HTMLElement;
    expect(note.textContent).toBe("List Desktop itemsfinished");
  });
});
