// @vitest-environment happy-dom
import type {
  MemoryView,
  MessageView,
  PersonalityView,
  RunnerView,
  ServerEvent,
  ToolStep,
} from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const planner = {
  id: "prs_planner",
  name: "Planner",
  description: "",
  instructions: "",
  tools: ["apps", "memory"],
  color: "silver",
  shape: "facet",
  isDefault: false,
  position: 1,
  revision: 1,
  templateKey: "planner",
  assistant: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
} satisfies PersonalityView;

function memory(over: Partial<MemoryView> & Pick<MemoryView, "id" | "text">): MemoryView {
  return {
    personalityId: null,
    source: { kind: "manual", conversationId: null, conversationTitle: null, messageId: null },
    createdAt: "2026-11-06T10:00:00.000Z",
    updatedAt: "2026-11-06T10:00:00.000Z",
    lastUsedAt: "2026-11-06T10:00:00.000Z",
    ...over,
  };
}

const vegetarian = memory({
  id: "mem_veg",
  text: "Vegetarian",
  source: {
    kind: "chat",
    conversationId: "cnv_1",
    conversationTitle: "Dinner plans",
    messageId: "msg_1",
  },
});
const jo = memory({ id: "mem_jo", text: "Jo Silva is their accountant, jo@silva.pt" });

const rememberStep = (over: Partial<ToolStep> = {}): ToolStep => ({
  kind: "tool",
  id: "call_1",
  name: "remember",
  input: { text: "Vegetarian" },
  status: "done",
  output: '{"id":"mem_veg","text":"Vegetarian","for":"every personality"}',
  memory: { id: "mem_veg", text: "Vegetarian", undone: false },
  ...over,
});

function reply(steps: ToolStep[]): MessageView {
  return {
    id: "msg_2",
    conversationId: "cnv_1",
    role: "assistant",
    text: "Noted.",
    taskIds: [],
    attachments: [],
    personalityId: null,
    research: false,
    feedback: null,
    replaceable: false,
    createdAt: "2026-11-06T10:01:00.000Z",
    trace: { ms: 1200, steps },
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[] = [];
let memories: MemoryView[] = [];
let messages: MessageView[] = [];
let runners: RunnerView[] = [];

function route(method: string, path: string, body: unknown): unknown {
  const key = `${method} ${path}`;
  switch (key) {
    case "GET /api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "GET /api/memories":
      return memories;
    case "GET /api/personalities":
      return [planner];
    case "GET /api/runners":
      return runners;
    case "GET /api/conversations":
      return [];
    case "GET /api/conversations/cnv_1":
      return {
        conversation: {
          id: "cnv_1",
          title: "Dinner plans",
          mode: "auto",
          settings: { assistant: null, agent: null },
          personalityId: null,
          startedBy: null,
          createdAt: "2026-11-06T10:00:00.000Z",
          updatedAt: "2026-11-06T10:01:00.000Z",
        },
        personality: null,
        messages,
        tasks: [],
        agentStatus: "idle",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    case "POST /api/memories": {
      const text = String((body as { text: string }).text);
      if (/password/i.test(text)) {
        throw new HttpError(
          422,
          "It looks like it holds a password or PIN, and secrets are never remembered.",
        );
      }
      const added = memory({ id: "mem_new", text });
      memories = [added, ...memories];
      return added;
    }
  }
  const one = /^\/api\/memories\/([^/]+)$/.exec(path);
  if (one) {
    const found = memories.find((m) => m.id === one[1]);
    if (!found) throw new HttpError(404, "No such memory.");
    if (method === "PATCH") {
      const next = { ...found, ...(body as object) } as MemoryView;
      memories = memories.map((m) => (m.id === found.id ? next : m));
      return next;
    }
    if (method === "DELETE") {
      memories = memories.filter((m) => m.id !== found.id);
      return { ok: true };
    }
  }
  if (method === "GET") return null;
  throw new HttpError(500, `unmocked ${key}`);
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

let clipboard: string[] = [];

beforeEach(() => {
  calls = [];
  memories = [vegetarian, jo];
  messages = [];
  runners = [];
  clipboard = [];
  socket = null;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("navigator", {
    ...navigator,
    clipboard: { writeText: async (text: string) => void clipboard.push(text) },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      try {
        const data = route(method, url.pathname, body);
        return new Response(data === undefined ? "" : JSON.stringify(data), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        return new Response(JSON.stringify({ error: (err as Error).message }), { status });
      }
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
  return { queryClient, router };
}

const callsTo = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

async function list() {
  return within(await screen.findByRole("list", { name: "Memories" }));
}

function rows(l: ReturnType<typeof within>) {
  return l.getAllByRole("listitem").map((li: HTMLElement) => li.textContent ?? "");
}

async function menu(text: string, item: string | RegExp) {
  const row = (await screen.findByText(text)).closest("li") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Memory options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

describe("the Memory page", () => {
  it("lists each memory with where it came from, and links to its chat", async () => {
    renderAt("/memory");
    const l = await list();
    expect(rows(l)).toEqual([
      expect.stringMatching(/^VegetarianDinner plans·/),
      expect.stringMatching(/^Jo Silva is their accountant, jo@silva\.ptAdded by you·/),
    ]);
    expect(l.getByRole("link", { name: "Dinner plans" }).getAttribute("href")).toBe("/c/cnv_1");
  });

  it("filters as you type, by every word", async () => {
    renderAt("/memory");
    const l = await list();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search memories" }), {
      target: { value: "silva acc" },
    });
    await waitFor(() => expect(rows(l)).toHaveLength(1));
    expect(rows(l)[0]).toContain("Jo Silva");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "boiler" } });
    expect(await screen.findByText("No memories match.")).toBeTruthy();
    // The list came whole, so nothing asked the server.
    expect(calls.filter((c) => c.path === "/api/memories" && c.method === "GET")).toHaveLength(1);
  });

  it("adds one, and shows why a secret is refused", async () => {
    renderAt("/memory");
    await list();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const box = screen.getByRole("textbox", { name: "New memory" });
    fireEvent.change(box, { target: { value: "My bank password is hunter2" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(/holds a password or PIN/)).toBeTruthy();
    fireEvent.change(box, { target: { value: "  Takes the 07:42 train\n on weekdays " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "New memory" })).toBeNull());
    expect(callsTo("POST", "/api/memories").at(-1)?.body).toEqual({
      text: "Takes the 07:42 train on weekdays",
    });
    expect(rows(await list())[0]).toMatch(/^Takes the 07:42 train on weekdays/);
  });

  it("edits in place: Enter saves, Escape leaves it as it was", async () => {
    renderAt("/memory");
    fireEvent.click(await screen.findByRole("button", { name: "Vegetarian" }));
    const box = screen.getByRole("textbox", { name: "Memory" });
    fireEvent.change(box, { target: { value: "Vegetarian, and no fish" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Vegetarian" })).toBeTruthy();
    expect(callsTo("PATCH", "/api/memories/mem_veg")).toHaveLength(0);

    await menu("Vegetarian", "Edit");
    const again = screen.getByRole("textbox", { name: "Memory" });
    fireEvent.change(again, { target: { value: "Vegetarian, and no fish" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "Vegetarian, and no fish" })).toBeTruthy();
    expect(callsTo("PATCH", "/api/memories/mem_veg")[0]?.body).toEqual({
      text: "Vegetarian, and no fish",
    });
  });

  it("keeps one to a personality from its menu, and deletes from there", async () => {
    renderAt("/memory");
    await menu("Vegetarian", /Only Planner/);
    expect(await screen.findByText("Only Planner")).toBeTruthy();
    expect(callsTo("PATCH", "/api/memories/mem_veg")[0]?.body).toEqual({
      personalityId: "prs_planner",
    });
    await menu("Vegetarian", "Every personality");
    await waitFor(() => expect(screen.queryByText("Only Planner")).toBeNull());

    await menu("Vegetarian", "Delete");
    const ask = within(await screen.findByRole("dialog", { name: "Delete this memory?" }));
    expect(callsTo("DELETE", "/api/memories/mem_veg")).toHaveLength(0);
    fireEvent.click(ask.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Vegetarian")).toBeNull());
    expect(callsTo("DELETE", "/api/memories/mem_veg")).toHaveLength(1);
  });

  it("follows changes from elsewhere", async () => {
    renderAt("/memory");
    const l = await list();
    emit({ type: "memory.updated", memory: memory({ id: "mem_x", text: "Allergic to peanuts" }) });
    await waitFor(() => expect(rows(l)[0]).toMatch(/^Allergic to peanuts/));
    emit({ type: "memory.removed", id: "mem_jo" });
    await waitFor(() => expect(rows(l)).toHaveLength(2));
    expect(screen.queryByText(/Jo Silva/)).toBeNull();
  });

  it("renders a long list a page at a time as you scroll", async () => {
    let seen: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: typeof seen) {
          seen = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    memories = Array.from({ length: 450 }, (_, i) => memory({ id: `mem_${i}`, text: `Fact ${i}` }));
    renderAt("/memory");
    const l = await list();
    expect(rows(l)).toHaveLength(200);
    act(() => seen?.([{ isIntersecting: true }]));
    await waitFor(() => expect(rows(l)).toHaveLength(400));
    act(() => seen?.([{ isIntersecting: true }]));
    await waitFor(() => expect(rows(l)).toHaveLength(450));
    expect(screen.getByRole("button", { name: "Fact 449" })).toBeTruthy();
  });

  it("says so when there's nothing yet", async () => {
    memories = [];
    renderAt("/memory");
    expect(await screen.findByText("Nothing remembered yet")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});

describe("the Remembered line in a chat", () => {
  it("shows what was saved, and Undo deletes it", async () => {
    messages = [reply([rememberStep()])];
    renderAt("/c/cnv_1");
    const line = (await screen.findByText("Vegetarian")).closest("p") as HTMLElement;
    expect(line.textContent).toBe("Remembered: VegetarianUndo");
    fireEvent.click(within(line).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(line.textContent).toBe("Forgotten: Vegetarian"));
    expect(callsTo("DELETE", "/api/memories/mem_veg")).toHaveLength(1);
  });

  it("says Forgotten once it's deleted anywhere, and after Undo of one already gone", async () => {
    messages = [reply([rememberStep()])];
    renderAt("/c/cnv_1");
    const line = (await screen.findByText("Vegetarian")).closest("p") as HTMLElement;
    emit({ type: "memory.removed", id: "mem_veg" });
    await waitFor(() => expect(line.textContent).toBe("Forgotten: Vegetarian"));
    cleanup();

    memories = [];
    renderAt("/c/cnv_1");
    const stale = (await screen.findByText("Vegetarian")).closest("p") as HTMLElement;
    fireEvent.click(within(stale).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(stale.textContent).toBe("Forgotten: Vegetarian"));
  });

  it("says why nothing was saved", async () => {
    messages = [
      reply([
        rememberStep({
          memory: undefined,
          output:
            '{"error":"Not saved. It looks like it holds a card number, and those are never remembered."}',
        }),
        rememberStep({
          id: "call_2",
          memory: undefined,
          output: '{"id":"mem_veg","text":"Vegetarian","alreadyRemembered":true}',
        }),
      ]),
    ];
    renderAt("/c/cnv_1");
    const refused = (await screen.findByText("Not remembered")).closest("p");
    expect(refused?.textContent).toBe(
      "Not remembered It looks like it holds a card number, and those are never remembered.",
    );
    expect(screen.getByText(/^Already remembered:/).textContent).toBe(
      "Already remembered: Vegetarian",
    );
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("names what a search and a read looked at", async () => {
    messages = [
      reply([
        {
          kind: "tool",
          id: "call_s",
          name: "search_files",
          input: { query: "boiler" },
          status: "done",
          output: '{"hits":[{"machine":"laptop"},{"machine":"laptop"}]}',
        },
        {
          kind: "tool",
          id: "call_r",
          name: "read_file",
          input: { machine: "laptop", folder: "Notes", path: "house/boiler.md" },
          status: "done",
          output: '{"content":"…"}',
        },
        {
          kind: "tool",
          id: "call_o",
          name: "search_files",
          input: { query: "tax" },
          status: "done",
          output: '{"hits":[],"errors":[{"machine":"laptop","error":"laptop is offline."}]}',
        },
      ]),
    ];
    renderAt("/c/cnv_1");
    expect(await screen.findByText("Searched your files for “boiler”: 2 matches")).toBeTruthy();
    expect(screen.getByText("Read Notes/house/boiler.md")).toBeTruthy();
    expect(screen.getByText("Couldn't search your files: laptop is offline.")).toBeTruthy();
  });
});

describe("folders on Machines", () => {
  it("lists the folders a machine shares", async () => {
    runners = [{ ...devbox, folders: ["Notes", "Recipes"], files: true }];
    renderAt("/machines");
    const section = within(await screen.findByRole("region", { name: "Folders on devbox" }));
    expect(section.getByText("2 shared")).toBeTruthy();
    const names = section.getAllByRole("listitem").map((li) => li.textContent);
    expect(names).toEqual(["Notes", "Recipes"]);
    expect(section.queryByText(/config set files on/)).toBeNull();
  });

  it("gives the line to copy when there are none", async () => {
    runners = [{ ...devbox, folders: [], files: true }];
    renderAt("/machines");
    const section = within(await screen.findByRole("region", { name: "Folders on devbox" }));
    expect(section.getByText("None shared")).toBeTruthy();
    fireEvent.click(section.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(clipboard).toEqual(["sling-runner folder add ~/Documents"]));
  });

  it("says when files are off on the machine", async () => {
    runners = [{ ...devbox, folders: ["Notes"], files: false }];
    renderAt("/machines");
    const section = within(await screen.findByRole("region", { name: "Folders on devbox" }));
    expect(section.getByText("1 shared, off")).toBeTruthy();
    expect(section.getByText("sling-runner config set files on")).toBeTruthy();
  });
});
