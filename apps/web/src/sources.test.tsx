// @vitest-environment happy-dom
import type { MessageView, PersonalityView, ServerEvent, SourceView } from "@sling/core";
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

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const tutor = {
  id: "prs_tutor",
  name: "Tutor",
  description: "Teaches step by step.",
  instructions: "You are Tutor.",
  tools: ["memory"],
  color: "teal",
  shape: "bloom",
  isDefault: false,
  position: 1,
  revision: 1,
  templateKey: "tutor",
  assistant: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
} satisfies PersonalityView;

function source(over: Partial<SourceView> & Pick<SourceView, "id" | "name">): SourceView {
  return {
    personalityId: tutor.id,
    conversationId: null,
    messageId: null,
    kind: "file",
    mediaType: "application/pdf",
    size: 120_000,
    url: null,
    state: "ready",
    error: null,
    pages: 12,
    chars: 30_000,
    createdAt: "2026-11-06T10:00:00.000Z",
    ...over,
  };
}

interface Call {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

let calls: Call[] = [];
let sources: SourceView[] = [];
let messages: MessageView[] = [];
let uploaded = 0;

function route(method: string, url: URL, body: unknown): unknown {
  const path = url.pathname;
  const key = `${method} ${path}`;
  switch (key) {
    case "GET /api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "GET /api/personalities":
      return [tutor];
    case "GET /api/personalities/prs_tutor/sources":
      return sources;
    case "POST /api/personalities/prs_tutor/sources": {
      const s = source({
        id: `src_up${++uploaded}`,
        name: url.searchParams.get("name") ?? "",
        state: "processing",
        pages: null,
      });
      sources = [...sources, s];
      return s;
    }
    case "POST /api/personalities/prs_tutor/sources/link": {
      const s = source({
        id: "src_link",
        kind: "link",
        name: "example.com/course",
        url: (body as { url: string }).url,
        state: "processing",
        pages: null,
      });
      sources = [...sources, s];
      return s;
    }
    case "POST /api/attachments":
      return source({
        id: `src_att${++uploaded}`,
        personalityId: null,
        name: url.searchParams.get("name") ?? "",
        mediaType: "text/markdown",
        state: "processing",
        pages: null,
      });
    case "POST /api/conversations/cnv_1/messages":
      return { id: "msg_new" };
    case "GET /api/runners":
    case "GET /api/conversations":
      return [];
    case "GET /api/conversations/cnv_1":
      return {
        conversation: {
          id: "cnv_1",
          title: "Lease",
          mode: "auto",
          settings: { assistant: null, agent: null },
          personalityId: tutor.id,
          startedBy: null,
          createdAt: "2026-11-06T10:00:00.000Z",
          updatedAt: "2026-11-06T10:01:00.000Z",
        },
        personality: tutor,
        messages,
        tasks: [],
        agentStatus: "idle",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
  }
  if (method === "DELETE" && /^\/api\/sources\/[^/]+$/.test(path)) return undefined;
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

beforeEach(() => {
  calls = [];
  sources = [];
  messages = [];
  uploaded = 0;
  socket = null;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      calls.push({ method, path: url.pathname, search: url.search, body });
      try {
        const data = route(method, url, body);
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

const pdf = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });

describe("a personality's Sources section", () => {
  it("lists sources by kind, pages, and state, and follows them as they're read", async () => {
    sources = [
      source({ id: "src_lease", name: "lease.pdf" }),
      source({
        id: "src_scan",
        name: "scan.pdf",
        state: "failed",
        pages: null,
        error: "No text found. It may be a scanned PDF.",
      }),
    ];
    renderAt("/personalities/prs_tutor");
    expect(await screen.findByRole("heading", { name: "Sources" })).toBeTruthy();
    const lease = await screen.findByRole("link", { name: "lease.pdf" });
    expect(lease.getAttribute("href")).toBe("/api/sources/src_lease/view");
    expect(screen.getByText("PDF · 12 pages")).toBeTruthy();
    expect(screen.getByText("No text found. It may be a scanned PDF.")).toBeTruthy();

    // A drop uploads each file, which shows as being read until the server says it's ready.
    const zone = screen.getByText("Drop files here").parentElement as HTMLElement;
    fireEvent.drop(zone, { dataTransfer: { files: [pdf("lecture 2.pdf")], types: ["Files"] } });
    expect(await screen.findByText("lecture 2.pdf")).toBeTruthy();
    expect(screen.getByText("Reading…")).toBeTruthy();
    const [up] = callsTo("POST", "/api/personalities/prs_tutor/sources");
    expect(up?.search).toBe("?name=lecture%202.pdf");
    emit({
      type: "source.updated",
      source: source({ id: "src_up1", name: "lecture 2.pdf", pages: 31 }),
    });
    expect(await screen.findByText("PDF · 31 pages")).toBeTruthy();

    // A failed one is removed with its Remove button, and gone when the server says so.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("scan.pdf")).toBeNull());
    expect(callsTo("DELETE", "/api/sources/src_scan")).toHaveLength(1);
    emit({ type: "source.removed", id: "src_lease" });
    await waitFor(() => expect(screen.queryByText("lease.pdf")).toBeNull());
  });

  it("adds a link from a small field, and Enter there never saves the personality", async () => {
    renderAt("/personalities/prs_tutor");
    fireEvent.click(await screen.findByRole("button", { name: "Add link" }));
    const field = screen.getByRole("textbox", { name: "Link" });
    fireEvent.change(field, { target: { value: "https://example.com/course" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await screen.findByText("example.com/course")).toBeTruthy();
    expect(callsTo("POST", "/api/personalities/prs_tutor/sources/link")[0]?.body).toEqual({
      url: "https://example.com/course",
    });
    expect(callsTo("PATCH", "/api/personalities/prs_tutor")).toHaveLength(0);
    expect(screen.queryByRole("textbox", { name: "Link" })).toBeNull();
  });
});

describe("files in the composer", () => {
  it("uploads a pasted file at once, shows its chip, and sends it with the message", async () => {
    renderAt("/c/cnv_1");
    const box = await screen.findByRole("textbox", { name: "Message" });
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const note = new File(["No pets."], "lease.md", { type: "text/markdown" });
    fireEvent.paste(box, { clipboardData: { files: [note] } });
    const chips = within(await screen.findByRole("list", { name: "Files" }));
    expect(await chips.findByText("Reading…")).toBeTruthy();
    expect(callsTo("POST", "/api/attachments")[0]?.search).toBe("?name=lease.md");
    emit({
      type: "source.updated",
      source: source({
        id: "src_att1",
        personalityId: null,
        name: "lease.md",
        mediaType: "text/markdown",
        pages: null,
        size: 8,
      }),
    });
    expect(await chips.findByText("8 B")).toBeTruthy();

    // A file alone can be sent.
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() =>
      expect(callsTo("POST", "/api/conversations/cnv_1/messages")[0]?.body).toEqual({
        text: "",
        attachmentIds: ["src_att1"],
      }),
    );
    await waitFor(() => expect(screen.queryByRole("list", { name: "Files" })).toBeNull());
  });

  it("refuses a fifth image in one message, and removes a chip with ×", async () => {
    renderAt("/c/cnv_1");
    const box = await screen.findByRole("textbox", { name: "Message" });
    const images = Array.from(
      { length: 5 },
      (_, i) => new File(["x"], `p${i}.gif`, { type: "image/gif" }),
    );
    fireEvent.paste(box, { clipboardData: { files: images } });
    const chips = within(await screen.findByRole("list", { name: "Files" }));
    expect(await chips.findByText("A message takes at most 4 images.")).toBeTruthy();
    await waitFor(() => expect(callsTo("POST", "/api/attachments")).toHaveLength(4));
    fireEvent.click(chips.getByRole("button", { name: "Remove p4.gif" }));
    expect(chips.queryByText("A message takes at most 4 images.")).toBeNull();
  });

  it("shows a drop overlay while files are dragged over the chat", async () => {
    renderAt("/c/cnv_1");
    await screen.findByRole("textbox", { name: "Message" });
    const drag = (type: string) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", {
        value: { types: ["Files"], files: [pdf("a.pdf")], dropEffect: "none" },
      });
      act(() => {
        window.dispatchEvent(ev);
      });
    };
    drag("dragenter");
    expect(screen.getByText("Drop files to add them")).toBeTruthy();
    drag("drop");
    expect(screen.queryByText("Drop files to add them")).toBeNull();
    expect(await screen.findByText("a.pdf")).toBeTruthy();
  });
});

describe("a sent message's files", () => {
  it("shows image thumbnails that open full size, and document chips that open the file", async () => {
    messages = [
      {
        id: "msg_1",
        conversationId: "cnv_1",
        role: "user",
        text: "",
        taskIds: [],
        attachments: [
          source({
            id: "src_img",
            kind: "image",
            name: "sign.jpg",
            mediaType: "image/jpeg",
            personalityId: null,
            conversationId: "cnv_1",
            messageId: "msg_1",
            pages: null,
          }),
          source({
            id: "src_doc",
            name: "lease.pdf",
            personalityId: null,
            conversationId: "cnv_1",
            messageId: "msg_1",
            pages: 4,
          }),
        ],
        personalityId: null,
        research: false,
        feedback: null,
        replaceable: false,
        createdAt: "2026-11-06T10:00:30.000Z",
        trace: null,
      },
    ];
    renderAt("/c/cnv_1");
    const doc = await screen.findByRole("link", { name: /lease\.pdf/ });
    expect(doc.getAttribute("href")).toBe("/api/sources/src_doc/file");
    expect(within(doc).getByText("4 pages")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open sign.jpg" }));
    const full = screen.getByRole("dialog", { name: "sign.jpg" });
    expect(within(full).getByRole("img").getAttribute("src")).toBe("/api/sources/src_img/file");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "sign.jpg" })).toBeNull();
  });
});
