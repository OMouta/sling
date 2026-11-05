import { describe, expect, it } from "vitest";
import {
  bareExpression,
  checkExpression,
  ExpressionError,
  type ExpressionScope,
  evaluateConfig,
  evaluateExpression,
  evaluateValue,
  isTruthy,
} from "./expression.ts";

const scope: ExpressionScope = {
  inputs: { email: { from: { address: "boss@example.com" }, subject: "Hi" }, n: 3 },
  trigger: { body: { items: [1, 2, 3] } },
  vars: { greeting: "hello" },
  execution: { runId: "run_1", nodeId: "n1" },
};

describe("evaluateExpression", () => {
  it("reads inputs, trigger, vars, and execution", async () => {
    expect(await evaluateExpression("inputs.email.from.address", scope)).toBe("boss@example.com");
    expect(await evaluateExpression("$sum(trigger.body.items)", scope)).toBe(6);
    expect(await evaluateExpression("vars.greeting & ' ' & execution.runId", scope)).toBe(
      "hello run_1",
    );
    expect(await evaluateExpression("inputs.n > 2", scope)).toBe(true);
  });

  it("returns null for no match and plain JSON for sequences", async () => {
    expect(await evaluateExpression("inputs.nope", scope)).toBeNull();
    const seq = await evaluateExpression("trigger.body.items.($ * 2)", scope);
    expect(seq).toEqual([2, 4, 6]);
    expect(Object.keys(seq as object)).toEqual(["0", "1", "2"]);
  });

  it("rejects a function as a result", async () => {
    await expect(evaluateExpression("function($x) { $x }", scope)).rejects.toThrow(
      /returned a function/,
    );
  });

  it("reports syntax errors with a position", async () => {
    expect(checkExpression("inputs.(")).toMatch(/at \d+/);
    expect(checkExpression("inputs.n + 1")).toBeNull();
    expect(checkExpression("  ")).toMatch(/empty/);
    await expect(evaluateExpression("inputs.(", scope)).rejects.toBeInstanceOf(ExpressionError);
  });

  it("stops an expression that runs longer than a second", async () => {
    const started = Date.now();
    const err = await evaluateExpression(
      "( $loop := function($n) { $n > 0 ? $loop($n - 1) : 0 }; $loop(100000000) )",
      scope,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExpressionError);
    expect((err as ExpressionError).code).toBe("expression_timeout");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("stops recursion deeper than 300 levels", async () => {
    const deep = "( $f := function($n) { $n = 0 ? 0 : 1 + $f($n - 1) }; $f(1000) )";
    const err = await evaluateExpression(deep, scope).catch((e: unknown) => e);
    expect((err as ExpressionError).code).toBe("expression_depth");
    const shallow = "( $f := function($n) { $n = 0 ? 0 : 1 + $f($n - 1) }; $f(20) )";
    expect(await evaluateExpression(shallow, scope)).toBe(20);
  });

  it("evaluates concurrently without the limits leaking between calls", async () => {
    const src = "( $f := function($n) { $n = 0 ? 0 : 1 + $f($n - 1) }; $f(15) )";
    const results = await Promise.all(
      Array.from({ length: 20 }, () => evaluateExpression(src, scope)),
    );
    expect(results).toEqual(Array(20).fill(15));
  });
});

describe("evaluateConfig", () => {
  it("evaluates only expression fields written as ={{ }}", async () => {
    const { config, evaluated } = await evaluateConfig(
      {
        to: "={{ inputs.email.from.address }}",
        subject: "={{ 'Re: ' & inputs.email.subject }}",
        literal: "={{ inputs.n }}",
        plain: "no expression here",
      },
      ["to", "subject", "plain"],
      scope,
    );
    expect(config).toEqual({
      to: "boss@example.com",
      subject: "Re: Hi",
      literal: "={{ inputs.n }}",
      plain: "no expression here",
    });
    expect(evaluated).toEqual(["to", "subject"]);
  });

  it("names the field in errors", async () => {
    await expect(evaluateConfig({ to: "={{ inputs.( }}" }, ["to"], scope)).rejects.toThrow(/^to: /);
  });

  it("leaves non-expressions alone in evaluateValue", async () => {
    expect(await evaluateValue(42, scope)).toBe(42);
    expect(await evaluateValue("={{ inputs.n * 2 }}", scope)).toBe(6);
  });
});

describe("isTruthy", () => {
  it("follows JSONata's boolean cast", () => {
    const cases: [unknown, boolean][] = [
      [null, false],
      [undefined, false],
      [false, false],
      [true, true],
      [0, false],
      [1, true],
      ["", false],
      ["x", true],
      [[], false],
      [[0, ""], false],
      [[0, 1], true],
      [{}, false],
      [{ a: 1 }, true],
    ];
    for (const [v, want] of cases) expect([v, isTruthy(v)]).toEqual([v, want]);
  });
});

describe("bareExpression", () => {
  it("accepts JSONata with or without the wrapper", () => {
    expect(bareExpression("inputs.n > 1")).toBe("inputs.n > 1");
    expect(bareExpression("={{ inputs.n > 1 }}")).toBe("inputs.n > 1");
  });
});
