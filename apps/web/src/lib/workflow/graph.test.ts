import { WorkflowDefinitionSchema } from "@sling/workflow";
import { describe, expect, it } from "vitest";
import { bigDefinition, definition, catalog as rawCatalog } from "../../test/fixtures.ts";
import { indexCatalog } from "./catalog.ts";
import * as g from "./graph.ts";
import { indexConnected } from "./store.ts";

const catalog = indexCatalog(rawCatalog);
const spec = (type: string) => {
  const s = catalog.byType.get(type);
  if (!s) throw new Error(type);
  return s;
};

function ids() {
  let n = 0;
  return (prefix: "n" | "e") => `${prefix}_t${++n}`;
}

function load() {
  return g.fromDefinition(definition, catalog);
}

function blank() {
  return g.fromDefinition({ ...definition, nodes: [], edges: [] }, catalog);
}

describe("definition round trip", () => {
  it("converts a definition to the graph and back unchanged", () => {
    const state = load();
    expect(state.nodes).toHaveLength(4);
    expect(state.edges).toHaveLength(6);
    expect(state.edges[0]).toMatchObject({
      source: "n_trigger",
      sourceHandle: "x:next",
      target: "n_if",
      targetHandle: "x:in",
      type: "exec",
    });
    expect(state.edges[1]?.data?.portType).toBe("email");
    expect(g.toDefinition(state)).toEqual(definition);
  });

  it("keeps positions, rounding them to whole pixels", () => {
    let state = load();
    state = g.applyNodeChanges(state, [
      { type: "position", id: "n_if", position: { x: 310.6, y: -20.2 } },
    ]);
    const n = g.toDefinition(state).nodes.find((x) => x.id === "n_if");
    expect(n?.position).toEqual({ x: 311, y: -20 });
  });

  it("writes definitions the schema accepts", () => {
    let state = blank();
    state = g.addNode(state, spec("core.manual"), { x: 0, y: 0 }, ids()).state;
    expect(WorkflowDefinitionSchema.safeParse(g.toDefinition(state)).success).toBe(true);
  });

  it("drops empty labels from the definition", () => {
    let state = blank();
    state = g.addNode(state, spec("core.if"), { x: 0, y: 0 }, ids()).state;
    expect(g.toDefinition(state).nodes[0]).not.toHaveProperty("label");
  });
});

describe("adding, connecting and deleting", () => {
  it("adds a node with the spec's version and default config, selected", () => {
    const state = load();
    const r = g.addNode(state, spec("http.request"), { x: 10.4, y: 20 }, ids());
    const node = g.nodeById(r.state, r.id);
    expect(node?.data).toEqual({
      type: "http.request",
      version: 1,
      label: "",
      config: { method: "GET", timeoutMs: 10000 },
    });
    expect(node?.position).toEqual({ x: 10, y: 20 });
    expect(g.selectedNodeIds(r.state)).toEqual([r.id]);
  });

  it("connects exec and data ports", () => {
    let state = blank();
    const newId = ids();
    let r = g.addNode(state, spec("core.manual"), { x: 0, y: 0 }, newId);
    const trigger = r.id;
    r = g.addNode(r.state, spec("core.transform"), { x: 300, y: 0 }, newId);
    const transform = r.id;
    state = r.state;

    const exec = g.connect(state, catalog, {
      source: trigger,
      sourceHandle: "x:next",
      target: transform,
      targetHandle: "x:in",
    });
    expect(exec.check.ok).toBe(true);
    const data = g.connect(exec.state, catalog, {
      source: trigger,
      sourceHandle: "d:input",
      target: transform,
      targetHandle: "d:value",
    });
    expect(data.check.ok).toBe(true);
    expect(data.state.edges.map((e) => e.type)).toEqual(["exec", "data"]);
    expect(data.state.edges[1]?.data?.portType).toBe("json");
  });

  it("deletes the selection with edges attached to deleted nodes", () => {
    let state = load();
    state = g.select(state, ["n_if"]);
    state = g.deleteSelection(state);
    expect(state.nodes.map((n) => n.id)).toEqual(["n_trigger", "n_ai", "n_send"]);
    expect(state.edges.map((e) => e.id)).toEqual(["e4", "e5", "e6"]);
  });

  it("deletes selected edges alone", () => {
    let state = load();
    state = g.select(state, [], ["e6"]);
    state = g.deleteSelection(state);
    expect(state.nodes).toHaveLength(4);
    expect(state.edges.map((e) => e.id)).not.toContain("e6");
  });

  it("removes edges from exec ports that disappear when config changes", () => {
    let state = blank();
    const newId = ids();
    let r = g.addNode(state, spec("core.switch"), { x: 0, y: 0 }, newId);
    const sw = r.id;
    r = g.addNode(r.state, spec("core.transform"), { x: 300, y: 0 }, newId);
    const t = r.id;
    state = g.updateConfig(r.state, catalog, sw, { cases: [{ name: "big", when: "x > 1" }] });
    state = g.connect(state, catalog, {
      source: sw,
      sourceHandle: "x:big",
      target: t,
      targetHandle: "x:in",
    }).state;
    expect(state.edges).toHaveLength(1);
    state = g.updateConfig(state, catalog, sw, { cases: [{ name: "huge", when: "x > 9" }] }, null);
    expect(state.edges).toHaveLength(0);
    state = g.undo(state);
    expect(state.edges).toHaveLength(1);
  });
});

describe("connection rules", () => {
  const state = load();
  const check = (c: g.ConnectionRequest) => g.checkConnection(state, catalog, c);

  it("refuses self-loops", () => {
    const r = check({
      source: "n_ai",
      sourceHandle: "x:next",
      target: "n_ai",
      targetHandle: "x:in",
    });
    expect(r).toEqual({ ok: false, reason: "A node can't connect to itself." });
  });

  it("refuses exec to data and data to exec", () => {
    const a = check({
      source: "n_if",
      sourceHandle: "x:false",
      target: "n_send",
      targetHandle: "d:content",
    });
    expect(a.ok).toBe(false);
    expect(!a.ok && a.reason).toMatch(/Exec ports connect only to exec ports/);
    const b = check({
      source: "n_ai",
      sourceHandle: "d:text",
      target: "n_send",
      targetHandle: "x:in",
    });
    expect(!b.ok && b.reason).toMatch(/Data ports connect only to data ports/);
  });

  it("refuses data types that aren't assignable", () => {
    let s = g.removeElements(load(), [], ["e6"]);
    // email into a string input
    const r = g.checkConnection(s, catalog, {
      source: "n_trigger",
      sourceHandle: "d:email",
      target: "n_send",
      targetHandle: "d:content",
    });
    expect(r).toEqual({ ok: false, reason: "This input takes string, not email." });
    // string into a string input is fine
    s = g.removeElements(load(), [], ["e6"]);
    expect(
      g.checkConnection(s, catalog, {
        source: "n_ai",
        sourceHandle: "d:text",
        target: "n_send",
        targetHandle: "d:content",
      }).ok,
    ).toBe(true);
  });

  it("allows anything into json and any", () => {
    const s = g.removeElements(load(), [], ["e2", "e4"]);
    for (const targetHandle of ["d:value"]) {
      expect(
        g.checkConnection(s, catalog, {
          source: "n_ai",
          sourceHandle: "d:text",
          target: "n_if",
          targetHandle,
        }).ok,
      ).toBe(true);
    }
    expect(
      g.checkConnection(s, catalog, {
        source: "n_trigger",
        sourceHandle: "d:email",
        target: "n_ai",
        targetHandle: "d:context",
      }).ok,
    ).toBe(true);
  });

  it("allows one edge per data input", () => {
    const r = check({
      source: "n_ai",
      sourceHandle: "d:text",
      target: "n_if",
      targetHandle: "d:value",
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/already has a connection/);
  });

  it("refuses an exact duplicate", () => {
    const r = check({
      source: "n_trigger",
      sourceHandle: "x:next",
      target: "n_if",
      targetHandle: "x:in",
    });
    expect(r).toEqual({ ok: false, reason: "These ports are already connected." });
  });

  it("replaces the edge on an exec output that already has one", () => {
    const c = { source: "n_if", sourceHandle: "x:true", target: "n_send", targetHandle: "x:in" };
    expect(check(c)).toMatchObject({ ok: true, replaces: "e3" });
    const r = g.connect(state, catalog, c, ids());
    expect(
      r.state.edges.filter((e) => e.source === "n_if" && e.sourceHandle === "x:true"),
    ).toHaveLength(1);
    expect(r.state.edges.map((e) => e.id)).not.toContain("e3");
  });

  it("lets several exec edges lead into one node", () => {
    const r = check({
      source: "n_if",
      sourceHandle: "x:false",
      target: "n_send",
      targetHandle: "x:in",
    });
    expect(r).toMatchObject({ ok: true, replaces: null });
  });

  it("refuses edges into triggers and unknown ports", () => {
    const a = check({
      source: "n_send",
      sourceHandle: "x:next",
      target: "n_trigger",
      targetHandle: "x:in",
    });
    expect(!a.ok && a.reason).toMatch(/Triggers start a run/);
    const b = check({
      source: "n_if",
      sourceHandle: "x:maybe",
      target: "n_send",
      targetHandle: "x:in",
    });
    expect(!b.ok && b.reason).toMatch(/no exec output "maybe"/);
  });

  it("offers an error exec output on nodes that can fail, not on triggers", () => {
    expect(
      check({ source: "n_send", sourceHandle: "x:error", target: "n_ai", targetHandle: "x:in" }).ok,
    ).toBe(true);
    expect(
      check({ source: "n_trigger", sourceHandle: "x:error", target: "n_ai", targetHandle: "x:in" })
        .ok,
    ).toBe(false);
  });

  it("refuses the connection without changing the graph", () => {
    const r = g.connect(state, catalog, {
      source: "n_ai",
      sourceHandle: "x:next",
      target: "n_ai",
      targetHandle: "x:in",
    });
    expect(r.state).toBe(state);
  });
});

describe("undo and redo", () => {
  it("undoes and redoes adds, connects and deletes", () => {
    let state = blank();
    const newId = ids();
    const a = g.addNode(state, spec("core.manual"), { x: 0, y: 0 }, newId);
    const b = g.addNode(a.state, spec("core.transform"), { x: 200, y: 0 }, newId);
    state = g.connect(
      b.state,
      catalog,
      { source: a.id, sourceHandle: "x:next", target: b.id, targetHandle: "x:in" },
      newId,
    ).state;
    expect(state.past).toHaveLength(3);

    state = g.undo(state);
    expect(state.edges).toHaveLength(0);
    expect(state.nodes).toHaveLength(2);
    state = g.undo(state);
    expect(state.nodes).toHaveLength(1);
    state = g.redo(g.redo(state));
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toHaveLength(1);
    expect(g.canRedo(state)).toBe(false);

    state = g.select(state, [b.id]);
    state = g.deleteSelection(state);
    expect(state.nodes).toHaveLength(1);
    state = g.undo(state);
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toHaveLength(1);
  });

  it("clears redo after a new edit", () => {
    let state = g.addNode(blank(), spec("core.if"), { x: 0, y: 0 }, ids()).state;
    state = g.undo(state);
    expect(g.canRedo(state)).toBe(true);
    state = g.addNode(state, spec("core.if"), { x: 0, y: 0 }, ids()).state;
    expect(g.canRedo(state)).toBe(false);
  });

  it("does nothing with no history", () => {
    const state = blank();
    expect(g.undo(state)).toBe(state);
    expect(g.redo(state)).toBe(state);
  });

  it("merges a burst of edits to one field into one step", () => {
    let state = load();
    for (const condition of ["a", "ab", "abc"]) {
      state = g.updateConfig(state, catalog, "n_if", { condition });
    }
    expect(state.past).toHaveLength(1);
    state = g.undo(state);
    expect(g.nodeById(state, "n_if")?.data.config.condition).toBe(
      definition.nodes[1]?.config.condition,
    );
  });

  it("records a drag as one step when it ends", () => {
    let state = g.beginDrag(load());
    for (let x = 1; x <= 5; x++) {
      state = g.applyNodeChanges(state, [
        { type: "position", id: "n_ai", position: { x: 600 + x * 10, y: -80 }, dragging: true },
      ]);
    }
    expect(state.past).toHaveLength(0);
    state = g.endDrag(state);
    expect(state.past).toHaveLength(1);
    expect(g.nodeById(state, "n_ai")?.position.x).toBe(650);
    state = g.undo(state);
    expect(g.nodeById(state, "n_ai")?.position.x).toBe(600);
  });

  it("doesn't record a drag that didn't move anything", () => {
    const state = g.endDrag(g.beginDrag(load()));
    expect(state.past).toHaveLength(0);
    expect(state.dragOrigin).toBeNull();
  });

  it("keeps selection and measurements out of history", () => {
    let state = load();
    state = g.applyNodeChanges(state, [
      { type: "select", id: "n_ai", selected: true },
      { type: "dimensions", id: "n_ai", dimensions: { width: 220, height: 120 } },
    ]);
    state = g.applyEdgeChanges(state, [{ type: "select", id: "e1", selected: true }]);
    expect(state.past).toHaveLength(0);
    expect(state.revision).toBe(0);
    expect(g.nodeById(state, "n_ai")?.measured).toEqual({ width: 220, height: 120 });
  });

  it("caps history", () => {
    let state = load();
    for (let i = 0; i < g.HISTORY_LIMIT + 20; i++) {
      state = g.updateLabel(state, i % 2 ? "n_if" : "n_ai", `L${i}`);
    }
    expect(state.past).toHaveLength(g.HISTORY_LIMIT);
  });
});

describe("copy and paste", () => {
  it("copies the selection with the edges between selected nodes", () => {
    const state = g.select(load(), ["n_if", "n_ai"]);
    const frag = g.copySelection(state);
    expect(frag?.nodes.map((n) => n.id)).toEqual(["n_if", "n_ai"]);
    expect(frag?.edges.map((e) => e.id)).toEqual(["e3"]);
  });

  it("returns nothing with no selection", () => {
    expect(g.copySelection(load())).toBeNull();
  });

  it("pastes with new IDs, remapped edges, an offset, and selects the copy", () => {
    let state = g.select(load(), ["n_if", "n_ai"]);
    const frag = g.copySelection(state);
    if (!frag) throw new Error("no fragment");
    state = g.paste(state, catalog, frag, { x: 40, y: 40 }, ids());
    expect(state.nodes).toHaveLength(6);
    const pasted = state.nodes.slice(4);
    expect(pasted.map((n) => n.id)).toEqual(["n_t1", "n_t2"]);
    expect(pasted.every((n) => n.selected)).toBe(true);
    expect(state.nodes.slice(0, 4).some((n) => n.selected)).toBe(false);
    expect(pasted[0]?.position).toEqual({ x: 340, y: 40 });
    expect(pasted[0]?.data.config).toEqual(g.nodeById(state, "n_if")?.data.config);
    const edge = state.edges[state.edges.length - 1];
    expect(edge).toMatchObject({
      id: "e_t3",
      source: "n_t1",
      sourceHandle: "x:true",
      target: "n_t2",
      targetHandle: "x:in",
    });
    expect(state.edges).toHaveLength(7);
    // Original IDs are untouched.
    expect(g.nodeById(state, "n_if")).toBeDefined();
  });

  it("deep-copies config so edits to the copy don't touch the original", () => {
    let state = g.select(load(), ["n_send"]);
    const frag = g.copySelection(state);
    if (!frag) throw new Error("no fragment");
    state = g.paste(state, catalog, frag, undefined, ids());
    const copy = state.nodes[state.nodes.length - 1];
    expect(copy?.data.config).not.toBe(g.nodeById(state, "n_send")?.data.config);
  });

  it("undoes a paste in one step", () => {
    let state = g.select(load(), ["n_if", "n_ai"]);
    const frag = g.copySelection(state);
    if (!frag) throw new Error("no fragment");
    state = g.undo(g.paste(state, catalog, frag, undefined, ids()));
    expect(state.nodes).toHaveLength(4);
    expect(state.edges).toHaveLength(6);
  });
});

describe("rendering cost", () => {
  it("keeps untouched nodes identical while one moves", () => {
    const state = g.fromDefinition(bigDefinition(200), catalog);
    const next = g.applyNodeChanges(state, [
      { type: "position", id: "n5", position: { x: 1, y: 1 }, dragging: true },
    ]);
    const changed = next.nodes.filter((n, i) => n !== state.nodes[i]);
    expect(changed.map((n) => n.id)).toEqual(["n5"]);
    expect(next.edges).toBe(state.edges);
  });

  it("reuses connection sets for nodes whose edges didn't change", () => {
    const state = load();
    const before = indexConnected(state.edges);
    const after = indexConnected(g.removeElements(state, [], ["e6"]).edges, before);
    expect(after.get("n_trigger")).toBe(before.get("n_trigger"));
    expect(after.get("n_send")).not.toBe(before.get("n_send"));
  });

  it("selecting leaves other nodes alone", () => {
    const state = load();
    const next = g.select(state, ["n_ai"]);
    expect(next.nodes.filter((n, i) => n !== state.nodes[i]).map((n) => n.id)).toEqual(["n_ai"]);
  });
});

describe("adding a step after the selected one", () => {
  it("places it to the right and wires the first free output to it, in one undo step", () => {
    let state = blank();
    const newId = ids();
    const trigger = g.addNode(state, spec("core.manual"), { x: 0, y: 0 }, newId);
    state = trigger.state;
    const r = g.addAfterSelection(state, catalog, spec("http.request"), { x: 999, y: 999 }, newId);
    expect(r.connected).toBe(true);
    const node = g.nodeById(r.state, r.id);
    expect(node?.position).toEqual({ x: 330, y: 0 });
    expect(node?.selected).toBe(true);
    expect(r.state.edges).toEqual([
      expect.objectContaining({
        type: "exec",
        source: trigger.id,
        sourceHandle: "x:next",
        target: r.id,
        targetHandle: "x:in",
      }),
    ]);
    const undone = g.undo(r.state);
    expect(undone.nodes.map((n) => n.id)).toEqual([trigger.id]);
    expect(undone.edges).toEqual([]);
  });

  it("stacks a second step below the first, and uses the next free branch", () => {
    let state = blank();
    const newId = ids();
    const iff = g.addNode(state, spec("core.if"), { x: 0, y: 0 }, newId);
    state = iff.state;
    const first = g.addAfterSelection(state, catalog, spec("http.request"), { x: 0, y: 0 }, newId);
    state = g.select(first.state, [iff.id]);
    const second = g.addAfterSelection(state, catalog, spec("http.request"), { x: 0, y: 0 }, newId);
    expect(g.nodeById(second.state, second.id)?.position).toEqual({ x: 330, y: 150 });
    expect(second.state.edges.map((e) => e.sourceHandle)).toEqual(["x:true", "x:false"]);
  });

  it("puts a trigger, or a step with nothing selected, where it's asked", () => {
    let state = blank();
    const newId = ids();
    state = g.addNode(state, spec("core.manual"), { x: 0, y: 0 }, newId).state;
    const t = g.addAfterSelection(state, catalog, spec("core.manual"), { x: 50, y: 60 }, newId);
    expect(t.connected).toBe(false);
    expect(g.nodeById(t.state, t.id)?.position).toEqual({ x: 50, y: 60 });
    const none = g.select(t.state, []);
    const s = g.addAfterSelection(none, catalog, spec("http.request"), { x: 7, y: 8 }, newId);
    expect(s.connected).toBe(false);
    expect(s.state.edges).toEqual([]);
  });
});
