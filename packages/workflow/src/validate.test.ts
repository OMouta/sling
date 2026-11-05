import { describe, expect, it } from "vitest";
import { data, definition, exec, node, registry } from "./fixtures.test-util.ts";
import { parseDefinition, validate } from "./validate.ts";

const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

describe("validate", () => {
  it("accepts a valid workflow", () => {
    const def = definition(
      [
        node("t", "t.trigger"),
        node("if", "core.if", { condition: "inputs.value.ok" }),
        node("a", "t.step"),
        node("b", "t.text"),
        node("c", "t.step"),
      ],
      [
        exec("t.next", "if"),
        exec("if.true", "a"),
        exec("if.false", "b"),
        exec("a.next", "c"),
        exec("b.next", "c"),
        data("t.payload", "if.value"),
        data("t.text", "b.text"),
        data("a.result", "c.value"),
      ],
    );
    expect(validate(def, registry)).toEqual([]);
  });

  it("reports unknown node types and duplicate IDs", () => {
    const issues = validate(
      definition([node("t", "t.trigger"), node("t", "t.step"), node("x", "nope.thing")], []),
      registry,
    );
    expect(codes(issues)).toEqual(["duplicate_node_id", "unknown_node_type"]);
    expect(issues.find((i) => i.code === "unknown_node_type")?.nodeId).toBe("x");
  });

  it("checks config against the schema, but not fields holding expressions", () => {
    const bad = validate(
      definition(
        [node("t", "t.trigger"), node("c", "t.cfg", { url: "not a url", count: 0 })],
        [exec("t.next", "c")],
      ),
      registry,
    );
    expect(codes(bad)).toEqual(["invalid_config", "invalid_config"]);
    expect(bad.map((i) => i.port).sort()).toEqual(["count", "url"]);

    const expr = validate(
      definition(
        [node("t", "t.trigger"), node("c", "t.cfg", { url: "={{ trigger.payload.url }}" })],
        [exec("t.next", "c")],
      ),
      registry,
    );
    expect(expr).toEqual([]);

    const syntax = validate(
      definition(
        [node("t", "t.trigger"), node("c", "t.cfg", { url: "={{ trigger.( }}" })],
        [exec("t.next", "c")],
      ),
      registry,
    );
    expect(codes(syntax)).toEqual(["invalid_expression"]);
  });

  it("runs extra config checks a spec declares", () => {
    const issues = validate(
      definition(
        [node("t", "t.trigger"), node("if", "core.if", { condition: "inputs.(" })],
        [exec("t.next", "if")],
      ),
      registry,
    );
    expect(codes(issues)).toEqual(["invalid_config"]);
    expect(issues[0]?.nodeId).toBe("if");
  });

  it("reports edges to missing nodes and ports, and exec/data mix-ups", () => {
    const issues = validate(
      definition(
        [node("t", "t.trigger"), node("a", "t.step")],
        [
          exec("t.next", "a"),
          exec("a.next", "ghost"),
          data("t.nope", "a.value"),
          exec("t.payload", "a"),
          data("t.payload", "a.in"),
        ],
      ),
      registry,
    );
    expect(codes(issues)).toEqual([
      "kind_mismatch",
      "kind_mismatch",
      "unknown_node",
      "unknown_port",
    ]);
    const unknownPort = issues.find((i) => i.code === "unknown_port");
    expect(unknownPort).toMatchObject({ nodeId: "t", port: "nope" });
  });

  it("checks data types and allows one edge per input", () => {
    const issues = validate(
      definition(
        [node("t", "t.trigger"), node("a", "t.email"), node("b", "t.step")],
        [
          exec("t.next", "a"),
          exec("a.next", "b"),
          data("t.text", "a.email"),
          data("t.payload", "b.value"),
          data("t.text", "b.value"),
        ],
      ),
      registry,
    );
    expect(codes(issues)).toEqual(["duplicate_input", "type_mismatch"]);
    expect(issues.find((i) => i.code === "type_mismatch")).toMatchObject({
      nodeId: "a",
      port: "email",
    });
  });

  it("allows one edge per exec output, and many into one node", () => {
    const issues = validate(
      definition(
        [node("t", "t.trigger"), node("a", "t.step"), node("b", "t.step")],
        [exec("t.next", "a"), exec("t.next", "b"), exec("a.next", "b")],
      ),
      registry,
    );
    expect(codes(issues)).toEqual(["duplicate_exec_edge"]);
    expect(issues[0]).toMatchObject({ nodeId: "t", port: "next" });
  });

  it("needs required inputs to have an edge or a config value", () => {
    const missing = validate(
      definition([node("t", "t.trigger"), node("b", "t.text")], [exec("t.next", "b")]),
      registry,
    );
    expect(missing).toEqual([
      expect.objectContaining({ code: "missing_input", nodeId: "b", port: "text" }),
    ]);
    const fromConfig = validate(
      definition(
        [node("t", "t.trigger"), node("b", "t.text", { text: "={{ trigger.text }}" })],
        [exec("t.next", "b")],
      ),
      registry,
    );
    expect(fromConfig).toEqual([]);
  });

  it("needs a trigger, and every node reachable from one", () => {
    expect(codes(validate(definition([node("a", "t.step")], []), registry))).toEqual([
      "no_trigger",
    ]);
    const issues = validate(
      definition(
        [node("t", "t.trigger"), node("a", "t.step"), node("b", "t.step")],
        [exec("t.next", "a"), exec("b.next", "a")],
      ),
      registry,
    );
    expect(issues).toEqual([expect.objectContaining({ code: "unreachable", nodeId: "b" })]);
  });

  it("rejects exec cycles outside a loop body", () => {
    const issues = validate(
      definition(
        [node("t", "t.trigger"), node("a", "t.step"), node("b", "t.step")],
        [exec("t.next", "a"), exec("a.next", "b"), exec("b.next", "a")],
      ),
      registry,
    );
    expect(codes(issues)).toEqual(["cycle"]);
  });

  it("allows an edge from a loop body back to its loop, but not other cycles in the body", () => {
    const back = definition(
      [
        node("t", "t.trigger"),
        node("f", "core.for_each"),
        node("a", "t.step"),
        node("b", "t.step"),
      ],
      [
        exec("t.next", "f"),
        exec("f.each", "a"),
        exec("a.next", "b"),
        exec("b.next", "f"),
        data("t.items", "f.items"),
      ],
    );
    expect(validate(back, registry)).toEqual([]);

    const inner = definition(
      [
        node("t", "t.trigger"),
        node("f", "core.for_each"),
        node("a", "t.step"),
        node("b", "t.step"),
      ],
      [
        exec("t.next", "f"),
        exec("f.each", "a"),
        exec("a.next", "b"),
        exec("b.next", "a"),
        data("t.items", "f.items"),
      ],
    );
    expect(codes(validate(inner, registry))).toEqual(["cycle"]);
  });

  it("knows dynamic exec outputs and the implicit error ports", () => {
    const def = definition(
      [
        node("t", "t.trigger"),
        node("s", "t.switch", { cases: [{ port: "urgent" }, { port: "later" }] }),
        node("a", "t.step"),
        node("b", "t.step"),
        node("c", "t.step"),
        node("d", "t.step"),
      ],
      [
        exec("t.next", "s"),
        exec("s.urgent", "a"),
        exec("s.default", "b"),
        exec("a.error", "c"),
        data("a.error", "c.value"),
        exec("b.next", "d"),
      ],
    );
    expect(validate(def, registry)).toEqual([]);
    const bad = definition(
      [
        node("t", "t.trigger"),
        node("s", "t.switch", { cases: [{ port: "urgent" }] }),
        node("a", "t.step"),
      ],
      [exec("t.next", "s"), exec("s.someday", "a")],
    );
    expect(validate(bad, registry)).toEqual([
      expect.objectContaining({ code: "unknown_port", nodeId: "s", port: "someday" }),
      expect.objectContaining({ code: "unreachable", nodeId: "a" }),
    ]);
    // Triggers can't fail, so they have no error port.
    const trig = definition([node("t", "t.trigger"), node("a", "t.step")], [exec("t.error", "a")]);
    expect(codes(validate(trig, registry))).toEqual(["unknown_port", "unreachable"]);
  });

  it("parses the definition shape first", () => {
    const r = parseDefinition({ schema: "sling.workflow/v1", name: "", nodes: [], edges: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.code).toBe("invalid_shape");
    const ok = parseDefinition({ schema: "sling.workflow/v1", name: "x", nodes: [], edges: [] });
    expect(ok.ok).toBe(true);
  });
});
