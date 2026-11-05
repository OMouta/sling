import jsonata from "jsonata";
import { expressionSource, isExpression } from "./definition.ts";

/** Wall-clock limit for one evaluation. */
export const EXPRESSION_TIMEOUT_MS = 1000;
/** Nesting limit for one evaluation, which also bounds recursive functions. */
export const EXPRESSION_MAX_DEPTH = 300;
/** Longest sequence an expression may build, so `[1..9999999]` can't eat memory. */
export const EXPRESSION_MAX_SEQUENCE = 1_000_000;

/** What an expression can see. */
export interface ExpressionScope {
  /** The node's resolved data inputs. */
  inputs: Record<string, unknown>;
  /** Outputs of the trigger that started the run. */
  trigger: Record<string, unknown>;
  /** Run-scoped variables set by `core.set_var`. */
  vars: Record<string, unknown>;
  /** Run and node identifiers. */
  execution: Record<string, unknown>;
}

export class ExpressionError extends Error {
  readonly code: string;
  readonly position: number | null;
  constructor(message: string, code: string, position: number | null = null) {
    super(message);
    this.name = "ExpressionError";
    this.code = code;
    this.position = position;
  }
}

interface JsonataFailure {
  code?: string;
  message?: string;
  position?: number;
}

function wrap(err: unknown, source: string): ExpressionError {
  if (err instanceof ExpressionError) return err;
  const e = (err ?? {}) as JsonataFailure;
  const code = e.code ?? "expression_error";
  if (code === "D1012") {
    return new ExpressionError(
      `Expression took longer than ${EXPRESSION_TIMEOUT_MS} ms`,
      "expression_timeout",
    );
  }
  if (code === "D1011") {
    return new ExpressionError(
      `Expression nested deeper than ${EXPRESSION_MAX_DEPTH} levels`,
      "expression_depth",
    );
  }
  const where = typeof e.position === "number" ? ` (at ${e.position})` : "";
  const message = e.message ?? String(err);
  return new ExpressionError(
    `${message}${where} in: ${source.slice(0, 200)}`,
    code,
    e.position ?? null,
  );
}

const CACHE_LIMIT = 500;
const compiled = new Map<string, jsonata.Expression>();

/**
 * Compiles JSONata with the time, depth, and sequence limits applied. The
 * limits are tracked per evaluation, so one compiled expression can be
 * evaluated concurrently.
 */
export function compileExpression(source: string): jsonata.Expression {
  const hit = compiled.get(source);
  if (hit) return hit;
  let expr: jsonata.Expression;
  try {
    expr = jsonata(source, {
      timeout: EXPRESSION_TIMEOUT_MS,
      stack: EXPRESSION_MAX_DEPTH,
      sequence: EXPRESSION_MAX_SEQUENCE,
    });
  } catch (err) {
    throw wrap(err, source);
  }
  if (compiled.size >= CACHE_LIMIT) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) compiled.delete(oldest);
  }
  compiled.set(source, expr);
  return expr;
}

/** Returns a syntax error message, or null if the source compiles. */
export function checkExpression(source: string): string | null {
  if (!source.trim()) return "The expression is empty";
  try {
    compileExpression(source);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Turns a JSONata result into plain JSON. `undefined` (no match) becomes null. */
function toJson(value: unknown, source: string): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "function") {
    throw new ExpressionError(`Expression returned a function: ${source}`, "expression_result");
  }
  if (typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  }
  const json = JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "function" || isLambda(v)) {
      throw new ExpressionError(`Expression returned a function: ${source}`, "expression_result");
    }
    return v;
  });
  return JSON.parse(json);
}

/** JSONata functions are objects tagged with these flags. */
function isLambda(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { _jsonata_lambda?: unknown; _jsonata_function?: unknown };
  return o._jsonata_lambda === true || o._jsonata_function === true;
}

/** Evaluates JSONata source (without the `={{ }}` wrapper) against a scope. */
export async function evaluateExpression(source: string, scope: ExpressionScope): Promise<unknown> {
  const expr = compileExpression(source);
  try {
    return toJson(await expr.evaluate(scope), source);
  } catch (err) {
    throw wrap(err, source);
  }
}

/** Evaluates a config value if it's written as `={{ … }}`, else returns it unchanged. */
export async function evaluateValue(value: unknown, scope: ExpressionScope): Promise<unknown> {
  if (!isExpression(value)) return value;
  return evaluateExpression(expressionSource(value), scope);
}

/**
 * Evaluates the `={{ … }}` values of the given config keys. Returns a new
 * config object and the keys that held expressions.
 */
export async function evaluateConfig(
  config: Record<string, unknown>,
  fields: readonly string[],
  scope: ExpressionScope,
): Promise<{ config: Record<string, unknown>; evaluated: string[] }> {
  const out: Record<string, unknown> = { ...config };
  const evaluated: string[] = [];
  for (const key of fields) {
    const raw = config[key];
    if (!isExpression(raw)) continue;
    try {
      out[key] = await evaluateExpression(expressionSource(raw), scope);
    } catch (err) {
      const e = wrap(err, expressionSource(raw));
      throw new ExpressionError(`${key}: ${e.message}`, e.code, e.position);
    }
    evaluated.push(key);
  }
  return { config: out, evaluated };
}

/**
 * JSONata's boolean cast: empty strings, zero, null, empty arrays and
 * objects, and arrays with no truthy member are false.
 */
export function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.some(isTruthy);
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/**
 * JSONata written either bare (`inputs.value > 3`) or wrapped (`={{ … }}`),
 * for config fields that always hold an expression.
 */
export function bareExpression(value: string): string {
  const trimmed = value.trim();
  return isExpression(trimmed) ? expressionSource(trimmed) : trimmed;
}
