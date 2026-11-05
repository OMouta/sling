import { describe, expect, it } from "vitest";
import { definition, catalog as rawCatalog } from "../../test/fixtures.ts";
import { indexCatalog } from "./catalog.ts";
import { availableFields } from "./expressions.ts";
import * as g from "./graph.ts";

const catalog = indexCatalog(rawCatalog);

describe("fields available to expressions", () => {
  it("lists connected inputs with the fields of their named type", () => {
    const state = g.fromDefinition(definition, catalog);
    const { inputs, trigger } = availableFields(state, catalog, "n_if");
    const paths = inputs.map((f) => f.path);
    expect(paths).toContain("inputs.value");
    expect(paths).toContain("inputs.value.subject");
    expect(paths).toContain("inputs.value.from.address");
    expect(inputs.find((f) => f.path === "inputs.value")?.type).toBe("email");
    expect(trigger.map((f) => f.path)).toContain("trigger.email.subject");
  });

  it("lists nothing for unconnected inputs", () => {
    const state = g.removeElements(g.fromDefinition(definition, catalog), [], ["e2"]);
    expect(availableFields(state, catalog, "n_if").inputs).toEqual([]);
  });

  it("lists variables set in the workflow", () => {
    let state = g.fromDefinition(definition, catalog);
    const spec = catalog.byType.get("core.set_var");
    if (!spec) throw new Error("fixture");
    const r = g.addNode(state, spec, { x: 0, y: 0 });
    state = g.updateConfig(r.state, catalog, r.id, { name: "count", value: "1" });
    expect(availableFields(state, catalog, "n_if").vars).toEqual([
      { path: "vars.count", type: "any" },
    ]);
  });
});
