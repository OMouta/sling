// @vitest-environment happy-dom
import type {
  FeedbackSummaryView,
  InstructionsSuggestionView,
  MessageView,
  PersonalityView,
  ServerEvent,
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

function message(
  over: Partial<MessageView> & Pick<MessageView, "id" | "role" | "text">,
): MessageView {
  return {
    conversationId: "cnv_1",
    taskIds: [],
    createdAt: "2026-11-07T10:00:00.000Z",
    trace: null,
    attachments: [],
    personalityId: null,
    research: false,
    feedback: null,
    replaceable: false,
    ...over,
  };
}

const chat = () => [
  message({ id: "msg_1", role: "user", text: "What can I cook?" }),
  message({
    id: "msg_2",
    role: "assistant",
    text: "A frittata.",
    trace: { steps: [], ms: 1, followUps: ["Older follow-up"] },
  }),
  message({ id: "msg_3", role: "user", text: "Something quicker?", replaceable: true }),
  message({
    id: "msg_4",
    role: "assistant",
    text: "Scrambled eggs, see [the recipe](https://example.com) [1](https://example.com/a).\n\n```\nwhisk()\n```",
    replaceable: true,
    trace: { steps: [], ms: 1, followUps: ["Make it vegan", "What goes on the side?"] },
  }),
];

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
  revision: 3,
  templateKey: null,
  assistant: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
};

const summary: FeedbackSummaryView = {
  revision: 3,
  up: 4,
  down: 2,
  recent: [
    {
      messageId: "msg_9",
      conversationId: "cnv_9",
      conversationTitle: "Weeknight pasta",
      rating: "down",
      reason: "too long",
      excerpt: "Pasta needs a big pot of salted water",
      revision: 3,
      createdAt: "2026-11-07T09:00:00.000Z",
    },
    {
      messageId: "msg_8",
      conversationId: "cnv_8",
      conversationTitle: "Soup",
      rating: "down",
      reason: "",
      excerpt: "Soup starts with an onion",
      revision: 2,
      createdAt: "2026-11-06T09:00:00.000Z",
    },
  ],
};

const suggestion: InstructionsSuggestionView = {
  instructions: "You are Chef. Keep it short.",
  summary: "Shorter answers.",
  basedOn: 2,
};

let agentStatus = "idle";
let messages: MessageView[] = [];
let calls: { method: string; path: string; body: unknown }[] = [];

function route(method: string, path: string, body: unknown): unknown {
  if (method !== "GET") {
    calls.push({ method, path, body });
    if (path === "/api/personalities/prs_1/suggest") return suggestion;
    if (method === "PATCH" && path === "/api/personalities/prs_1") {
      return { ...personality, ...(body as object), revision: 4 };
    }
    return { ok: true };
  }
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
    case "/api/personalities/prs_1/feedback":
      return summary;
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

const clipboard = { writeText: vi.fn(async () => {}) };

beforeEach(() => {
  agentStatus = "idle";
  messages = chat();
  calls = [];
  socket = null;
  vi.stubGlobal("WebSocket", FakeSocket);
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return Response.json(route(init?.method ?? "GET", url.pathname, body));
    }),
  );
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  clipboard.writeText.mockClear();
});

function open(path = "/c/cnv_1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
}

/** The actions row under a reply, found by its text. */
async function actionsOf(text: string) {
  const reply = (await screen.findByText(text, { exact: false })).closest(".group\\/reply");
  if (!(reply instanceof HTMLElement)) throw new Error(`no reply with ${text}`);
  const copy = within(reply).getByRole("button", { name: "Copy" });
  return { reply, row: copy.parentElement as HTMLElement };
}

describe("reply actions", () => {
  it("are always under the latest reply, with Retry, and on hover under older ones", async () => {
    open();
    const latest = await actionsOf("Scrambled eggs");
    const older = await actionsOf("A frittata.");
    expect(latest.row.className).not.toContain("opacity-0");
    expect(older.row.className).toContain("opacity-0");
    expect(older.row.className).toContain("group-hover/reply:opacity-100");
    expect(older.row.className).toContain("pointer-coarse:opacity-100");
    expect(within(latest.reply).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(within(older.reply).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("copies the reply's Markdown and shows a check", async () => {
    open();
    const { reply } = await actionsOf("Scrambled eggs");
    fireEvent.click(within(reply).getByRole("button", { name: "Copy" }));
    await within(reply).findByRole("button", { name: "Copied" });
    expect(clipboard.writeText).toHaveBeenCalledWith(chat()[3]?.text);
  });

  it("retries the latest reply, and drops it when the server removes it", async () => {
    open();
    const { reply } = await actionsOf("Scrambled eggs");
    fireEvent.click(within(reply).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/conversations/cnv_1/retry",
        body: { messageId: "msg_4" },
      }),
    );
    emit({ type: "message.removed", conversationId: "cnv_1", messageIds: ["msg_4"] });
    await waitFor(() => expect(screen.queryByText("Scrambled eggs", { exact: false })).toBeNull());
    // Nothing is replaceable until the server says so again.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("offers no Retry or Edit after a reply that can't run again", async () => {
    messages = chat().map((m) => ({ ...m, replaceable: false }));
    open();
    const { reply } = await actionsOf("Scrambled eggs");
    expect(within(reply).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("rates a reply, asks why on down, and takes a vote back", async () => {
    open();
    const { reply } = await actionsOf("Scrambled eggs");
    const up = within(reply).getByRole("button", { name: "Good reply" });
    fireEvent.click(up);
    await waitFor(() => expect(up.getAttribute("aria-pressed")).toBe("true"));
    expect(calls.at(-1)).toEqual({
      method: "PUT",
      path: "/api/messages/msg_4/feedback",
      body: { rating: "up" },
    });
    fireEvent.click(up);
    await waitFor(() => expect(up.getAttribute("aria-pressed")).toBe("false"));
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/messages/msg_4/feedback" });

    fireEvent.click(within(reply).getByRole("button", { name: "Bad reply" }));
    const ask = await screen.findByRole("dialog", { name: "What was wrong with it?" });
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        method: "PUT",
        path: "/api/messages/msg_4/feedback",
        body: { rating: "down" },
      }),
    );
    fireEvent.change(within(ask).getByRole("textbox"), { target: { value: "too long" } });
    fireEvent.click(within(ask).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        method: "PUT",
        path: "/api/messages/msg_4/feedback",
        body: { rating: "down", reason: "too long" },
      }),
    );
    expect(screen.queryByRole("dialog", { name: "What was wrong with it?" })).toBeNull();
    expect(
      within(reply).getByRole("button", { name: "Bad reply" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("editing the latest message", () => {
  it("turns the bubble into a box, sends the new text, and shows it in place", async () => {
    open();
    expect(await screen.findAllByRole("button", { name: "Edit" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByRole("textbox", { name: "Edit message" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Something quicker?");
    // Cancel puts it back as it was.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Something quicker?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
      target: { value: "Under ten minutes?" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit message" }), { key: "Enter" });
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/conversations/cnv_1/messages/msg_3/edit",
        body: { text: "Under ten minutes?" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull());
    emit({
      type: "message.updated",
      message: message({ id: "msg_3", role: "user", text: "Under ten minutes?" }),
    });
    emit({ type: "message.removed", conversationId: "cnv_1", messageIds: ["msg_4"] });
    await screen.findByText("Under ten minutes?");
    expect(screen.queryByText("Something quicker?")).toBeNull();
    expect(screen.queryByText("Scrambled eggs", { exact: false })).toBeNull();
  });
});

describe("follow-ups", () => {
  it("show under the latest reply only, and a tap sends one", async () => {
    open();
    const list = await screen.findByRole("list", { name: "Follow-ups" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Make it vegan", "What goes on the side?"]);
    expect(screen.queryByText("Older follow-up")).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: "Make it vegan" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/api/conversations/cnv_1/messages",
        body: { text: "Make it vegan" },
      }),
    );
  });

  it("never show the block while a reply streams", async () => {
    agentStatus = "thinking";
    open();
    await screen.findAllByText("Thinking");
    emit({ type: "agent.delta", conversationId: "cnv_1", text: "Pasta works.\n\n<follow-" });
    expect(screen.getByText("Pasta works.")).toBeTruthy();
    emit({ type: "agent.delta", conversationId: "cnv_1", text: "ups>\nMake it vegan" });
    expect(document.body.textContent).not.toContain("follow-ups");
    expect(document.body.textContent).not.toContain("Make it vegan");
    // No buttons while it's being written.
    expect(screen.queryByRole("list", { name: "Follow-ups" })).toBeNull();
  });
});

describe("read aloud", () => {
  it("isn't there without speech synthesis", async () => {
    open();
    await actionsOf("Scrambled eggs");
    expect(screen.queryByRole("button", { name: "Read aloud" })).toBeNull();
  });

  it("reads the reply as plain text, and a second press stops it", async () => {
    const spoken: string[] = [];
    const synth = {
      speak: vi.fn((u: { text: string }) => spoken.push(u.text)),
      cancel: vi.fn(),
    };
    vi.stubGlobal("speechSynthesis", synth);
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text: string;
        constructor(text: string) {
          this.text = text;
        }
      },
    );
    open();
    const { reply } = await actionsOf("Scrambled eggs");
    fireEvent.click(within(reply).getByRole("button", { name: "Read aloud" }));
    expect(spoken.join(" ")).toBe("Scrambled eggs, see the recipe.");
    const stop = within(reply).getByRole("button", { name: "Stop reading" });
    fireEvent.click(stop);
    expect(synth.cancel).toHaveBeenCalled();
    expect(within(reply).getByRole("button", { name: "Read aloud" })).toBeTruthy();
  });
});

describe("a personality's feedback", () => {
  it("shows the counts, the downvotes with their chats, and a suggestion to apply", async () => {
    open("/personalities/prs_1");
    const heading = await screen.findByRole("heading", { name: "Feedback" });
    const section = heading.closest("section") as HTMLElement;
    await within(section).findByText("Revision 3");
    expect(within(section).getByTitle("Good replies").textContent).toContain("4");
    expect(within(section).getByTitle("Bad replies").textContent).toContain("2");
    const link = within(section).getByText("too long").closest("a");
    expect(link?.getAttribute("href")).toBe("/c/cnv_9");
    expect(within(section).getByText("No reason")).toBeTruthy();
    expect(within(section).getByText(/Revision 2 ·/)).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "Suggest changes" }));
    const dialog = await screen.findByRole("dialog", { name: "Suggested instructions" });
    expect(within(dialog).getByText("Shorter answers.")).toBeTruthy();
    expect(within(dialog).getByText("You are Chef.")).toBeTruthy();
    expect(within(dialog).getByText("You are Chef. Keep it short.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PATCH",
        path: "/api/personalities/prs_1",
        body: { instructions: "You are Chef. Keep it short." },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Suggested instructions" })).toBeNull(),
    );
  });

  it("offers no suggestion without downvotes on this revision", async () => {
    const before = summary.down;
    summary.down = 0;
    try {
      open("/personalities/prs_1");
      const heading = await screen.findByRole("heading", { name: "Feedback" });
      const section = heading.closest("section") as HTMLElement;
      await within(section).findByText("Revision 3");
      expect(within(section).queryByRole("button", { name: "Suggest changes" })).toBeNull();
    } finally {
      summary.down = before;
    }
  });

  it("has no Feedback section until a reply is rated", async () => {
    const saved = { up: summary.up, down: summary.down, recent: summary.recent };
    Object.assign(summary, { up: 0, down: 0, recent: [] });
    try {
      open("/personalities/prs_1");
      await screen.findByRole("heading", { name: "Instructions" });
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole("heading", { name: "Feedback" })).toBeNull();
    } finally {
      Object.assign(summary, saved);
    }
  });
});
