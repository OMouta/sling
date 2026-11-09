import type { schema } from "@sling/db";
import { describe, expect, it } from "vitest";
import { toModelMessages } from "./history.ts";

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
