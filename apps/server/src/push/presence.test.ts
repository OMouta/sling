import { describe, expect, it } from "vitest";
import type { AppContext } from "../context.ts";
import { clientEvent, Hub } from "../realtime/hub.ts";
import { PushService } from "./service.ts";

function service() {
  const ctx = {
    config: { secretKey: "x".repeat(48), publicUrl: new URL("http://localhost:8080") },
    hub: new Hub(),
  } as unknown as AppContext;
  return new PushService(ctx);
}

describe("presence", () => {
  it("knows which conversations a visible window shows, per user", () => {
    const push = service();
    push.presence("s1", "usr_a", { type: "presence", conversationId: "cnv_1", visible: true });
    push.presence("s2", "usr_a", { type: "presence", conversationId: "cnv_2", visible: false });
    expect(push.showing("usr_a", "cnv_1")).toBe(true);
    expect(push.showing("usr_a", "cnv_2")).toBe(false);
    expect(push.showing("usr_b", "cnv_1")).toBe(false);

    push.presence("s1", "usr_a", { type: "presence", conversationId: "cnv_1", visible: false });
    expect(push.showing("usr_a", "cnv_1")).toBe(false);
    push.presence("s1", "usr_a", { type: "presence", conversationId: "cnv_1", visible: true });
    push.socketClosed("s1");
    expect(push.showing("usr_a", "cnv_1")).toBe(false);
  });

  it("reads only well-formed presence messages from the socket", () => {
    expect(clientEvent('{"type":"presence","conversationId":"cnv_1","visible":true}')).toEqual({
      type: "presence",
      conversationId: "cnv_1",
      visible: true,
    });
    expect(clientEvent('{"type":"presence","conversationId":null,"visible":false}')).toEqual({
      type: "presence",
      conversationId: null,
      visible: false,
    });
    expect(clientEvent("ping")).toBeNull();
    expect(clientEvent('{"type":"presence","conversationId":"cnv_1"}')).toBeNull();
    expect(clientEvent('{"type":"presence","conversationId":5,"visible":true}')).toBeNull();
    expect(clientEvent('{"type":"other","visible":true}')).toBeNull();
    expect(
      clientEvent(`{"type":"presence","conversationId":"${"x".repeat(600)}","visible":true}`),
    ).toBeNull();
    expect(clientEvent("{not json")).toBeNull();
  });

  it("hears hub events even when no browser is open", () => {
    const hub = new Hub();
    const seen: string[] = [];
    hub.listen((ws, ev) => seen.push(`${ws}:${ev.type}`));
    hub.publish("wsp_1", { type: "agent.status", conversationId: "c", status: "idle" });
    expect(seen).toEqual(["wsp_1:agent.status"]);
  });
});
