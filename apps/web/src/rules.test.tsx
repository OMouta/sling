// @vitest-environment happy-dom
import type {
  AllowRuleView,
  ApprovalView,
  ConversationStartedBy,
  MessageView,
  RuleOfferView,
  RuleView,
  ServerEvent,
  StartRuleView,
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

const allowRule: AllowRuleView = {
  id: "rul_1",
  kind: "allow",
  summary: "Email to anyone at acme.com",
  action: "email.send",
  installationId: "ins_1",
  installationName: "Work",
  match: { to: "*@acme.com" },
  createdFrom: { approvalId: "cap_1", conversationId: "cnv_1" },
  uses: 3,
  lastUsedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  revokedAt: null,
  createdAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:00:00.000Z",
};

const startRule: StartRuleView = {
  id: "rul_2",
  kind: "start",
  summary: "When Website goes down, Incident investigates",
  checkId: "chk_1",
  checkName: "Website",
  on: "down",
  personalityId: "per_2",
  message: "{check} went down. Find out why.",
  mode: "auto",
  createdFrom: { approvalId: null, conversationId: null },
  uses: 0,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: "2026-11-07T11:00:00.000Z",
  updatedAt: "2026-11-07T11:00:00.000Z",
};

const offer = (streak: number): RuleOfferView => ({
  summary: "Email to anyone at acme.com",
  rule: {
    kind: "allow",
    action: "email.send",
    installationId: "ins_1",
    match: { to: "*@acme.com" },
    conversationId: "cnv_1",
  },
  streak,
});

let rules: RuleView[] = [];
let approvals: ApprovalView[] = [];
let startedBy: ConversationStartedBy | null = null;
let messages: MessageView[] = [];
let calls: { method: string; path: string; body: unknown }[] = [];

function route(path: string): unknown {
  switch (path) {
    case "/api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "/api/conversations/cnv_1":
      return {
        conversation: {
          id: "cnv_1",
          title: "Website went down",
          mode: "auto",
          settings: { assistant: null, agent: null },
          personalityId: null,
          startedBy,
          createdAt: "2026-11-05T10:00:00.000Z",
          updatedAt: "2026-11-05T10:01:00.000Z",
        },
        personality: null,
        messages,
        tasks: [],
        agentStatus: "thinking",
        live: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    case "/api/rules":
      return rules;
    case "/api/approvals":
      return approvals;
    case "/api/conversations":
    case "/api/runners":
    case "/api/deploy-targets":
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
  rules = [];
  approvals = [];
  startedBy = null;
  messages = [];
  calls = [];
  socket = null;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        calls.push({ method, path: url.pathname, body: JSON.parse(String(init?.body ?? "null")) });
        const revoked = /^\/api\/rules\/(.+)$/.exec(url.pathname);
        if (method === "DELETE" && revoked) {
          const r = rules.find((x) => x.id === revoked[1]);
          rules = rules.filter((x) => x.id !== revoked[1]);
          return Response.json({ ...r, revokedAt: new Date().toISOString() });
        }
        if (method === "POST" && url.pathname === "/api/rules") {
          return Response.json({ ...allowRule, id: `rul_${calls.length}` });
        }
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

function open(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
  return router;
}

function sendStep(streak: number) {
  emit({ type: "agent.status", conversationId: "cnv_1", status: "thinking" });
  emit({
    type: "agent.tool",
    conversationId: "cnv_1",
    step: {
      kind: "tool",
      id: "t1",
      name: "email_send",
      input: { to: "bo@acme.com", subject: "Invoice", text: "Attached." },
      status: "running",
      output: null,
      approval: {
        id: "cap_9",
        kind: "send",
        state: "pending",
        machine: "",
        summary: "Email bo@acme.com: Invoice",
        ruleOffer: offer(streak),
      },
    },
  });
}

describe("Always allow on a send", () => {
  it("shows the rule it would make, then saves it and allows this one", async () => {
    open("/c/cnv_1");
    await screen.findAllByText("Thinking");
    sendStep(0);
    expect(screen.getByText("Allow this?")).toBeTruthy();
    expect(screen.queryByText(/You've allowed this/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    // Nothing is saved until it's confirmed.
    expect(calls).toEqual([]);
    expect(screen.getByText("New rule")).toBeTruthy();
    expect(screen.getByText("Email to anyone at acme.com")).toBeTruthy();
    expect(screen.queryByText("Allow this?")).toBeNull();
    // Back goes back to the question.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Allow this?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { method: "POST", path: "/api/rules", body: { ...offer(0).rule, approvalId: "cap_9" } },
      {
        method: "POST",
        path: "/api/conversations/cnv_1/commands/cap_9",
        body: { decision: "approve" },
      },
    ]);
    emit({ type: "agent.status", conversationId: "cnv_1", status: "idle" });
  });

  it("says when it was allowed five times in a row", async () => {
    open("/c/cnv_1");
    await screen.findAllByText("Thinking");
    sendStep(5);
    expect(screen.getByText("You've allowed this 5 times")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Always allow" })).toHaveLength(1);
    emit({ type: "agent.status", conversationId: "cnv_1", status: "idle" });
  });

  it("still says Always allow made a rule once the reply is saved", async () => {
    rules = [{ ...allowRule, createdFrom: { approvalId: "cap_9", conversationId: "cnv_1" } }];
    messages = [
      {
        id: "msg_1",
        conversationId: "cnv_1",
        role: "assistant",
        text: "Sent.",
        taskIds: [],
        attachments: [],
        personalityId: null,
        research: false,
        feedback: null,
        replaceable: false,
        createdAt: "2026-11-07T10:01:00.000Z",
        trace: {
          ms: 1000,
          steps: [
            {
              kind: "tool",
              id: "t1",
              name: "email_send",
              input: { to: "bo@acme.com" },
              status: "done",
              output: "{}",
              approval: {
                id: "cap_9",
                kind: "send",
                state: "approved",
                machine: "",
                summary: "Email bo@acme.com: Invoice",
                ruleOffer: offer(0),
              },
            },
          ],
        },
      },
    ];
    open("/c/cnv_1");
    expect(await screen.findByText("always allowed")).toBeTruthy();
  });

  it("says when a rule let a send through", async () => {
    open("/c/cnv_1");
    await screen.findAllByText("Thinking");
    emit({ type: "agent.status", conversationId: "cnv_1", status: "thinking" });
    emit({
      type: "agent.tool",
      conversationId: "cnv_1",
      step: {
        kind: "tool",
        id: "t2",
        name: "email_send",
        input: { to: "bo@acme.com" },
        status: "done",
        output: "{}",
        approval: {
          id: "rule_t2",
          kind: "send",
          state: "approved",
          machine: "",
          summary: "Email bo@acme.com: Invoice",
          allowedBy: { ruleId: "rul_1", summary: "Email to anyone at acme.com" },
        },
      },
    });
    const chip = screen.getByText("allowed by rule");
    expect(chip.closest("[title]")?.getAttribute("title")).toBe("Email to anyone at acme.com");
    expect(screen.queryByText("Allow this?")).toBeNull();
    emit({ type: "agent.status", conversationId: "cnv_1", status: "idle" });
  });
});

describe("Approvals → Rules", () => {
  it("lists the rules in force by kind, and revokes one", async () => {
    rules = [
      allowRule,
      startRule,
      { ...allowRule, id: "rul_3", revokedAt: "2026-11-07T12:00:00Z" },
    ];
    open("/approvals?tab=rules");
    const allowed = within(await screen.findByRole("region", { name: "Allowed without asking" }));
    expect(allowed.getByText("Email to anyone at acme.com")).toBeTruthy();
    expect(allowed.getByText("Used 3 times, last 2 hours ago")).toBeTruthy();
    expect(allowed.getByRole("link", { name: "From a chat" }).getAttribute("href")).toBe(
      "/c/cnv_1",
    );
    // Revoked rules aren't listed.
    expect(allowed.getAllByRole("listitem")).toHaveLength(1);
    const starts = within(screen.getByRole("region", { name: "Starts work" }));
    expect(starts.getByText("When Website goes down, Incident investigates")).toBeTruthy();
    expect(starts.getByText("Hasn't started a chat yet")).toBeTruthy();

    fireEvent.click(allowed.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Allowed without asking" })).toBeNull(),
    );
    expect(calls).toEqual([{ method: "DELETE", path: "/api/rules/rul_1", body: null }]);
  });

  it("shows a rule made elsewhere as it arrives", async () => {
    open("/approvals?tab=rules");
    expect(await screen.findByText("No rules yet")).toBeTruthy();
    emit({ type: "rule.updated", rule: startRule });
    expect(await screen.findByText("When Website goes down, Incident investigates")).toBeTruthy();
  });

  it("offers Always allow on a push and PR, with both rules", async () => {
    const task = {
      title: "Fix the footer year",
      repoName: "site",
      runnerName: "laptop",
      branch: "sling/abc-footer",
      remoteUrl: "https://github.com/acme/site.git",
      diffStats: null,
      summary: null,
      conversationId: null,
    };
    const base = {
      kind: "task_action" as const,
      state: "pending" as const,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      createdAt: "2026-11-07T10:00:00.000Z",
      taskId: "tsk_1",
      task,
      prTitle: null,
      prBody: null,
      runId: null,
      payload: null,
    };
    const stepOffer = (summary: string, action: string, approvalId: string): RuleOfferView => ({
      summary,
      rule: {
        kind: "allow",
        action,
        installationId: null,
        match: { repo: "github.com/acme/site" },
        approvalId,
      },
      streak: 5,
    });
    approvals = [
      {
        ...base,
        id: "apv_1",
        title: "Push: Fix the footer year",
        actionId: "act_1",
        actionKind: "push",
        ruleOffer: stepOffer("Pushing task branches to acme/site", "push", "apv_1"),
      },
      {
        ...base,
        id: "apv_2",
        title: "Open PR: Fix the footer year",
        actionId: "act_2",
        actionKind: "open_pr",
        ruleOffer: stepOffer("Opening pull requests on acme/site", "open_pr", "apv_2"),
      },
    ];
    open("/approvals");
    expect(await screen.findByText("You've allowed this 5 times")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    expect(screen.getByText("New rules")).toBeTruthy();
    expect(screen.getByText("Pushing task branches to acme/site")).toBeTruthy();
    expect(screen.getByText("Opening pull requests on acme/site")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => [c.path, (c.body as { action?: string }).action ?? c.body])).toEqual([
      ["/api/rules", "push"],
      ["/api/rules", "open_pr"],
      ["/api/tasks/tsk_1/approval", { decision: "approve" }],
    ]);
  });
});

describe("a chat a rule started", () => {
  it("says which rule in its header, linking to the rules", async () => {
    startedBy = {
      kind: "rule",
      ruleId: "rul_2",
      checkId: "chk_1",
      checkName: "Website",
      on: "down",
    };
    rules = [startRule];
    open("/c/cnv_1");
    const link = await screen.findByRole("link", {
      name: "Started by your rule: When Website goes down, Incident investigates",
    });
    expect(link.getAttribute("href")).toBe("/approvals?tab=rules");
  });

  it("shows nothing for a chat a person started", async () => {
    open("/c/cnv_1");
    await screen.findAllByText("Thinking");
    expect(screen.queryByRole("link", { name: /Started by your rule/ })).toBeNull();
  });
});
