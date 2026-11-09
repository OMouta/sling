import { EventEmitter } from "node:events";
import type { ServerEvent } from "@sling/core";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { Hub, MAX_BUFFERED_BYTES } from "./hub.ts";

function socket(bufferedAmount = 0) {
  return Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    bufferedAmount,
    send: vi.fn((_data, done) => done?.()),
    terminate: vi.fn(),
  });
}
const event = { type: "test" } as unknown as ServerEvent;
describe("bounded realtime fan-out", () => {
  it("drops a slow client while delivering to healthy clients", () => {
    const hub = new Hub();
    const slow = socket(MAX_BUFFERED_BYTES),
      fast = socket();
    hub.add("ws", slow as unknown as WebSocket);
    hub.add("ws", fast as unknown as WebSocket);
    hub.publish("ws", event);
    expect(slow.terminate).toHaveBeenCalledOnce();
    expect(slow.send).not.toHaveBeenCalled();
    expect(fast.send).toHaveBeenCalledOnce();
    fast.emit("close");
    slow.emit("close");
    expect(hub.connections).toBe(0);
    expect(hub.workspaces()).toEqual([]);
  });
  it("isolates failed listeners and throttles their diagnostics", () => {
    const error = vi.fn();
    const hub = new Hub(error);
    const fast = socket();
    hub.listen(() => {
      throw new Error("broken");
    });
    hub.add("ws", fast as unknown as WebSocket);
    hub.publish("ws", event);
    hub.publish("ws", event);
    expect(error).toHaveBeenCalledOnce();
    expect(fast.send).toHaveBeenCalledTimes(2);
  });
});
