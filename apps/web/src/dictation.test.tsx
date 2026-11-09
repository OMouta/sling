// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinSpoken } from "./lib/dictation.ts";
import { createAppRouter } from "./router.tsx";

vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signOut: async () => {},
  },
}));

/** A stand-in for the browser's speech recognition, driven by the test. */
class FakeRecognition {
  static all: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onaudiostart: (() => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;
  aborted = false;
  constructor() {
    FakeRecognition.all.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {
    this.aborted = true;
  }
  /** The microphone came on. */
  hear() {
    act(() => this.onaudiostart?.());
  }
  /** Every result so far in this session, as the browser hands them over each time. */
  say(results: [text: string, final: boolean][], resultIndex = 0) {
    act(() =>
      this.onresult?.({
        resultIndex,
        results: results.map(([transcript, isFinal]) =>
          Object.assign([{ transcript }], { isFinal }),
        ),
      }),
    );
  }
  fail(error: string) {
    act(() => this.onerror?.({ error }));
  }
  end() {
    act(() => this.onend?.());
  }
}

const last = () => {
  const r = FakeRecognition.all.at(-1);
  if (!r) throw new Error("no recognition started");
  return r;
};

let posts: { path: string; body: unknown }[] = [];
let clock = 0;

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
          createdAt: "2026-11-05T10:00:00.000Z",
          updatedAt: "2026-11-05T10:01:00.000Z",
        },
        messages: [],
        tasks: [],
        agentStatus: "idle",
        live: null,
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

class FakeSocket {
  readyState = 0;
  onopen = null;
  onclose = null;
  onmessage = null;
  send() {}
  close() {}
}

beforeEach(() => {
  posts = [];
  clock = 1000;
  FakeRecognition.all = [];
  vi.spyOn(performance, "now").mockImplementation(() => clock);
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
  vi.restoreAllMocks();
});

async function openChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/c/cnv_1"] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
  return (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
}

const mic = () => screen.getByRole("button", { name: /^(Dictate|Stop dictating)$/ });

function press(after = 0) {
  fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
  clock += after;
}
function release() {
  fireEvent.pointerUp(mic(), { button: 0, pointerId: 1 });
}

describe("the mic", () => {
  it("isn't there when the browser has no speech recognition", async () => {
    await openChat();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });

  it("fills the composer while held, in the browser's language, and stops on release", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    vi.spyOn(navigator, "language", "get").mockReturnValue("pt-PT");
    const box = await openChat();
    expect(mic().getAttribute("aria-pressed")).toBe("false");

    press();
    const r = last();
    expect(r).toMatchObject({
      started: true,
      lang: "pt-PT",
      continuous: true,
      interimResults: true,
    });
    expect(mic().getAttribute("aria-label")).toBe("Stop dictating");
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    expect(box.placeholder).toBe("Listening…");
    r.hear();
    r.say([["book dinner", false]]);
    expect(box.value).toBe("book dinner");
    r.say([["Book dinner with Jo", false]]);
    expect(box.value).toBe("Book dinner with Jo");
    r.say([
      ["Book dinner with Jo.", true],
      [" somewhere vegetarian", false],
    ]);
    expect(box.value).toBe("Book dinner with Jo. somewhere vegetarian");

    clock += 1500;
    release();
    expect(r.stopped).toBe(true);
    // The last words arrive after the release.
    r.say([
      ["Book dinner with Jo.", true],
      [" Somewhere vegetarian.", true],
    ]);
    r.end();
    expect(box.value).toBe("Book dinner with Jo. Somewhere vegetarian.");
    expect(mic().getAttribute("aria-label")).toBe("Dictate");
    expect(box.placeholder).toBe("Message Sling");
    // Nothing sends on its own.
    expect(posts).toEqual([]);
    expect(FakeRecognition.all).toHaveLength(1);
  });

  it("starts on a short tap and stops on the next", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    const box = await openChat();
    press();
    const r = last();
    // The mic comes on quickly, and the finger is up soon after.
    r.hear();
    clock += 120;
    release();
    expect(r.stopped).toBe(false);
    expect(mic().getAttribute("aria-label")).toBe("Stop dictating");
    r.say([["call the bank at five", false]]);
    expect(box.value).toBe("call the bank at five");

    clock += 4000;
    press(80);
    release();
    expect(r.stopped).toBe(true);
    expect(FakeRecognition.all).toHaveLength(1);
    expect(box.value).toBe("call the bank at five");
    r.end();
    expect(mic().getAttribute("aria-label")).toBe("Dictate");
  });

  it("keeps what was typed, and stays on when released before the mic came on", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const box = await openChat();
    fireEvent.change(box, { target: { value: "Remind me" } });
    // Held through the browser's permission prompt: the mic isn't on yet.
    press(2000);
    release();
    const r = last();
    expect(r.stopped).toBe(false);
    r.hear();
    r.say([["tomorrow at 9", false]]);
    expect(box.value).toBe("Remind me tomorrow at 9");

    // Typing in between isn't overwritten by what comes next.
    fireEvent.change(box, { target: { value: "Remind me tomorrow at 9 to" } });
    r.say(
      [
        ["tomorrow at 9", true],
        [" call Jo", false],
      ],
      1,
    );
    expect(box.value).toBe("Remind me tomorrow at 9 to call Jo");
    press(50);
    release();
    expect(r.stopped).toBe(true);
  });

  it("stops listening when the message is sent, and drops what's still coming", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const box = await openChat();
    press(100);
    release();
    const r = last();
    r.hear();
    r.say([["what's on my calendar", false]]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(posts).toEqual([
        {
          path: "/api/conversations/cnv_1/messages",
          body: { text: "what's on my calendar", clientId: expect.any(String) },
        },
      ]),
    );
    expect(r.aborted).toBe(true);
    await waitFor(() => expect(box.value).toBe(""));
    r.say([["what's on my calendar today", true]]);
    r.end();
    expect(box.value).toBe("");
    expect(mic().getAttribute("aria-label")).toBe("Dictate");
  });

  it("says when the microphone can't be used, and not when nothing was said", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    await openChat();
    press(100);
    release();
    last().fail("no-speech");
    last().end();
    expect(screen.queryByText(/microphone/i)).toBeNull();

    press(100);
    release();
    last().fail("not-allowed");
    last().end();
    expect(await screen.findByText("Microphone access is blocked.")).toBeTruthy();
    expect(mic().getAttribute("aria-label")).toBe("Dictate");

    // The next try clears it.
    press(100);
    expect(screen.queryByText("Microphone access is blocked.")).toBeNull();
  });

  it("toggles with the keyboard", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    await openChat();
    fireEvent.click(mic(), { detail: 0 });
    const r = last();
    expect(r.started).toBe(true);
    fireEvent.click(mic(), { detail: 0 });
    expect(r.stopped).toBe(true);
    // A pointer's click is handled by the press, not again here.
    r.end();
    fireEvent.click(mic(), { detail: 1 });
    expect(FakeRecognition.all).toHaveLength(1);
  });

  it("stops when the page goes away", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    await openChat();
    press(100);
    release();
    cleanup();
    expect(last().aborted).toBe(true);
  });
});

describe("joining what was said", () => {
  it("puts one space between what was typed and what was said", () => {
    expect(joinSpoken("", " hello ")).toBe("hello");
    expect(joinSpoken("Remind me", "tomorrow")).toBe("Remind me tomorrow");
    expect(joinSpoken("Remind me ", " tomorrow")).toBe("Remind me tomorrow");
    expect(joinSpoken("Remind me\n", "tomorrow")).toBe("Remind me\ntomorrow");
    expect(joinSpoken("Remind me", "  ")).toBe("Remind me");
  });
});
