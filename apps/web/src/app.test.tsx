// @vitest-environment happy-dom
import type { ConversationView, RunnerView, TaskView } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";

const runner: RunnerView = {
  id: "rnr_1",
  name: "devbox",
  online: true,
  lastSeenAt: new Date().toISOString(),
  version: "0.1.0",
  os: "macos",
  arch: "aarch64",
  hostname: "devbox.local",
  capabilities: [{ name: "coding.codex", version: "0.166.0", ready: true, detail: "" }],
  maxMode: "full-access",
  maxConcurrentTasks: 2,
  pairedAt: new Date().toISOString(),
  revokedAt: null,
  repos: [
    {
      id: "rpo_1",
      name: "site",
      defaultBranch: "main",
      remoteUrl: "git@github.com:a/site.git",
      network: false,
      remoteKey: "github.com/a/site",
    },
  ],
  labels: ["os:macos", "arch:aarch64"],
  ephemeral: false,
  sandboxId: null,
};

const conversation: ConversationView = {
  id: "cnv_1",
  title: "Fix the footer",
  mode: "supervised",
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:05:00.000Z",
};

const task: TaskView = {
  id: "tsk_1",
  conversationId: "cnv_1",
  runnerId: "rnr_1",
  runnerName: "devbox",
  harness: "codex",
  environment: { kind: "machine", sandboxId: null, sandboxState: null, providerName: null },
  routing: null,
  repoName: "site",
  title: "Make footer year dynamic",
  objective: "Use the current year.",
  mode: "supervised",
  deliver: "pr",
  state: "succeeded",
  branch: "sling/abc123-make-footer-year-dynamic",
  commitSha: "0123456789abcdef",
  diffStats: { filesChanged: 2, insertions: 14, deletions: 1 },
  summary: "Footer now uses the current year. Tests pass.",
  error: null,
  harnessVersion: "0.166.0",
  runnerOffline: false,
  cancelRequested: false,
  createdAt: "2026-11-05T10:01:00.000Z",
  startedAt: "2026-11-05T10:01:01.000Z",
  finishedAt: "2026-11-05T10:03:00.000Z",
  actions: [
    {
      id: "act_1",
      taskId: "tsk_1",
      kind: "push",
      state: "awaiting_approval",
      requiresApproval: true,
      url: null,
      message: null,
      approvalId: "apv_1",
    },
    {
      id: "act_2",
      taskId: "tsk_1",
      kind: "open_pr",
      state: "awaiting_approval",
      requiresApproval: true,
      url: null,
      message: null,
      approvalId: "apv_2",
    },
  ],
};

let signedIn = true;
let hasModel = false;

function routes(path: string): unknown {
  if (path === "/api/status")
    return { needsSetup: false, signedIn, email: "a@b.c", version: "0.1.0" };
  if (path === "/api/conversations") return [conversation];
  if (path === "/api/approvals") return [];
  if (path === "/api/runners") return [runner];
  if (path === "/api/settings") {
    return {
      defaultMode: "auto",
      modes: ["read-only", "supervised", "auto", "full-access"],
      providers: [{ id: "openai", label: "OpenAI", needsBaseUrl: false, defaultModel: "gpt-5.1" }],
      model: hasModel
        ? { provider: "openai", model: "gpt-5.1", baseUrl: null, hasKey: true }
        : null,
    };
  }
  if (path === "/api/conversations/cnv_1") {
    return {
      conversation,
      messages: [
        {
          id: "msg_1",
          conversationId: "cnv_1",
          role: "user",
          text: "The footer year is wrong.",
          taskIds: [],
          createdAt: "2026-11-05T10:00:30.000Z",
        },
        {
          id: "msg_2",
          conversationId: "cnv_1",
          role: "assistant",
          text: "Started a task on **devbox**.",
          taskIds: [],
          createdAt: "2026-11-05T10:01:30.000Z",
        },
      ],
      tasks: [task],
      agentStatus: "idle",
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  }
  throw new Error(`unmocked ${path}`);
}

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  send() {}
  close() {}
}

beforeEach(() => {
  signedIn = true;
  hasModel = false;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      return new Response(JSON.stringify(routes(url.pathname)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
}

describe("web app", () => {
  it("sends signed-out visitors to the login page", async () => {
    signedIn = false;
    renderAt("/");
    expect(await screen.findByText("Sign in to Sling")).toBeTruthy();
  });

  it("asks for a model before the first conversation", async () => {
    renderAt("/");
    expect(await screen.findByText("Connect a model")).toBeTruthy();
    expect(screen.getAllByText("Fix the footer").length).toBeGreaterThan(0);
  });

  it("shows a conversation with its task card and approval buttons", async () => {
    hasModel = true;
    renderAt("/c/cnv_1");
    expect(await screen.findByText("The footer year is wrong.")).toBeTruthy();
    expect(screen.getByText("Make footer year dynamic")).toBeTruthy();
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.getByText(/Approve push branch and open pull request/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("devbox")).toBeTruthy());
  });

  it("lists machines with their repos", async () => {
    renderAt("/machines");
    expect(await screen.findByText("devbox")).toBeTruthy();
    expect(screen.getByText("site")).toBeTruthy();
    expect(screen.getByText(/Codex 0.166.0/)).toBeTruthy();
  });
});
