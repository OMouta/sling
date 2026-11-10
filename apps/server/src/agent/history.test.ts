import type { schema } from "@sling/db";
import { describe, expect, it } from "vitest";
import { awaitsReply, inTurnOrder, toModelMessages } from "./history.ts";

type MessageRow = typeof schema.messages.$inferSelect;

function row(id: string, role: MessageRow["role"], text: string, meta: MessageRow["meta"] = null) {
  return {
    id,
    workspaceId: "wsp_1",
    ownerId: "usr_1",
    conversationId: "cnv_1",
    role,
    content: { role, content: text },
    taskId: null,
    usage: null,
    trace: null,
    meta,
    clientId: null,
    createdAt: new Date(2026, 10, 9),
  } satisfies MessageRow;
}

describe("what the model sees of a chat", () => {
  it("shows Sling's notes as marked context, and leaves out notices meant only for the person", () => {
    const sent = toModelMessages([
      row("msg_1", "user", "Deploy the site"),
      row("msg_2", "system", "Sling couldn't start a reply yet and keeps trying.", {
        notice: true,
      }),
      row("msg_3", "system", "Task Deploy: succeeded."),
    ]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ role: "user", content: "Deploy the site" });
    expect(String(sent[1]?.content)).toContain("Task Deploy: succeeded.");
  });
});

describe("a message sent while a reply was being written", () => {
  // msg_2 arrived while the turn that read up to msg_1 was still running.
  const rows = [
    row("msg_1", "user", "Run the slow command"),
    row("msg_2", "user", "What is 2+2?"),
    row("msg_3", "assistant", "It finished.", { seen: "msg_1" }),
  ];

  it("comes after that reply, and still waits for one", () => {
    expect(inTurnOrder(rows).map((r) => r.id)).toEqual(["msg_1", "msg_3", "msg_2"]);
    expect(awaitsReply(rows)).toBe(true);
  });

  it("is answered once the next turn, which read it, saves its reply", () => {
    const answered = [...rows, row("msg_4", "assistant", "4.", { seen: "msg_3" })];
    expect(inTurnOrder(answered).map((r) => r.id)).toEqual(["msg_1", "msg_3", "msg_2", "msg_4"]);
    expect(awaitsReply(answered)).toBe(false);
    const sent = toModelMessages(inTurnOrder(answered));
    expect(sent.map((m) => m.content)).toEqual([
      "Run the slow command",
      "It finished.",
      "What is 2+2?",
      "4.",
    ]);
  });

  it("keeps replies saved before turns recorded what they read in place", () => {
    const old = [row("msg_1", "user", "Hi"), row("msg_2", "assistant", "Hello.")];
    expect(inTurnOrder(old)).toEqual(old);
    expect(awaitsReply(old)).toBe(false);
    expect(awaitsReply([...old, row("msg_3", "system", "Task Fix: succeeded.")])).toBe(true);
  });

  it("doesn't count a notice meant only for the person", () => {
    const notice = row("msg_3", "system", "Sling couldn't start a reply yet.", { notice: true });
    expect(
      awaitsReply([row("msg_1", "user", "Hi"), row("msg_2", "assistant", "Hello."), notice]),
    ).toBe(false);
  });
});
