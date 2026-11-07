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
        approval: {
          id: "cap_1",
          kind: "command",
          state: "pending",
          machine: "devbox",
          summary: "",
        },
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

  it("asks before the assistant sends something, showing what would go out", async () => {
    agentStatus = "thinking";
    open();
    await screen.findAllByText("Thinking");
    // A new turn starts with nothing streamed, whatever an earlier test left.
    emit({ type: "agent.status", conversationId: "cnv_1", status: "thinking" });
    emit({
      type: "agent.tool",
      conversationId: "cnv_1",
      step: {
        kind: "tool",
        id: "t2",
        name: "email_send",
        input: { to: "ana@example.com", subject: "Lunch moved", text: "See you at 13:30 instead." },
        status: "running",
        output: null,
        approval: {
          id: "sap_1",
          kind: "send",
          state: "pending",
          machine: "",
          summary: "Email ana@example.com: Lunch moved",
        },
      },
    });
    expect(screen.getByText("Email ana@example.com: Lunch moved")).toBeTruthy();
    expect(screen.getByText("Allow this?")).toBeTruthy();
    // Every value it would send shows before you allow it, the body included.
    expect(screen.getByText("See you at 13:30 instead.")).toBeTruthy();
    // Sends never talk about sandboxes or machines.
    expect(screen.queryByText(/outside the sandbox/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: "/api/conversations/cnv_1/commands/sap_1",
        body: { decision: "approve" },
      }),
    );
    emit({ type: "agent.status", conversationId: "cnv_1", status: "idle" });
  });

  it("denies a send with the same control as a command", async () => {
    agentStatus = "thinking";
    open();
    await screen.findAllByText("Thinking");
    // A new turn starts with nothing streamed, whatever an earlier test left.
    emit({ type: "agent.status", conversationId: "cnv_1", status: "thinking" });
    emit({
      type: "agent.tool",
      conversationId: "cnv_1",
      step: {
        kind: "tool",
        id: "t3",
        name: "discord_send_message",
        input: { channel: "general" },
        status: "running",
        output: null,
        approval: {
          id: "sap_2",
          kind: "send",
          state: "pending",
          machine: "",
          summary: "Discord #general: Deploy is done",
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: "/api/conversations/cnv_1/commands/sap_2",
        body: { decision: "deny" },
      }),
    );
    emit({ type: "agent.status", conversationId: "cnv_1", status: "idle" });
  });

  it("says nothing went out when a send was denied or nobody answered", async () => {
    const send = (id: string, state: "denied" | "expired" | "approved") => ({
      kind: "tool" as const,
      id,
      name: "calendar_create_event",
      input: {},
      status: "done" as const,
      output: state === "approved" ? '{"created":true}' : "Not sent.",
      approval: {
        id: `sap_${id}`,
        kind: "send" as const,
        state,
        machine: "",
        summary: `Event ${id}: Dentist, Fri 09:00`,
      },
    });
    messages = [
      {
        ...reply,
        text: "Done.",
        trace: {
          ms: 800,
          steps: [send("a", "denied"), send("b", "expired"), send("c", "approved")],
        },
      },
    ];
    open();
    expect(await screen.findByText("You didn't allow it, so nothing went out.")).toBeTruthy();
    expect(screen.getByText("Nobody answered, so nothing went out.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    const approved = screen.getByRole("button", { name: "Event c: Dentist, Fri 09:00" });
    expect(within(approved).getByText("approved")).toBeTruthy();
    fireEvent.click(approved);
    expect(screen.getByText(/"created": true/)).toBeTruthy();
  });

  it("shows a setup change with its rows, and sends the password with Apply", async () => {
    agentStatus = "thinking";
    open();
    await screen.findAllByText("Thinking");
    emit({ type: "agent.status", conversationId: "cnv_1", status: "thinking" });
    emit({
      type: "agent.tool",
      conversationId: "cnv_1",
      step: {
        kind: "tool",
        id: "t4",
        name: "save_app_account",
        input: { connector: "email", credentials: { fromAddress: "ana@fastmail.com" } },
        status: "running",
        output: null,
        approval: {
          id: "cap_9",
          kind: "change",
          state: "pending",
          machine: "",
          summary: "Connect ana@fastmail.com?",
          change: {
            title: "Connect ana@fastmail.com?",
            doing: "Connecting ana@fastmail.com",
            done: "Connected ana@fastmail.com",
            rows: [
              { label: "App", after: "Email" },
              { label: "IMAP server", after: "imap.fastmail.com" },
              { label: "Folders", before: "INBOX", after: "INBOX, Work" },
            ],
            secrets: [
              {
                key: "password",
                label: "Password",
                required: true,
                placeholder: "Fastmail needs an app password.",
                link: { label: "Make one", url: "https://app.fastmail.com/settings/security/apps" },
              },
            ],
          },
        },
      },
    });
    expect(screen.getByText("Connect ana@fastmail.com?")).toBeTruthy();
    expect(screen.getByText("imap.fastmail.com")).toBeTruthy();
    // An edit shows what it was, then what it becomes.
    expect(screen.getByText("INBOX")).toBeTruthy();
    expect(screen.getByText("INBOX, Work")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Make one" }).getAttribute("href")).toBe(
      "https://app.fastmail.com/settings/security/apps",
    );
    const password = screen.getByLabelText(/^Password/) as HTMLInputElement;
    expect(password.type).toBe("password");
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(password, { target: { value: "app-pass-1234" } });
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: "/api/conversations/cnv_1/commands/cap_9",
        body: { decision: "approve", secrets: { password: "app-pass-1234" } },
      }),
    );
    // Nothing typed stays in the page once it's sent.
    await waitFor(() => expect(password.value).toBe(""));
    emit({ type: "agent.status", conversationId: "cnv_1", status: "idle" });
  });

  it("cancels a change without sending anything typed", async () => {
    agentStatus = "thinking";
    open();
    await screen.findAllByText("Thinking");
    emit({ type: "agent.status", conversationId: "cnv_1", status: "thinking" });
    emit({
      type: "agent.tool",
      conversationId: "cnv_1",
      step: {
        kind: "tool",
        id: "t5",
        name: "save_deploy_target",
        input: {},
        status: "running",
        output: null,
        approval: {
          id: "cap_10",
          kind: "change",
          state: "pending",
          machine: "",
          summary: "Add deploy target Website?",
          change: {
            title: "Add deploy target Website?",
            doing: "Adding Website",
            done: "Added Website",
            rows: [{ label: "Deploys", after: "Deploy hook" }],
            secrets: [{ key: "hookUrl", label: "Deploy hook URL", required: true }],
          },
        },
      },
    });
    fireEvent.change(screen.getByLabelText("Deploy hook URL"), {
      target: { value: "https://hooks.example/abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: "/api/conversations/cnv_1/commands/cap_10",
        body: { decision: "deny" },
      }),
    );
    emit({ type: "agent.status", conversationId: "cnv_1", status: "idle" });
  });

  it("applies a change with nothing to type at once, and shows it applying", async () => {
    agentStatus = "thinking";
    open();
    await screen.findAllByText("Thinking");
    emit({ type: "agent.status", conversationId: "cnv_1", status: "thinking" });
    const step = (state: "pending" | "approved") => ({
      kind: "tool" as const,
      id: "t6",
      name: "change_settings",
      input: { timeZone: "Europe/Lisbon" },
      status: "running" as const,
      output: null,
      approval: {
        id: "cap_11",
        kind: "change" as const,
        state,
        machine: "",
        summary: "Change settings?",
        change: {
          title: "Change settings?",
          doing: "Changing settings",
          done: "Changed settings",
          rows: [{ label: "Time zone", before: "UTC", after: "Europe/Lisbon" }],
          secrets: [],
        },
      },
    });
    emit({ type: "agent.tool", conversationId: "cnv_1", step: step("pending") });
    expect(document.querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(posts).toContainEqual({
        path: "/api/conversations/cnv_1/commands/cap_11",
        body: { decision: "approve" },
      }),
    );
    emit({ type: "agent.tool", conversationId: "cnv_1", step: step("approved") });
    expect(screen.getByText("Changing settings")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    emit({ type: "agent.status", conversationId: "cnv_1", status: "idle" });
  });

  it("keeps a decided change to one line, with what changed on a click", async () => {
    const change = (id: string, state: "approved" | "denied" | "expired", output: string) => ({
      kind: "tool" as const,
      id,
      name: "save_deploy_target",
      input: {},
      status: "done" as const,
      output,
      approval: {
        id: `cap_${id}`,
        kind: "change" as const,
        state,
        machine: "",
        summary: `Add deploy target ${id}?`,
        change: {
          title: `Add deploy target ${id}?`,
          doing: `Adding ${id}`,
          done: `Added ${id}`,
          rows: [{ label: "Repo", after: `github.com/acme/${id}` }],
          secrets: [{ key: "hookUrl", label: "Deploy hook URL", required: true }],
        },
      },
    });
    messages = [
      {
        ...reply,
        text: "Done.",
        trace: {
          ms: 800,
          steps: [
            change("Website", "approved", '{"applied":true}'),
            change("Api", "denied", '{"error":"The user cancelled."}'),
            change("Docs", "expired", '{"error":"No answer."}'),
            change("Blog", "approved", '{"error":"There\'s already a deploy target called Blog."}'),
          ],
        },
      },
    ];
    open();
    const added = await screen.findByRole("button", { name: "Added Website" });
    expect(screen.queryByText("github.com/acme/Website")).toBeNull();
    fireEvent.click(added);
    expect(screen.getByText("github.com/acme/Website")).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: "Add deploy target Api" })).getByText("Cancelled"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("button", { name: "Add deploy target Docs" })).getByText("Expired"),
    ).toBeTruthy();
    expect(screen.getByText("There's already a deploy target called Blog.")).toBeTruthy();
    // Nothing decided asks again, or keeps an input.
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByLabelText("Deploy hook URL")).toBeNull();
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
          approval: {
            id: "cap_9",
            kind: "command",
            state: "pending",
            machine: "devbox",
            summary: "",
          },
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
