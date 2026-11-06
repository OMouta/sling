import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, FrameError } from "../src/frames.mjs";
import { Peer } from "../src/peer.mjs";

describe("frames", () => {
  it("round-trips structured-clone values, split at any byte", () => {
    const messages = [
      { t: "q", id: 1, m: "run", p: { at: new Date(0), bytes: new Uint8Array([1, 2, 3]) } },
      { t: "n", m: "log", p: { message: "x".repeat(100_000) } },
      { t: "pong" },
    ];
    const bytes = Buffer.concat(messages.map((m) => encodeFrame(m)));
    for (const step of [1, 3, 4, 7, 1000, bytes.length]) {
      const d = new FrameDecoder();
      const out = [];
      for (let i = 0; i < bytes.length; i += step) out.push(...d.push(bytes.subarray(i, i + step)));
      expect(out).toHaveLength(3);
      expect(out[0].p.at).toEqual(new Date(0));
      expect([...out[0].p.bytes]).toEqual([1, 2, 3]);
      expect(out[1].p.message).toHaveLength(100_000);
      expect(out[2]).toEqual({ t: "pong" });
    }
  });

  it("refuses an oversized message from its header, before buffering it", () => {
    const d = new FrameDecoder(1024);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(2048);
    expect(() => d.push(header)).toThrow(FrameError);
    expect(() => encodeFrame({ s: "y".repeat(2048) }, 1024)).toThrow(/over the 1 MB limit/);
  });

  it("refuses values that can't be cloned", () => {
    expect(() => encodeFrame({ f: () => 1 })).toThrow();
  });
});

describe("peer", () => {
  function pair() {
    /** @type {Peer} */ let a;
    /** @type {Peer} */ let b;
    const handlers = {
      a: async (/** @type {string} */ m, /** @type {any} */ p, /** @type {AbortSignal} */ s) => ({
        m,
        p,
        aborted: s.aborted,
      }),
      b: async (/** @type {string} */ m, /** @type {any} */ p, /** @type {AbortSignal} */ s) => {
        if (m === "fail")
          throw Object.assign(new Error("nope"), {
            name: "NodeError",
            code: "x_y",
            retryable: true,
          });
        if (m === "wait")
          return new Promise((resolve) => s.addEventListener("abort", () => resolve("cancelled")));
        return { m, p };
      },
    };
    const notes = [];
    a = new Peer({
      send: (f) => queueMicrotask(() => b.handle(f)),
      onRequest: handlers.a,
      onNote: () => {},
      toError: (e) => e,
    });
    b = new Peer({
      send: (f) => queueMicrotask(() => a.handle(f)),
      onRequest: handlers.b,
      onNote: (m, p) => notes.push([m, p]),
      toError: (e) => e,
    });
    return { a, b, notes };
  }

  it("answers requests both ways, with errors as plain fields", async () => {
    const { a, b, notes } = pair();
    expect(await a.request("echo", { x: 1 })).toEqual({ m: "echo", p: { x: 1 } });
    expect(await b.request("echo", 2)).toEqual({ m: "echo", p: 2, aborted: false });
    await expect(a.request("fail", null)).rejects.toEqual({
      name: "NodeError",
      message: "nope",
      code: "x_y",
      retryable: true,
    });
    a.notify("log", { level: "info" });
    await Promise.resolve();
    expect(notes).toEqual([["log", { level: "info" }]]);
  });

  it("cancels a request on the other side when its signal aborts", async () => {
    const { a, b } = pair();
    const abort = new AbortController();
    const pending = a.request("wait", null, abort.signal);
    await new Promise((r) => setTimeout(r, 5));
    expect(b.incomingCount).toBe(1);
    abort.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    await new Promise((r) => setTimeout(r, 5));
    expect(b.incomingCount).toBe(0);
    expect(a.pendingCount).toBe(0);
  });

  it("fails everything in flight when the channel closes", async () => {
    const { a } = pair();
    const lost = new Peer({
      send: () => {},
      onRequest: async () => null,
      onNote: () => {},
      toError: (e) => e,
    });
    const pending = lost.request("x", null);
    lost.close(new Error("gone"));
    await expect(pending).rejects.toThrow("gone");
    expect(a.pendingCount).toBe(0);
  });
});
