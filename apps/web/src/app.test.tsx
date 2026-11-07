// @vitest-environment happy-dom
import type { ConversationView, RunnerView, TaskView } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      deployCommand: "",
    },
  ],
  labels: ["os:macos", "arch:aarch64"],
  ephemeral: false,
  sandboxId: null,
  foundRepos: [
    {
      path: "/Users/me/code/api",
      name: "api",
      defaultBranch: "main",
      remoteUrl: "git@github.com:a/api.git",
    },
    {
      path: "/Users/me/code/web",
      name: "web",
      defaultBranch: "main",
      remoteUrl: "git@github.com:a/web.git",
    },
  ],
  remoteRepos: true,
  deploys: true,
};

const conversation: ConversationView = {
  id: "cnv_1",
  title: "Fix the footer",
  mode: "supervised",
  settings: { assistant: null, agent: null },
  personalityId: null,
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
  remoteKey: null,
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
  model: null,
  effort: null,
  fast: false,
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
      targetId: null,
      targetName: null,
      ranOn: null,
      commitSha: null,
      output: null,
      verify: null,
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
      targetId: null,
      targetName: null,
      ranOn: null,
      commitSha: null,
      output: null,
      verify: null,
    },
  ],
};

let signedIn = true;
let publicUrl = "";
let posts: { method: string; path: string; body: unknown }[] = [];
let hasModel = false;
let runners: RunnerView[] = [];

function routes(path: string): unknown {
  if (path === "/api/status")
    return { needsSetup: false, signedIn, email: "a@b.c", version: "0.1.0", publicUrl };
  if (path === "/api/conversations") return [conversation];
  if (path === "/api/approvals") return [];
  if (path === "/api/runners") return runners;
  if (path === "/api/sandbox-repos") return [];
  if (path === "/api/runners/enrollments") {
    return {
      code: "ABCD-1234",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      command: "sling-runner pair http://localhost ABCD-1234",
      installCommand: "curl -fsSL http://localhost/install.sh | SLING_CODE=ABCD-1234 sh",
      windowsInstallCommand: "$env:SLING_CODE='ABCD-1234'; irm http://localhost/install.ps1 | iex",
    };
  }
  if (/^\/api\/runners\/rnr_\d\//.test(path)) return { ok: true, message: "Allowed api." };
  if (path === "/api/installations" || path === "/api/connectors") return [];
  if (path === "/api/models" || path === "/api/tasks" || path === "/api/sandboxes") return null;
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

function emit(ev: unknown) {
  act(() => socket?.onmessage?.({ data: JSON.stringify(ev) }));
}

beforeEach(() => {
  posts = [];
  signedIn = true;
  publicUrl = window.location.origin;
  hasModel = false;
  runners = [runner];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      posts.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ?? null });
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

  it("sends a visitor at another address to the one Sling is set up for", async () => {
    signedIn = false;
    publicUrl = "https://sling.tail1234.ts.net";
    renderAt("/login");
    expect(await screen.findByText("Open Sling at its address")).toBeTruthy();
    const go = screen.getByRole("link", { name: "Go to sling.tail1234.ts.net" });
    expect(go.getAttribute("href")?.startsWith("https://sling.tail1234.ts.net/")).toBe(true);
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("asks for a logged-in coding agent before the first conversation", async () => {
    renderAt("/");
    expect(await screen.findByText("Log in to a coding agent")).toBeTruthy();
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
    expect(screen.getByText("0.166.0")).toBeTruthy();
  });

  it("pairs a machine a step at a time: what it runs, the command, then its repos", async () => {
    renderAt("/machines?pair=true");
    const d = within(await screen.findByRole("dialog", { name: "Add a machine" }));
    expect(d.getByRole("heading", { name: "What does the machine run?" })).toBeTruthy();
    // The command for the system picked.
    fireEvent.click(d.getByRole("radio", { name: /Windows/ }));
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    expect(await d.findByText(/irm http:\/\/localhost\/install\.ps1/)).toBeTruthy();
    fireEvent.click(d.getByRole("button", { name: "Back" }));
    fireEvent.click(d.getByRole("radio", { name: /macOS or Linux/ }));
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    expect(
      await d.findByText("curl -fsSL http://localhost/install.sh | SLING_CODE=ABCD-1234 sh"),
    ).toBeTruthy();
    // Nothing to continue to until the machine connects.
    expect(d.getByText(/Waiting for the machine/)).toBeTruthy();
    const next = () =>
      d.getByRole("button", { name: /Continue|Allow|Finish/ }) as HTMLButtonElement;
    expect(next().disabled).toBe(true);

    const studio: RunnerView = {
      ...runner,
      id: "rnr_2",
      name: "studio",
      repos: [],
      capabilities: [{ name: "coding.claude-code", version: "2.1.0", ready: true, detail: "" }],
    };
    runners = [runner, studio];
    emit({ type: "runner.updated", runner: studio });
    expect(await d.findByText("studio is connected, with Claude Code ready.")).toBeTruthy();
    fireEvent.click(next());

    expect(d.getByRole("heading", { name: "Which repos may it work in?" })).toBeTruthy();
    const repos = within(d.getByRole("group", { name: "Repos" }));
    expect(repos.getAllByRole("checkbox").map((c) => c.textContent)).toEqual([
      "api/Users/me/code/api",
      "web/Users/me/code/web",
    ]);
    expect(next().textContent).toBe("Finish");
    fireEvent.click(repos.getByRole("checkbox", { name: /web/ }));
    expect(next().textContent).toBe("Allow 1 repo");
    fireEvent.click(next());
    await waitFor(() =>
      expect(
        posts.find((p) => p.method === "POST" && p.path === "/api/runners/rnr_2/repos")?.body,
      ).toBe(JSON.stringify({ path: "/Users/me/code/web" })),
    );
    expect(await d.findByText("studio is ready")).toBeTruthy();
    expect(d.getByText("Works in 1 repo · Claude Code ready")).toBeTruthy();
  });

  it("allows a repo the machine found, in place", async () => {
    renderAt("/machines");
    const list = within(await screen.findByRole("list", { name: "Repo list for devbox" }));
    const names = () =>
      list.getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent);
    // Allowed first, then the rest, by name.
    expect(names()).toEqual(["site", "api", "web"]);
    fireEvent.click(list.getByRole("switch", { name: "Allow api" }));
    await waitFor(() =>
      expect(
        posts.find((p) => p.method === "POST" && p.path === "/api/runners/rnr_1/repos")?.body,
      ).toBe(JSON.stringify({ path: "/Users/me/code/api" })),
    );
    // The switch flips where it is and waits there for the machine.
    const api = list.getByRole("switch", { name: "Stop allowing api" });
    expect(api.getAttribute("aria-checked")).toBe("true");
    expect(names()).toEqual(["site", "api", "web"]);
  });

  it("allows every found repo at once, after asking", async () => {
    renderAt("/machines");
    fireEvent.click(await screen.findByRole("button", { name: "Allow all" }));
    const dialog = await screen.findByRole("dialog", { name: "Allow 2 repos on devbox?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow 2 repos" }));
    await waitFor(() =>
      expect(
        posts.find((p) => p.method === "POST" && p.path === "/api/runners/rnr_1/repos")?.body,
      ).toBe(JSON.stringify({ paths: ["/Users/me/code/api", "/Users/me/code/web"] })),
    );
  });

  it("collapses the sidebar and remembers it", async () => {
    localStorage.removeItem("sling.sidebar");
    renderAt("/");
    fireEvent.click(await screen.findByRole("button", { name: "Hide sidebar" }));
    expect(screen.getByRole("button", { name: "Show sidebar" })).toBeTruthy();
    expect(localStorage.getItem("sling.sidebar")).toBe("collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();
    expect(localStorage.getItem("sling.sidebar")).toBe("open");
  });
});
