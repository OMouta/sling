import { describe, expect, it } from "vitest";
import { expressionSource, isExpression, toExpression } from "./definition.ts";
import { execOutputsOf, type NodeSpec } from "./spec.ts";
import { isAssignable, isKnownType } from "./types.ts";

describe("port types", () => {
  it("knows primitives, named types, and lists", () => {
    expect(isKnownType("string")).toBe(true);
    expect(isKnownType("email")).toBe(true);
    expect(isKnownType("list<email>")).toBe(true);
    expect(isKnownType("list<nope>")).toBe(false);
    expect(isKnownType("banana")).toBe(false);
  });

  it("checks assignability", () => {
    expect(isAssignable("string", "string")).toBe(true);
    expect(isAssignable("string", "number")).toBe(false);
    expect(isAssignable("email", "json")).toBe(true);
    expect(isAssignable("any", "email")).toBe(true);
    expect(isAssignable("email", "any")).toBe(true);
    expect(isAssignable("list<email>", "list<any>")).toBe(true);
    expect(isAssignable("list<email>", "list<string>")).toBe(false);
    expect(isAssignable("email", "list<email>")).toBe(false);
    expect(isAssignable("json", "string")).toBe(false);
  });
});

describe("expressions", () => {
  it("round-trips the ={{ }} syntax", () => {
    const e = toExpression("inputs.email.from.address");
    expect(isExpression(e)).toBe(true);
    expect(expressionSource(e)).toBe("inputs.email.from.address");
    expect(isExpression("plain text")).toBe(false);
    expect(isExpression("={{ a }} trailing")).toBe(false);
  });
});

describe("dynamic exec outputs", () => {
  it("adds config-driven ports and extras", () => {
    const spec = {
      execOutputs: [],
      dynamicExecOutputs: { fromConfig: "cases", field: "label", extra: [{ name: "default" }] },
    } as unknown as NodeSpec;
    const ports = execOutputsOf(spec, { cases: [{ label: "urgent" }, { label: "later" }] });
    expect(ports.map((p) => p.name)).toEqual(["urgent", "later", "default"]);
  });
});
