import { defineConnector, defineExtension, defineNode } from "@sling/connector-sdk";
import { NodeError } from "@sling/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NodeRegistry } from "../workflows/registry.ts";
import { DISABLED_CODE, schemaFromJson, standInConnectors } from "./disabled.ts";

const ext = defineExtension({
  connectors: [
    defineConnector({
      id: "chat",
      name: "Chat",
      description: "Chat.",
      setupHelp: "Get a token.",
      credentialsSchema: z.object({ token: z.string().min(1).describe("Token.") }),
      secretFields: ["token"],
      configSchema: z.object({ server: z.url().describe("Server.") }),
      test: async () => ({ ok: true }),
      nodes: [
        defineNode({
          type: "chat.message",
          version: 1,
          title: "Message",
          description: "A message.",
          category: "trigger",
          configSchema: z.object({ installationId: z.string().describe("Installation.") }),
          installationFields: ["installationId"],
          inputs: [],
          outputs: [{ name: "text", type: "string" }],
          execInput: false,
          execOutputs: [{ name: "next" }],
          idempotent: true,
          trigger: { event: "chat.message", match: () => ({ outputs: {} }) },
        }),
        defineNode({
          type: "chat.ask",
          version: 2,
          title: "Ask",
          description: "Asks and waits.",
          category: "action",
          configSchema: z.object({
            installationId: z.string().describe("Installation."),
            retries: z.number().int().default(3).describe("Retries."),
          }),
          installationFields: ["installationId"],
          expressionFields: ["installationId"],
          inputs: [],
          outputs: [],
          execInput: true,
          execOutputs: [{ name: "next" }, { name: "timeout" }],
          idempotent: false,
          retry: { maxAttempts: 2, backoffMs: 10 },
          run: async () => ({ exec: "next" }),
          resume: async () => ({ exec: "next" }),
        }),
      ],
      source: { start: async () => ({ stop: async () => {} }) },
    }),
  ],
});

describe("standInConnectors", () => {
  const [chat] = standInConnectors(ext.describe());
  if (!chat) throw new Error("no stand-in");

  it("keeps the connector's shape, without its source or provider", () => {
    expect(chat).toMatchObject({
      id: "chat",
      name: "Chat",
      setupHelp: "Get a token.",
      secretFields: ["token"],
    });
    expect(chat.source).toBeUndefined();
    expect(chat.executionProvider).toBeUndefined();
    expect(chat.nodes.map((n) => [n.type, n.version, n.connector])).toEqual([
      ["chat.message", 1, "chat"],
      ["chat.ask", 2, "chat"],
    ]);
    const ask = chat.nodes[1];
    expect(ask).toMatchObject({
      installationFields: ["installationId"],
      expressionFields: ["installationId"],
      execOutputs: [{ name: "next" }, { name: "timeout" }],
      idempotent: false,
      retry: { maxAttempts: 2, backoffMs: 10 },
    });
  });

  it("parses config as the real schema did", () => {
    const ask = chat.nodes[1];
    expect(ask?.configSchema.safeParse({ installationId: "ins_1" })).toEqual({
      success: true,
      data: { installationId: "ins_1", retries: 3 },
    });
    expect(ask?.configSchema.safeParse({}).success).toBe(false);
    expect(chat.configSchema.safeParse({ server: "not a url" }).success).toBe(false);
  });

  it("fails runs and resumes with the reason, never matches, and fails the test", async () => {
    const [down] = standInConnectors(ext.describe(), "needs Node 26");
    const ask = down?.nodes[1];
    const run = ask?.run?.({} as never, { inputs: {}, config: {} });
    await expect(run).rejects.toThrow(NodeError);
    await expect(run).rejects.toMatchObject({ message: "needs Node 26", code: DISABLED_CODE });
    await expect(
      ask?.resume?.({} as never, { inputs: {}, config: {}, resolution: { kind: "timer" } }),
    ).rejects.toMatchObject({ code: DISABLED_CODE });
    const trigger = down?.nodes[0]?.trigger;
    expect(await trigger?.match({} as never, {})).toBeNull();
    expect(await down?.test({} as never)).toEqual({ ok: false, error: "needs Node 26" });
    expect((await chat.test({} as never)) as unknown).toEqual({
      ok: false,
      error: "The extension is disabled",
    });
  });

  it("registers and unregisters cleanly", () => {
    const registry = new NodeRegistry();
    registry.registerConnector(chat);
    expect(registry.get("chat.ask", 2)?.connector).toBe("chat");
    expect(registry.catalog().nodes.find((n) => n.type === "chat.ask")?.configSchema).toMatchObject(
      {
        properties: { retries: { type: "integer", default: 3 } },
      },
    );
    registry.unregisterConnector("chat");
    expect(registry.get("chat.ask", 2)).toBeUndefined();
    expect(registry.connector("chat")).toBeUndefined();
    expect(registry.catalog().nodes.find((n) => n.type === "chat.ask")).toBeUndefined();
  });
});

describe("schemaFromJson", () => {
  it("accepts any object when a schema can't be converted", () => {
    const s = schemaFromJson({ type: "object", properties: { x: { $ref: "#/nowhere" } } });
    expect(s.safeParse({ anything: 1 }).success).toBe(true);
  });
});
