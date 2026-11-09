import type { CommandApprovalView, ReplyTrace, ToolStep } from "@sling/core";
import type { schema } from "@sling/db";
import { describe, expect, it } from "vitest";
import { hadSideEffect, replaceableIds } from "./replace.ts";

type MessageRow = typeof schema.messages.$inferSelect;

let seq = 0;
function row(role: MessageRow["role"], text: string, trace: ReplyTrace | null = null): MessageRow {
  seq++;
  return {
    id: `msg_${String(seq).padStart(4, "0")}`,
    workspaceId: "wsp_1",
    ownerId: "usr_1",
    conversationId: "cnv_1",
    role,
    content: { role, content: text },
    taskId: null,
    usage: null,
    trace,
    meta: null,
    clientId: null,
    createdAt: new Date(2026, 10, 7, 12, 0, seq),
  };
}

function tool(name: string, output: unknown, more: Partial<ToolStep> = {}): ToolStep {
  return {
    kind: "tool",
    id: `t_${name}`,
    name,
    input: {},
    status: "done",
    output: typeof output === "string" ? output : JSON.stringify(output),
    ...more,
  };
}

function approval(
  kind: CommandApprovalView["kind"],
  state: CommandApprovalView["state"],
): CommandApprovalView {
  return { id: "apr_1", kind, state, machine: "", summary: "Email ana@example.com" };
}

/** A chat whose latest reply did these steps. */
function chat(...steps: ToolStep[]) {
  const user = row("user", "Do it");
  const reply = row("assistant", "Done.", { steps, ms: 10 });
  return { rows: [row("user", "Hi"), row("assistant", "Hello."), user, reply], user, reply };
}

describe("what Retry and Edit may replace", () => {
  it("is the latest user message and its reply when the reply only talked", () => {
    const { rows, user, reply } = chat();
    expect(replaceableIds(rows)).toEqual(new Set([user.id, reply.id]));
  });

  it("allows tools that only read, or only touch memory", () => {
    const { rows, user, reply } = chat(
      tool("list_machines", []),
      tool("remember", { id: "mem_1", text: "Vegetarian" }),
      tool("web_search", { results: [] }),
      tool("calendar_list_events", { events: [] }),
    );
    const reads = new Set(["calendar_list_events"]);
    expect(replaceableIds(rows, { reads })).toEqual(new Set([user.id, reply.id]));
  });

  it("is nothing while the latest message has no reply", () => {
    const rows = [row("user", "Hi"), row("assistant", "Hello."), row("user", "Still there?")];
    expect(replaceableIds(rows).size).toBe(0);
  });

  it("is nothing when a note from Sling came after the message", () => {
    const { rows } = chat();
    expect(replaceableIds([...rows, row("system", "Task finished.")]).size).toBe(0);
  });

  it("still allows it after a notice that only told the person something", () => {
    const user = row("user", "Do it");
    const notice = {
      ...row("system", "Sling couldn't start a reply yet and keeps trying."),
      meta: { notice: true },
    };
    const reply = row("assistant", "Done.", { steps: [], ms: 10 });
    expect(replaceableIds([user, notice, reply])).toEqual(new Set([user.id, reply.id]));
  });

  it("is nothing when a task started since the message", () => {
    expect(replaceableIds(chat().rows, { taskStarted: true }).size).toBe(0);
  });

  it("finds a side effect in any message of the turn, not only the reply", () => {
    const user = row("user", "Do it");
    const step = row("assistant", "", {
      steps: [tool("delegate_coding_task", { taskId: "t" })],
      ms: 1,
    });
    const rows = [user, step, row("tool", ""), row("assistant", "Started.")];
    expect(replaceableIds(rows).size).toBe(0);
  });
});

describe("side effects", () => {
  it("a coding or deploy task it started", () => {
    expect(hadSideEffect(tool("delegate_coding_task", { taskId: "tsk_1", state: "queued" }))).toBe(
      true,
    );
    expect(hadSideEffect(tool("deploy_task", { taskId: "tsk_1", steps: [] }))).toBe(true);
    expect(hadSideEffect(tool("cancel_task", { ok: true }))).toBe(true);
  });

  it("not a task no machine could take", () => {
    const refused = { error: "No machine has the repo.", reasons: [], routing: {} };
    expect(hadSideEffect(tool("delegate_coding_task", refused))).toBe(false);
  });

  it("a send that was approved, allowed by a rule, or ran in Full access", () => {
    const sent = { installation: "Fastmail", output: { id: "m1" } };
    expect(
      hadSideEffect(tool("email_send", sent, { approval: approval("send", "approved") })),
    ).toBe(true);
    const ruled = { ...approval("send", "approved"), allowedBy: { ruleId: "r", summary: "x" } };
    expect(hadSideEffect(tool("email_send", sent, { approval: ruled }))).toBe(true);
    expect(hadSideEffect(tool("email_send", sent))).toBe(true);
  });

  it("a send that failed after it started", () => {
    expect(hadSideEffect(tool("email_send", { installation: "Fastmail", error: "SMTP 554" }))).toBe(
      true,
    );
    expect(hadSideEffect(tool("run_workflow", { status: "failed", error: "boom" }))).toBe(true);
  });

  it("not a send that was declined, expired, or refused", () => {
    const declined = { error: "The user declined." };
    expect(
      hadSideEffect(tool("email_send", declined, { approval: approval("send", "denied") })),
    ).toBe(false);
    expect(
      hadSideEffect(tool("email_send", declined, { approval: approval("send", "expired") })),
    ).toBe(false);
    expect(hadSideEffect(tool("email_send", { error: "This conversation is Read-only" }))).toBe(
      false,
    );
  });

  it("a setup change that was applied, and not one that was cancelled", () => {
    const applied = tool(
      "save_deploy_target",
      { applied: true },
      {
        approval: approval("change", "approved"),
      },
    );
    expect(hadSideEffect(applied)).toBe(true);
    const cancelled = tool(
      "save_deploy_target",
      { error: "Cancelled." },
      {
        approval: approval("change", "denied"),
      },
    );
    expect(hadSideEffect(cancelled)).toBe(false);
  });

  it("a command outside the sandbox, approved or in Full access", () => {
    const out = { machine: "devbox", sandboxed: false, exitCode: 0, output: "" };
    expect(
      hadSideEffect(tool("run_command", out, { approval: approval("command", "approved") })),
    ).toBe(true);
    expect(hadSideEffect(tool("run_command", out))).toBe(true);
  });

  it("not a command in the sandbox, or one that never ran", () => {
    const out = { machine: "devbox", sandboxed: true, exitCode: 0, output: "ok" };
    expect(hadSideEffect(tool("run_command", out))).toBe(false);
    expect(hadSideEffect(tool("run_command", { error: "devbox is offline." }))).toBe(false);
    expect(
      hadSideEffect(
        tool(
          "run_command",
          { error: "The user declined." },
          {
            approval: approval("command", "denied"),
          },
        ),
      ),
    ).toBe(false);
  });

  it("anything it can't tell: a tool that threw, or one still running when the turn stopped", () => {
    expect(hadSideEffect(tool("email_send", "socket hang up", { status: "error" }))).toBe(true);
    expect(hadSideEffect(tool("save_rule", null, { status: "running", output: null }))).toBe(true);
    expect(hadSideEffect(tool("run_command", "timeout", { status: "error" }))).toBe(true);
  });
});
