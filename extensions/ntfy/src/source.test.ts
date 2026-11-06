import type { SourceContext, SourceStatus, TriggerEvent } from "@sling/connector-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { authParam, subscribeUrl } from "./client.ts";
import type { NtfyConfig, NtfyCredentials, NtfyMessage } from "./schemas.ts";
import { createNtfySource, SINCE_KEY, type SocketLike } from "./source.ts";
import { messageReceived } from "./trigger.ts";

type Listener = (event: never) => void;

/** A WebSocket the test drives by hand. */
class FakeSocket implements SocketLike {
  readonly url: string;
  readonly listeners = new Map<string, Listener[]>();
  closed: { code?: number; reason?: string } | null = null;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(type: string, event: unknown = {}) {
    for (const l of this.listeners.get(type) ?? []) l(event as never);
  }

  open() {
    this.fire("open");
    this.send({ id: "o1", time: 1, event: "open", topic: "a" });
  }

  send(data: unknown) {
    this.fire("message", { data: JSON.stringify(data) });
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.fire("close", { code: code ?? 1005, reason: reason ?? "" });
  }

  drop(code = 1006) {
    this.fire("error", { message: "connection reset" });
    this.fire("close", { code, reason: "" });
  }
}

const wire = (id: string, time: number, topic = "alerts", extra: Record<string, unknown> = {}) => ({
  id,
  time,
  event: "message",
  topic,
  message: `text ${id}`,
  ...extra,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops) await s();
  stops = [];
});

function harness(config: Partial<NtfyConfig> = {}, credentials: NtfyCredentials = {}) {
  const sockets: FakeSocket[] = [];
  const emitted: { type: string; payload: NtfyMessage; dedupeKey?: string }[] = [];
  const statuses: [SourceStatus, string | undefined][] = [];
  const warnings: { message: string; data?: Record<string, unknown> }[] = [];
  const state = new Map<string, string>();
  const controller = new AbortController();
  const ctx: SourceContext<NtfyCredentials, NtfyConfig> = {
    installationId: "ins_1",
    workspaceId: "ws_1",
    credentials,
    config: { server: "https://ntfy.example.com", topics: ["alerts", "deploys"], ...config },
    log: { info() {}, warn: (message, data) => warnings.push({ message, data }), error() {} },
    signal: controller.signal,
    emit: async (e) => {
      emitted.push(e as (typeof emitted)[number]);
    },
    state: {
      get: async (k) => state.get(k) ?? null,
      set: async (k, v) => {
        state.set(k, v);
      },
    },
    approvals: {
      decide: async () => ({ ok: false, message: "no" }),
      reportRefused: async () => {},
    },
    setStatus: (s, d) => {
      statuses.push([s, d]);
    },
  };
  const source = createNtfySource({
    connect: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    backoff: { initialMs: 5, maxMs: 20 },
    silenceMs: 200,
  });
  return {
    sockets,
    emitted,
    statuses,
    warnings,
    state,
    async start() {
      const running = await source.start(ctx);
      stops.push(() => running.stop());
      return running;
    },
  };
}

describe("subscribe URL", () => {
  it("joins the topics and adds since and the token", () => {
    expect(subscribeUrl({ server: "https://ntfy.sh/" }, {}, ["a", "b"], null)).toBe(
      "wss://ntfy.sh/a,b/ws",
    );
    expect(
      subscribeUrl({ server: "http://ntfy.lan/base" }, { accessToken: "tk_x" }, ["a"], "1700"),
    ).toBe(`ws://ntfy.lan/base/a/ws?since=1700&auth=${authParam("tk_x")}`);
  });

  it("encodes the token the way ntfy reads it: URL-safe base64 without padding", () => {
    expect(authParam("tk_abc")).toBe("QmVhcmVyIHRrX2FiYw");
    expect(atob(authParam("tk_abc"))).toBe("Bearer tk_abc");
  });
});

describe("ntfy source", () => {
  it("emits each message in order, deduped by ID, and remembers the newest time", async () => {
    const h = harness();
    await h.start();
    const socket = h.sockets[0] as FakeSocket;
    expect(socket.url).toBe("wss://ntfy.example.com/alerts,deploys/ws");
    socket.open();
    expect(h.statuses.at(-1)).toEqual(["connected", "Watching alerts, deploys"]);
    socket.send({ id: "k", time: 2, event: "keepalive", topic: "alerts" });
    socket.send(wire("m1", 1_700_000_100, "alerts", { title: "Hi", tags: ["tada"], priority: 5 }));
    socket.send(wire("m2", 1_700_000_050, "deploys"));
    await until(() => h.emitted.length === 2);
    expect(h.emitted[0]).toEqual({
      type: "ntfy.message",
      dedupeKey: "m1",
      payload: {
        id: "m1",
        time: "2023-11-14T22:15:00.000Z",
        topic: "alerts",
        title: "Hi",
        message: "text m1",
        priority: 5,
        tags: ["tada"],
        click: null,
        attachment: null,
      },
    });
    expect(h.emitted[1]?.dedupeKey).toBe("m2");
    expect(h.state.get(SINCE_KEY)).toBe("1700000100");
  });

  it("reconnects with backoff after a drop, asking for what it missed", async () => {
    const h = harness({}, { accessToken: "tk_1" });
    await h.start();
    const first = h.sockets[0] as FakeSocket;
    first.open();
    first.send(wire("m1", 1_700_000_000));
    await until(() => h.state.get(SINCE_KEY) === "1700000000");
    first.drop();
    await until(() => h.sockets.length === 2);
    // A drop after the socket opened isn't an error, just a reconnect.
    expect(h.statuses.some(([s]) => s === "error")).toBe(false);
    expect(h.warnings).toContainEqual({
      message: "ntfy connection dropped",
      data: {
        where: "ntfy.example.com/alerts,deploys",
        error: "The connection to ntfy.example.com/alerts,deploys closed (1006, connection reset)",
      },
    });
    const second = h.sockets[1] as FakeSocket;
    expect(second.url).toContain("since=1700000000");
    expect(second.url).toContain(`auth=${authParam("tk_1")}`);
    second.open();
    expect(h.statuses.at(-1)?.[0]).toBe("connected");
  });

  it("reports a subscription that never opens, without the token", async () => {
    const h = harness({}, { accessToken: "tk_secret" });
    await h.start();
    (h.sockets[0] as FakeSocket).drop();
    await until(() => h.statuses.some(([s]) => s === "error"));
    const [, detail] = h.statuses.find(([s]) => s === "error") ?? [];
    expect(detail).toBe(
      "Couldn't subscribe to ntfy.example.com/alerts,deploys: connection reset. Check the server URL, the topics, and the access token.",
    );
    expect(detail).not.toContain("tk_secret");
    await until(() => h.sockets.length >= 2);
  });

  it("drops a connection that goes silent and opens a new one", async () => {
    const h = harness();
    await h.start();
    const first = h.sockets[0] as FakeSocket;
    first.open();
    await until(() => h.sockets.length === 2, 3000);
    expect(first.closed).toEqual({ code: 4000, reason: "silent" });
    expect(h.warnings.map((w) => w.data?.error)).toContain(
      "No message or keepalive from ntfy.example.com/alerts,deploys for 0 seconds",
    );
    expect(h.statuses.some(([s]) => s === "error")).toBe(false);
  });

  it("closes the socket on stop and doesn't reconnect", async () => {
    const h = harness();
    const running = await h.start();
    (h.sockets[0] as FakeSocket).open();
    await running.stop();
    expect(h.sockets[0]?.closed).toEqual({ code: 1000, reason: "stopping" });
    await tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.sockets).toHaveLength(1);
  });

  it("opens nothing without topics", async () => {
    const h = harness({ topics: [] });
    await h.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.statuses).toEqual([
      ["connected", "Not watching any topics. Add topics to start workflows from messages."],
    ]);
  });
});

describe("ntfy.message_received", () => {
  const message: NtfyMessage = {
    id: "m1",
    time: "2026-11-06T10:00:00.000Z",
    topic: "alerts",
    title: "Disk",
    message: "Disk almost full on web-1",
    priority: 4,
    tags: [],
    click: null,
    attachment: null,
  };
  const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
    type: "ntfy.message",
    workspaceId: "ws_1",
    installationId: "ins_1",
    payload: message,
    at: new Date(),
    ...over,
  });
  const match = (config: Record<string, unknown>, e = event()) =>
    messageReceived.trigger?.match(e, { installationId: "ins_1", ...config } as never);

  it("outputs the message and its parts, one topic at a time", () => {
    expect(match({})).toEqual({
      outputs: { message, text: message.message, title: "Disk", topic: "alerts" },
      concurrencyKey: "ntfy:ins_1:alerts",
    });
  });

  it("filters by installation, topic, and text", () => {
    expect(match({}, event({ installationId: "ins_2" }))).toBeNull();
    expect(match({ topics: ["deploys"] })).toBeNull();
    expect(match({ topics: ["deploys", "alerts"] })).not.toBeNull();
    expect(match({ contains: "FULL" })).not.toBeNull();
    expect(match({ contains: "disk" })).not.toBeNull();
    expect(match({ contains: "memory" })).toBeNull();
    expect(match({}, event({ type: "ntfy.other" }))).toBeNull();
    expect(match({}, event({ payload: { nope: true } }))).toBeNull();
  });
});
