import type { NodeContext, NodeSpec, PortedSpec } from "@sling/workflow";
import type { AppContext } from "../context.ts";
import type { Engine } from "./engine.ts";

/** What a run looks like to the nodes running in it. */
export interface RunInfo {
  id: string;
  workflowId: string;
  versionId: string;
  workspaceId: string;
  ownerId: string;
  triggerNodeId: string;
  /** Installation of the connector event that started the run, if any. */
  installationId: string | null;
  parentRunId: string | null;
  /** Run variables. `core.set_var` writes here; the engine saves them after the node. */
  vars: Record<string, unknown>;
}

/** Services the engine hands to server-side nodes. Connector nodes never see these. */
export interface EngineServices {
  app: AppContext;
  engine: Engine;
  run: RunInfo;
  /** Evaluates JSONata against this node's scope: `{ inputs, trigger, vars, execution }`. */
  evaluate(source: string): Promise<unknown>;
}

export type ServerNodeContext = NodeContext<EngineServices>;

/**
 * A node spec as the server registers it. Two optional extras beyond the
 * shared contract: config checks run at publish time, and idempotency that
 * depends on config (an HTTP GET is safe to repeat, a POST isn't).
 */
export type ServerNodeSpec<Config = Record<string, unknown>> = NodeSpec<Config, EngineServices> & {
  checkConfig?: PortedSpec["checkConfig"];
  idempotentWhen?(config: Record<string, unknown>): boolean;
};

// biome-ignore lint/suspicious/noExplicitAny: a registry holds specs of every config shape.
export type AnyServerNodeSpec = ServerNodeSpec<any>;

/** Builds a spec with its config type inferred from the schema. */
export function defineNode<Config>(spec: ServerNodeSpec<Config>): ServerNodeSpec<Config> {
  return spec;
}
