/**
 * Publishes to a random topic on ntfy.sh and receives it through the event
 * source and the trigger. ntfy.sh needs no account. Runs only with
 * SLING_LIVE_NTFY=1.
 */
import { randomBytes } from "node:crypto";
import type { NodeContext, SourceContext, SourceStatus, TriggerEvent } from "@sling/connector-sdk";
import { describe, expect, it } from "vitest";
import {
  connector,
  type NtfyConfig,
  type NtfyCredentials,
  type NtfyMessage,
} from "../src/index.ts";
import { publish } from "../src/publish.ts";
import { messageReceived } from "../src/trigger.ts";

const live = process.env.SLING_LIVE_NTFY === "1";
const log = { info() {}, warn() {}, error() {} };

async function until<T>(get: () => T | undefined, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!live)("ntfy.sh, live", () => {
  it("publishes a message and receives it through the source and trigger", async () => {
    const topic = `sling-live-${randomBytes(9).toString("hex")}`;
    const config: NtfyConfig = { server: "https://ntfy.sh", topics: [topic] };

    const tested = await connector.test({
      credentials: {},
      config,
      log,
      signal: AbortSignal.timeout(15_000),
    });
    expect(tested).toMatchObject({ ok: true });

    const emitted: { type: string; payload: unknown; dedupeKey?: string }[] = [];
    const statuses: SourceStatus[] = [];
    const state = new Map<string, string>();
    const controller = new AbortController();
    const ctx: SourceContext<NtfyCredentials, NtfyConfig> = {
      installationId: "ins_live",
      workspaceId: "ws_live",
      credentials: {},
      config,
      log,
      signal: controller.signal,
      emit: async (e) => {
        emitted.push(e);
      },
      state: {
        get: async (k) => state.get(k) ?? null,
        set: async (k, v) => {
          state.set(k, v);
        },
      },
      approvals: {
        decide: async () => ({ ok: false, message: "unused" }),
        reportRefused: async () => {},
      },
      setStatus: (s) => {
        statuses.push(s);
      },
    };
    const source = await connector.source?.start(ctx);
    try {
      await until(() => (statuses.includes("connected") ? true : undefined), 15_000, "connected");

      const nodeCtx = {
        signal: AbortSignal.timeout(15_000),
        idempotencyKey: "live:publish:0",
        log,
        installation: async (id: string) => ({
          id,
          connectorId: "ntfy",
          name: "ntfy.sh",
          credentials: {},
          config,
        }),
      } as unknown as NodeContext;
      const result = await publish.run?.(nodeCtx, {
        inputs: {},
        config: {
          installationId: "ins_live",
          topic,
          message: "Sling live check",
          title: "Sling",
          priority: 2,
          tags: "white_check_mark",
          click: "",
          markdown: false,
        },
      });
      const id = String(result?.outputs?.id);
      expect(id).toMatch(/^\w+$/);

      const event = await until(
        () => emitted.find((e) => e.dedupeKey === id),
        15_000,
        "the published message",
      );
      const message = event.payload as NtfyMessage;
      expect(message).toMatchObject({
        id,
        topic,
        title: "Sling",
        message: "Sling live check",
        priority: 2,
        tags: ["white_check_mark"],
      });

      const triggerEvent: TriggerEvent = {
        type: event.type,
        workspaceId: "ws_live",
        installationId: "ins_live",
        payload: event.payload,
        at: new Date(),
      };
      expect(
        messageReceived.trigger?.match(triggerEvent, {
          installationId: "ins_live",
          topics: [topic],
          contains: "live check",
        }),
      ).toMatchObject({ outputs: { text: "Sling live check", topic } });
    } finally {
      controller.abort();
      await source?.stop();
    }
  }, 60_000);
});
