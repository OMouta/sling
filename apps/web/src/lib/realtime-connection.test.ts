// @vitest-environment happy-dom
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectRealtime } from "./realtime.ts";

/** A socket the test opens, feeds, and closes by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** The server closing it, with its code. */
  drop(code: number) {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const latest = () => FakeSocket.all.at(-1) as FakeSocket;

let qc: QueryClient;
let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  qc = new QueryClient();
  vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the live connection", () => {
  it("pings while frames come in, and closes a socket that went quiet without a close", () => {
    stop = connectRealtime(qc);
    latest().open();
    vi.advanceTimersByTime(25_000);
    expect(latest().sent).toContain("ping");
    latest().onmessage?.({ data: JSON.stringify({ type: "pong" }) });
    vi.advanceTimersByTime(50_000);
    expect(latest().closed).toBe(false);

    // Nothing for more than a minute: the socket counts as dead and is replaced.
    vi.advanceTimersByTime(75_000);
    expect(FakeSocket.all[0]?.closed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("waits a random part of the backoff before reconnecting, so clients don't come back at once", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    stop = connectRealtime(qc);
    latest().open();
    latest().drop(1006);
    // Half the first second, at the low end of the spread.
    vi.advanceTimersByTime(499);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);

    // Each failure doubles the wait.
    latest().drop(1006);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it("refetches everything after it reconnects, and when the tab comes back", () => {
    stop = connectRealtime(qc);
    latest().open();
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
    latest().drop(1006);
    vi.advanceTimersByTime(1_000);
    latest().open();
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("stops reconnecting when the session is gone, and refetches so sign-in shows", () => {
    stop = connectRealtime(qc);
    latest().open();
    latest().drop(4401);
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("drops the socket when the device goes offline, and reconnects at once when it's back", () => {
    stop = connectRealtime(qc);
    latest().open();
    window.dispatchEvent(new Event("offline"));
    expect(FakeSocket.all[0]?.closed).toBe(true);
    window.dispatchEvent(new Event("online"));
    expect(FakeSocket.all).toHaveLength(2);
    latest().open();
    // Back after an outage: everything is refetched.
    expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("doesn't reconnect after it's stopped", () => {
    stop = connectRealtime(qc);
    latest().open();
    stop();
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});
