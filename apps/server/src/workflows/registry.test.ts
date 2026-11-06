import { type AnyConnector, defineConnector, defineNode } from "@sling/connector-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NodeRegistry } from "./registry.ts";

function action(type: string) {
  return defineNode({
    type,
    version: 1,
    title: type,
    description: "",
    category: "action",
    configSchema: z.object({}),
    inputs: [],
    outputs: [],
    execInput: true,
    execOutputs: [{ name: "next" }],
    idempotent: true,
    run: async () => ({ exec: "next" }),
  });
}

function connector(id: string, types: string[]): AnyConnector {
  return defineConnector({
    id,
    name: id,
    description: "",
    credentialsSchema: z.object({}),
    secretFields: [],
    configSchema: z.object({}),
    test: async () => ({ ok: true }),
    nodes: types.map(action),
  });
}

describe("NodeRegistry connectors", () => {
  it("registers a connector all or nothing", () => {
    const r = new NodeRegistry();
    r.register(action("x.taken"));
    expect(() => r.registerConnector(connector("x", ["x.free", "x.taken"]))).toThrow(
      "Node x.taken@1 is registered twice",
    );
    expect(r.get("x.free", 1)).toBeUndefined();
    expect(r.connector("x")).toBeUndefined();
  });

  it("unregisters a connector's nodes and leaves the rest", () => {
    const r = new NodeRegistry();
    r.register(action("core.keep"));
    r.registerConnector(connector("chat", ["chat.send", "chat.edit"]));
    expect(r.catalog().nodes.map((n) => n.type)).toEqual(["chat.edit", "chat.send", "core.keep"]);
    r.unregisterConnector("chat");
    expect(r.catalog().nodes.map((n) => n.type)).toEqual(["core.keep"]);
    expect(r.connectors()).toEqual([]);
    // Registering it again after removal works, and unknown IDs are ignored.
    r.registerConnector(connector("chat", ["chat.send"]));
    r.unregisterConnector("nope");
    expect(r.get("chat.send", 1)?.connector).toBe("chat");
  });
});
