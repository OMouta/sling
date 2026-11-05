import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "./definition.ts";
import { data, definition, exec, node, registry } from "./fixtures.test-util.ts";
import type { PortSpec } from "./spec.ts";
import {
  advance,
  buildGraph,
  type Cursor,
  enterLoop,
  type Graph,
  idempotencyKey,
  initialCursor,
  iterationOf,
  LOOP_NODE,
  MAX_LOOP_ITEMS,
  missingInputs,
  parseCursor,
  recordRun,
  resolveInputs,
  TraversalError,
} from "./traverse.ts";

/**
 * Plays the engine: runs nodes until the cursor has nowhere to go. `pick`
 * chooses each node's exec output; loops use the items their input resolved to.
 */
function simulate(
  def: WorkflowDefinition,
  trigger: Record<string, unknown>,
  pick: (
    id: string,
    inputs: Record<string, unknown>,
    c: Cursor,
  ) => { port: string; outputs?: Record<string, unknown> } = () => ({ port: "next" }),
) {
  const graph = buildGraph(def);
  let c = initialCursor(graph, "t", trigger);
  const visited: string[] = [];
  let guard = 0;
  while (c.next !== null) {
    if (guard++ > 1000) throw new Error("runaway");
    const id = c.next;
    const n = graph.nodes.get(id);
    if (!n) throw new Error(`no node ${id}`);
    const spec = registry.get(n.type, n.version);
    const { inputs } = resolveInputs(graph, c, n, spec?.inputs ?? []);
    visited.push(`${id}#${iterationOf(c, id)}`);
    if (n.type === LOOP_NODE) {
      c = recordRun(c, id, {});
      c = enterLoop(graph, c, id, (inputs.items as unknown[]) ?? []);
      continue;
    }
    const r = pick(id, inputs, c);
    c = recordRun(c, id, r.outputs ?? { result: inputs.value ?? null });
    c = advance(graph, c, id, r.port);
  }
  return { visited, cursor: c, graph };
}

describe("traversal", () => {
  it("follows branches and rejoins", () => {
    const def = definition(
      [
        node("t", "t.trigger"),
        node("if", "core.if"),
        node("a", "t.step"),
        node("b", "t.step"),
        node("c", "t.step"),
      ],
      [
        exec("t.next", "if"),
        exec("if.true", "a"),
        exec("if.false", "b"),
        exec("a.next", "c"),
        exec("b.next", "c"),
        data("t.payload", "if.value"),
        data("a.result", "c.value"),
      ],
    );
    const pick = (ok: boolean) => (id: string) => ({ port: id === "if" ? String(ok) : "next" });
    const yes = simulate(def, { payload: { ok: true } }, pick(true));
    expect(yes.visited).toEqual(["if#0", "a#0", "c#0"]);
    const no = simulate(def, { payload: { ok: false } }, pick(false));
    expect(no.visited).toEqual(["if#0", "b#0", "c#0"]);
    // c reads a's output, and a didn't run on this branch.
    expect(no.cursor.outputs.c).toEqual({ result: null });
  });

  it("runs a loop body once per item, then leaves through done", () => {
    const def = definition(
      [
        node("t", "t.trigger"),
        node("f", "core.for_each"),
        node("a", "t.step"),
        node("b", "t.step"),
        node("z", "t.step"),
      ],
      [
        exec("t.next", "f"),
        exec("f.each", "a"),
        exec("a.next", "b"),
        exec("f.done", "z"),
        data("t.items", "f.items"),
        data("f.item", "a.value"),
      ],
    );
    const seen: unknown[] = [];
    const { visited } = simulate(def, { items: ["x", "y", "z"] }, (id, inputs, c) => {
      if (id === "a") seen.push([inputs.value, c.outputs.f?.index]);
      return { port: "next" };
    });
    expect(visited).toEqual(["f#0", "a#0", "b#0", "a#1", "b#1", "a#2", "b#2", "z#0"]);
    expect(seen).toEqual([
      ["x", 0],
      ["y", 1],
      ["z", 2],
    ]);
  });

  it("clears a body's outputs between iterations", () => {
    const def = definition(
      [
        node("t", "t.trigger"),
        node("f", "core.for_each"),
        node("if", "core.if"),
        node("a", "t.step"),
        node("b", "t.step"),
      ],
      [
        exec("t.next", "f"),
        exec("f.each", "if"),
        exec("if.true", "a"),
        exec("if.false", "b"),
        data("t.items", "f.items"),
        data("f.item", "if.value"),
        data("a.result", "b.value"),
      ],
    );
    const bInputs: unknown[] = [];
    simulate(def, { items: [true, false] }, (id, inputs) => {
      if (id === "if") return { port: String(inputs.value), outputs: {} };
      if (id === "a") return { port: "next", outputs: { result: "from a" } };
      bInputs.push(inputs.value);
      return { port: "next" };
    });
    // In the second iteration a didn't run, so b must not see the first iteration's value.
    expect(bInputs).toEqual([null]);
  });

  it("treats an edge back to the loop as next item, and nests loops", () => {
    const def = definition(
      [
        node("t", "t.trigger"),
        node("outer", "core.for_each"),
        node("inner", "core.for_each"),
        node("a", "t.step"),
        node("after", "t.step"),
      ],
      [
        exec("t.next", "outer"),
        exec("outer.each", "inner"),
        exec("inner.each", "a"),
        exec("a.next", "inner"),
        exec("inner.done", "after"),
        exec("after.next", "outer"),
        data("t.items", "outer.items"),
        data("outer.item", "inner.items"),
      ],
    );
    const { visited } = simulate(def, { items: [[1, 2], [3]] });
    expect(visited).toEqual([
      "outer#0",
      "inner#0",
      "a#0",
      "a#1",
      "after#0",
      "inner#1",
      "a#2",
      "after#1",
    ]);
  });

  it("goes straight to done for no items or an empty body", () => {
    const def = definition(
      [node("t", "t.trigger"), node("f", "core.for_each"), node("z", "t.step")],
      [exec("t.next", "f"), exec("f.done", "z"), data("t.items", "f.items")],
    );
    expect(simulate(def, { items: [] }).visited).toEqual(["f#0", "z#0"]);
    expect(simulate(def, { items: [1, 2, 3] }).visited).toEqual(["f#0", "z#0"]);
  });

  it("caps loops at 1,000 items", () => {
    const def = definition(
      [node("t", "t.trigger"), node("f", "core.for_each")],
      [exec("t.next", "f"), data("t.items", "f.items")],
    );
    const graph = buildGraph(def);
    const c = initialCursor(graph, "t", {});
    expect(() => enterLoop(graph, c, "f", new Array(MAX_LOOP_ITEMS + 1).fill(0))).toThrow(
      TraversalError,
    );
    expect(() => enterLoop(graph, c, "f", new Array(MAX_LOOP_ITEMS).fill(0))).not.toThrow();
  });

  it("follows the error port when it's connected", () => {
    const def = definition(
      [node("t", "t.trigger"), node("a", "t.step"), node("b", "t.step"), node("h", "t.step")],
      [exec("t.next", "a"), exec("a.next", "b"), exec("a.error", "h"), data("a.error", "h.value")],
    );
    const { visited, cursor } = simulate(def, {}, (id) =>
      id === "a"
        ? { port: "error", outputs: { error: { message: "boom", code: "x" } } }
        : { port: "next" },
    );
    expect(visited).toEqual(["a#0", "h#0"]);
    expect(cursor.outputs.h).toEqual({ result: { message: "boom", code: "x" } });
  });

  it("ends when an exec output has no edge", () => {
    const def = definition([node("t", "t.trigger"), node("a", "t.step")], [exec("t.next", "a")]);
    const { cursor } = simulate(def, {});
    expect(cursor.next).toBeNull();
    expect(cursor.nodeRuns).toBe(2);
  });
});

describe("inputs", () => {
  const ports: PortSpec[] = [
    { name: "text", type: "string", required: true },
    { name: "extra", type: "any" },
  ];
  const def = definition(
    [node("t", "t.trigger"), node("a", "t.text", { extra: "={{ trigger.text }}" })],
    [exec("t.next", "a"), data("t.text", "a.text")],
  );

  it("reads earlier outputs and falls back to config of the same name", () => {
    const graph: Graph = buildGraph(def);
    const c = initialCursor(graph, "t", { text: "hi" });
    const a = graph.nodes.get("a");
    if (!a) throw new Error("no node");
    const r = resolveInputs(graph, c, a, ports);
    expect(r.inputs).toEqual({ text: "hi", extra: "={{ trigger.text }}" });
    expect(r.fromConfig).toEqual(["extra"]);
    expect(missingInputs(ports, r.inputs)).toEqual([]);
    const empty = resolveInputs(graph, initialCursor(graph, "t", {}), a, ports);
    expect(missingInputs(ports, empty.inputs)).toEqual(["text"]);
  });
});

describe("cursor", () => {
  it("survives a JSON round trip and fills in missing fields", () => {
    const def = definition(
      [node("t", "t.trigger"), node("f", "core.for_each"), node("a", "t.step")],
      [exec("t.next", "f"), exec("f.each", "a"), data("t.items", "f.items")],
    );
    const graph = buildGraph(def);
    let c = initialCursor(graph, "t", { items: [1, 2] });
    c = recordRun(c, "f", {});
    c = enterLoop(graph, c, "f", [1, 2]);
    c = {
      ...c,
      vars: { seen: 1 },
      inFlight: { nodeId: "a", nodeRunId: "nr_1", iteration: 0, attempt: 1 },
    };
    expect(parseCursor(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(parseCursor({ next: "a" })).toEqual({
      next: "a",
      outputs: {},
      vars: {},
      frames: [],
      counts: {},
      nodeRuns: 0,
      inFlight: null,
      parked: null,
    });
  });

  it("builds idempotency keys from run, node, and iteration", () => {
    expect(idempotencyKey("run_1", "send", 3)).toBe("run_1:send:3");
  });
});
