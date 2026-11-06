/**
 * The workflow node contract: what a node declares (ports, config, exec
 * outputs) and what it gets while it runs.
 */
import type { NodeSpec } from "@sling/workflow/spec";

export {
  type AnyNodeSpec,
  type AssistantUse,
  type DynamicExecOutputs,
  type ExecPortSpec,
  type Installation,
  type NodeCategory,
  type NodeContext,
  NodeError,
  type NodeLogger,
  type NodeResult,
  type NodeRunArgs,
  type NodeSpec,
  type PortSpec,
  type RetryPolicy,
  type TriggerEvent,
  type TriggerMatch,
  type TriggerSpec,
  type WaitResolution,
  type WaitSpec,
} from "@sling/workflow/spec";
export { NAMED_TYPES, type NamedType, type PortType } from "@sling/workflow/types";

/**
 * Builds a node spec with its config type inferred from the schema. In an
 * extension, `ctx.services` is undefined: nodes get only what `NodeContext`
 * lists.
 */
export function defineNode<Config>(spec: NodeSpec<Config>): NodeSpec<Config> {
  return spec;
}
