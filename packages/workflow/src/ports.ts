import { EXEC_ERROR } from "./definition.ts";
import {
  type AnyNodeSpec,
  type DynamicExecOutputs,
  type ExecPortSpec,
  execOutputsOf,
  type PortSpec,
} from "./spec.ts";

/**
 * The parts of a node spec that validation and traversal need. Both a server
 * `NodeSpec` and the editor's `NodeSpecView` fit.
 */
export interface PortedSpec {
  type: string;
  version: number;
  inputs: PortSpec[];
  outputs: PortSpec[];
  execInput: boolean;
  execOutputs: ExecPortSpec[];
  dynamicExecOutputs?: DynamicExecOutputs | null;
  expressionFields?: string[];
  /** A zod schema. Config is only checked when it has `safeParse`. */
  configSchema?: unknown;
  /** Extra config checks beyond the schema, for example JSONata syntax. */
  checkConfig?(config: Record<string, unknown>): { field?: string; message: string }[];
}

export interface SpecLookup {
  get(type: string, version: number): PortedSpec | undefined;
}

export function specKey(type: string, version: number): string {
  return `${type}@${version}`;
}

/** A lookup over a fixed list of specs. */
export function specLookup(specs: Iterable<PortedSpec>): SpecLookup {
  const map = new Map<string, PortedSpec>();
  for (const s of specs) map.set(specKey(s.type, s.version), s);
  return { get: (type, version) => map.get(specKey(type, version)) };
}

/** Triggers are the nodes with no exec input. */
export function isTrigger(spec: Pick<PortedSpec, "execInput">): boolean {
  return !spec.execInput;
}

/** The data output every non-trigger node gets for its failure, `{ message, code }`. */
export const ERROR_OUTPUT: PortSpec = {
  name: EXEC_ERROR,
  type: "json",
  label: "Error",
  description: "Set when the node fails and its error exec output is connected: { message, code }.",
};

/** Exec output names for a node instance, including dynamic ones and `error`. */
export function execOutputNames(spec: PortedSpec, config: Record<string, unknown>): string[] {
  const names = execOutputsOf(spec as unknown as AnyNodeSpec, config).map((p) => p.name);
  if (!isTrigger(spec) && !names.includes(EXEC_ERROR)) names.push(EXEC_ERROR);
  return names;
}

/** Data outputs, including the implicit `error` output on non-trigger nodes. */
export function dataOutputs(spec: PortedSpec): PortSpec[] {
  if (isTrigger(spec) || spec.outputs.some((p) => p.name === EXEC_ERROR)) return spec.outputs;
  return [...spec.outputs, ERROR_OUTPUT];
}
