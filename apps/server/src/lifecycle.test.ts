import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHUTDOWN_MS,
  deadline,
  FORCED_EXIT_MARGIN_MS,
  type ProcessHost,
  serve,
} from "./lifecycle.ts";

type Signal = "SIGINT" | "SIGTERM";

function fakeHost() {
  const listeners = new Map<Signal, Array<() => void>>();
  const exits: number[] = [];
  const host: ProcessHost = {
    on: (signal, listener) => listeners.set(signal, [...(listeners.get(signal) ?? []), listener]),
    exit: (code) => exits.push(code),
    log: { info() {}, warn() {}, error() {}, fatal() {} },
  };
  const send = (signal: Signal) => {
    for (const listener of listeners.get(signal) ?? []) listener();
  };
  return { host, send, exits };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("serve", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("runs cleanup once however many signals arrive", async () => {
    const { host, send, exits } = fakeHost();
    let release!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    await serve(async () => ({ close }), host, 10_000);

    send("SIGTERM");
    send("SIGINT");
    send("SIGTERM");
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([]);

    release();
    await flush();
    expect(exits).toEqual([0]);
    send("SIGTERM");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
  });

  it("exits when cleanup outlasts the deadline", async () => {
    const { host, send, exits } = fakeHost();
    const close = vi.fn(() => new Promise<void>(() => {}));
    await serve(async () => ({ close }), host, 10_000);

    send("SIGTERM");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual([1]);
    send("SIGINT");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("exits non-zero when cleanup fails", async () => {
    const { host, send, exits } = fakeHost();
    await serve(async () => ({ close: () => Promise.reject(new Error("stuck")) }), host, 10_000);
    send("SIGINT");
    await flush();
    expect(exits).toEqual([1]);
  });

  it("exits non-zero when startup fails", async () => {
    const { host, exits } = fakeHost();
    await serve(() => Promise.reject(new Error("migration failed")), host, 10_000);
    expect(exits).toEqual([1]);
  });

  it("aborts a startup in progress on a signal", async () => {
    const { host, send, exits } = fakeHost();
    let seen: AbortSignal | undefined;
    const started = serve(
      (signal) => {
        seen = signal;
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      },
      host,
      10_000,
    );
    send("SIGTERM");
    await started;
    expect(seen?.aborted).toBe(true);
    expect(exits).toEqual([0]);
  });

  it("closes a server whose startup finished just after the signal", async () => {
    const { host, send, exits } = fakeHost();
    const close = vi.fn(async () => {});
    let finish!: () => void;
    const started = serve(
      () => new Promise((resolve) => (finish = () => resolve({ close }))),
      host,
      10_000,
    );
    send("SIGTERM");
    finish();
    await started;
    expect(close).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([0]);
  });
});

describe("deadline", () => {
  it("never reports negative time", () => {
    expect(deadline(-5).left()).toBe(0);
    expect(deadline(1_000).left()).toBeLessThanOrEqual(1_000);
  });
});

it("leaves room for the forced exit inside the Compose stop grace period", () => {
  const compose = readFileSync(
    new URL("../../../deploy/docker-compose.yml", import.meta.url),
    "utf8",
  );
  const match = compose.match(/stop_grace_period: \$\{SLING_STOP_GRACE_PERIOD:-(\d+)s\}/);
  expect(match).not.toBeNull();
  const graceMs = Number(match?.[1]) * 1000;
  // A few seconds for the process to exit after its forced exit, before Docker kills it.
  expect(graceMs).toBeGreaterThanOrEqual(DEFAULT_SHUTDOWN_MS + FORCED_EXIT_MARGIN_MS + 5_000);
});
