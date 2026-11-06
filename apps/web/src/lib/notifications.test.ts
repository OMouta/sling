// @vitest-environment happy-dom
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readNewChatLink } from "./newChat.ts";
import { deviceLabel } from "./notifications.ts";
import { connectRealtime, setOpenConversation } from "./realtime.ts";
import { searchTimeZones, timeZoneOptions } from "./timezone.ts";

describe("device labels", () => {
  it("name the browser and the device", () => {
    const cases: [string, number, string][] = [
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1",
        5,
        "Safari on iPhone",
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15",
        5,
        "Safari on iPad",
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15",
        0,
        "Safari on Mac",
      ],
      [
        "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
        5,
        "Chrome on Android",
      ],
      [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
        0,
        "Edge on Windows",
      ],
      [
        "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
        0,
        "Firefox on Linux",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1",
        5,
        "Chrome on iPhone",
      ],
    ];
    for (const [ua, touch, label] of cases) expect(deviceLabel(ua, touch), ua).toBe(label);
  });
});

describe("new chat links", () => {
  it("read a draft and a personality, as the router parses them", () => {
    expect(readNewChatLink({ draft: "Site is down", personality: "incident" })).toEqual({
      draft: "Site is down",
      personality: "incident",
    });
    expect(readNewChatLink({ draft: 502 })).toEqual({ draft: "502", personality: null });
    expect(readNewChatLink({ personality: "  " })).toBeNull();
    expect(readNewChatLink({ draft: { not: "text" } })).toBeNull();
    expect(readNewChatLink({})).toBeNull();
  });
});

describe("time zone search", () => {
  it("matches every word, with slashes and underscores as spaces", () => {
    const all = timeZoneOptions();
    expect(all.some((o) => o.id === "UTC")).toBe(true);
    expect(searchTimeZones(all, "new york").map((o) => o.id)).toEqual(["America/New_York"]);
    expect(searchTimeZones(all, "europe/lis").map((o) => o.id)).toEqual(["Europe/Lisbon"]);
    expect(searchTimeZones(all, "").length).toBe(all.length);
    expect(searchTimeZones(all, "nowhere at all")).toEqual([]);
  });
});

describe("presence", () => {
  const sent: string[] = [];
  class Socket {
    static last: Socket | null = null;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    constructor() {
      Socket.last = this;
    }
    send(data: string) {
      sent.push(data);
    }
    close() {}
  }

  afterEach(() => vi.unstubAllGlobals());

  it("says what the window shows on connect, on a new chat, and when hidden", () => {
    vi.stubGlobal("WebSocket", Socket);
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    setOpenConversation("cnv_1");
    const stop = connectRealtime(new QueryClient());
    const socket = Socket.last as Socket;
    socket.readyState = 1;
    socket.onopen?.();
    const presence = () => sent.filter((s) => s.startsWith("{")).map((s) => JSON.parse(s));
    expect(presence()).toEqual([{ type: "presence", conversationId: "cnv_1", visible: true }]);

    setOpenConversation("cnv_2");
    setOpenConversation("cnv_2");
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    setOpenConversation(null);
    expect(presence().slice(1)).toEqual([
      { type: "presence", conversationId: "cnv_2", visible: true },
      { type: "presence", conversationId: "cnv_2", visible: false },
      { type: "presence", conversationId: null, visible: false },
    ]);
    stop();
  });
});
