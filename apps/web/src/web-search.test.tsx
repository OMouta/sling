// @vitest-environment happy-dom
import type {
  AssistantChoice,
  LiveReplyView,
  MessageView,
  PersonalityView,
  ServerEvent,
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

const research: PersonalityView = {
  id: "per_research",
  name: "Research",
  description: "Explains a topic and compares options.",
  instructions: "You are Research.",
  tools: ["memory", "web"],
  color: "cyan",
  shape: "loop",
  assistant: null,
  isDefault: true,
  position: 0,
  revision: 1,
  templateKey: "research",
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
};
const writer: PersonalityView = {
  ...research,
  id: "per_writer",
  name: "Writer",
  tools: ["memory"],
};

const claude: AssistantChoice = {
  provider: "claude-code",
  model: "claude-haiku-5-5",
  effort: null,
  fast: false,
};
const local: AssistantChoice = {
  provider: "openai-compatible",
  model: "llama3.3",
  effort: null,
  fast: false,
};

const search: ToolStep = {
  kind: "tool",
  id: "t1",
  name: "web_search",
  input: { query: "eu ai act changes" },
  status: "done",
  output: JSON.stringify({
    results: [
      {
        title: "AI Act | Shaping Europe's digital future",
        url: "https://digital-strategy.ec.europa.eu/en/policies/ai",
      },
      { title: "", url: "https://www.artificialintelligenceact.eu/" },
    ],
  }),
};
const page: ToolStep = {
  kind: "tool",
  id: "t2",
  name: "web_fetch",
  input: { url: "https://eur-lex.europa.eu/eli/reg/2024/1689/oj" },
  status: "done",
  output: JSON.stringify({ title: "Regulation (EU) 2024/1689", text: "…" }),
};

function message(over: Partial<MessageView>): MessageView {
  return {
    id: "msg_2",
    conversationId: "cnv_1",
    role: "assistant",
    text: "",
    taskIds: [],
    attachments: [],
    personalityId: null,
    research: false,
    feedback: null,
    replaceable: false,
    createdAt: "2026-11-05T10:01:00.000Z",
    trace: null,
    ...over,
  };
}

const cited = message({
  text: "The bans apply from February 2025 [1](https://eur-lex.europa.eu/eli/reg/2024/1689/oj), and fines later [2](https://www.artificialintelligenceact.eu/). See [the guide](https://example.com/guide).",
  trace: {
    ms: 9000,
    steps: [search, page],
    sources: [
      {
        n: 1,
        url: "https://eur-lex.europa.eu/eli/reg/2024/1689/oj",
        title: "Regulation (EU) 2024/1689",
        kind: "web",
      },
      {
        n: 2,
        url: "https://www.artificialintelligenceact.eu/",
        title: "artificialintelligenceact.eu",
        kind: "web",
      },
      {
        n: 3,
        url: "https://sling.test/api/sources/src_1/view?page=4",
        title: "lease.pdf",
        kind: "document",
        sourceId: "src_1",
        page: 4,
      },
      {
        n: 4,
        url: "https://blog.rust-lang.org/2026/10/01/Rust-1.99.0/",
        title: "blog.rust-lang.org",
        kind: "web",
      },
    ],
  },
});

let personality: PersonalityView = research;
let assistant: AssistantChoice | null = claude;
let agentStatus = "idle";
let messages: MessageView[] = [];
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
          title: "EU AI Act",
          mode: "auto",
          settings: { assistant, agent: null },
          createdAt: "2026-11-05T10:00:00.000Z",
          updatedAt: "2026-11-05T10:01:00.000Z",
        },
        personality,
        messages,
        tasks: [],
        agentStatus,
        live,
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
  personality = research;
  assistant = claude;
  agentStatus = "idle";
  messages = [];
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

describe("web search in a chat", () => {
  it("shows a search with its query, its results on a click, and the page it read", async () => {
    messages = [cited];
    open();
    const steps = within(await screen.findByRole("list", { name: "Steps" }));
    const searched = steps.getByRole("button", { name: /Searched for “eu ai act changes”/ });
    expect(searched.textContent).toContain("2 results");
    expect(searched.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(searched);
    const result = steps.getByRole("link", { name: /AI Act \| Shaping Europe's digital future/ });
    expect(result.getAttribute("href")).toBe(
      "https://digital-strategy.ec.europa.eu/en/policies/ai",
    );
    expect(result.textContent).toContain("digital-strategy.ec.europa.eu");
    // Untitled results go by their site.
    expect(steps.getByRole("link", { name: /^artificialintelligenceact\.eu/ })).toBeTruthy();
    const read = steps.getByRole("link", { name: /Read Regulation \(EU\) 2024\/1689/ });
    expect(read.textContent).toContain("eur-lex.europa.eu");
    expect(read.getAttribute("target")).toBe("_blank");
  });

  it("shows a search still running, and one that failed", async () => {
    agentStatus = "thinking";
    open();
    await screen.findAllByText("Thinking");
    emit({
      type: "agent.tool",
      conversationId: "cnv_1",
      step: { ...search, status: "running", output: null },
    });
    expect(screen.getByText(/Searching the web for/).textContent).toContain("“eu ai act changes”");
    emit({
      type: "agent.tool",
      conversationId: "cnv_1",
      step: { ...page, status: "error", output: "Request failed with status code 404" },
    });
    expect(screen.getByRole("link", { name: /Couldn't open eur-lex\.europa\.eu/ })).toBeTruthy();
  });

  it("turns numbered links into citation pills that open the page", async () => {
    messages = [cited];
    open();
    await screen.findByRole("list", { name: "Steps" });
    const pills = document.querySelectorAll(".prose-chat a.citation");
    expect(
      [...pills].map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target")]),
    ).toEqual([
      ["1", "https://eur-lex.europa.eu/eli/reg/2024/1689/oj", "_blank"],
      ["2", "https://www.artificialintelligenceact.eu/", "_blank"],
    ]);
    expect(pills[0]?.getAttribute("title")).toBe("eur-lex.europa.eu");
    // A link with words stays a link.
    expect(screen.getByRole("link", { name: "the guide" }).className).not.toContain("citation");
  });

  it("lists the sources under the reply, with documents by page", async () => {
    messages = [cited];
    open();
    const list = within(await screen.findByRole("region", { name: "Sources" }));
    const rows = list.getAllByRole("link");
    expect(rows.map((r) => r.textContent)).toEqual([
      "1eur-lex.europa.euRegulation (EU) 2024/1689",
      "2artificialintelligenceact.eu",
      "3lease.pdfpage 4",
      // A page with no title of its own shows its path.
      "4blog.rust-lang.org/2026/10/01/Rust-1.99.0",
    ]);
    expect(rows[2]?.getAttribute("href")).toBe("https://sling.test/api/sources/src_1/view?page=4");
  });

  it("keeps a long list short until asked", async () => {
    messages = [
      message({
        text: "Many [1](https://a.test/)",
        trace: {
          ms: 1,
          steps: [],
          sources: Array.from({ length: 8 }, (_, i) => ({
            n: i + 1,
            url: `https://s${i + 1}.test/`,
            title: `Page ${i + 1}`,
            kind: "web" as const,
          })),
        },
      }),
    ];
    open();
    const list = within(await screen.findByRole("region", { name: "Sources" }));
    expect(list.getAllByRole("link")).toHaveLength(4);
    fireEvent.click(list.getByRole("button", { name: "Show all 8" }));
    expect(list.getAllByRole("link")).toHaveLength(8);
  });

  it("shows no list for a reply that cited nothing", async () => {
    messages = [message({ text: "Hello.", trace: { ms: 1, steps: [search] } })];
    open();
    await screen.findByRole("list", { name: "Steps" });
    expect(screen.queryByRole("region", { name: "Sources" })).toBeNull();
  });
});

describe("Deep research", () => {
  async function plusMenu() {
    await screen.findByRole("textbox", { name: "Message" });
    const plus = screen.queryByRole("button", { name: "Add to your message" });
    if (plus) fireEvent.click(plus);
    return plus;
  }

  it("turns on from the + menu, shows a chip, sends with the message, and turns off", async () => {
    open();
    await plusMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Deep research" }));
    expect(screen.getByText("Deep research", { selector: "span" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "What changed in the EU AI Act this month?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      path: "/api/conversations/cnv_1/messages",
      body: { text: "What changed in the EU AI Act this month?", research: true },
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Turn off Deep research" })).toBeNull(),
    );
  });

  it("comes off with the chip's ×, and then isn't sent", async () => {
    open();
    await plusMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Deep research" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn off Deep research" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toEqual({ text: "Hi" });
  });

  it("isn't offered without the web, or on a model that can't search", async () => {
    personality = writer;
    open();
    await plusMenu();
    expect(screen.queryByRole("menuitem", { name: "Deep research" })).toBeNull();
    cleanup();
    personality = research;
    assistant = local;
    open();
    await plusMenu();
    expect(screen.queryByRole("menuitem", { name: "Deep research" })).toBeNull();
  });

  it("says it's researching, with what it has searched and read so far", async () => {
    agentStatus = "thinking";
    messages = [message({ id: "msg_1", role: "user", text: "Research it.", research: true })];
    live = {
      text: "",
      steps: [search, page, { ...search, id: "t3" }],
      startedAt: Date.now() - 65_000,
    };
    open();
    const line = await screen.findByText("Researching");
    expect(line.parentElement?.textContent).toMatch(
      /^Researching2 searches · 1 page · 1m 0[5-6]s$/,
    );
    expect(screen.queryByText(/^Thinking$/, { selector: "span.text-shimmer" })).toBeNull();
  });

  it("folds a finished report's work into one line", async () => {
    messages = [
      message({ id: "msg_1", role: "user", text: "Research it.", research: true }),
      message({
        ...cited,
        trace: { ...(cited.trace ?? { steps: [], ms: 0 }), ms: 18 * 60_000, research: true },
      }),
    ];
    open();
    const fold = await screen.findByRole("button", { name: /Researched for 18m 00s/ });
    expect(fold.textContent).toContain("1 search · 1 page");
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();
    fireEvent.click(fold);
    expect(screen.getByRole("list", { name: "Steps" })).toBeTruthy();
  });
});
