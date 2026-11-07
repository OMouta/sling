import { type NodeContext, NodeError } from "@sling/workflow";
import type { AppContext } from "../context.ts";
import { workspaceTimeZone } from "../timezone.ts";
import { loadInstallation } from "../workflows/connectors/installations.ts";
import type { AnyServerNodeSpec, EngineServices, RunInfo } from "../workflows/types.ts";

/**
 * A context for calling one of a node's functions outside any workflow run,
 * the way checks call `verify` or an email search. It loads only accounts of
 * the node's own connector, and collects their secrets so what comes back
 * can be scrubbed of them.
 */
export function nodeContext(
  ctx: AppContext,
  spec: AnyServerNodeSpec,
  opts: {
    workspaceId: string;
    ownerId: string;
    installationId: string | null;
    /** Stands in for a run: what the node logs and dedupes under. */
    key: string;
    attempt: number;
    signal: AbortSignal;
  },
): { context: NodeContext<EngineServices>; secrets: Set<string> } {
  const secrets = new Set<string>();
  const run: RunInfo = {
    id: opts.key,
    workflowId: "",
    versionId: "",
    workspaceId: opts.workspaceId,
    ownerId: opts.ownerId,
    triggerNodeId: "",
    installationId: opts.installationId,
    parentRunId: null,
    vars: {},
  };
  let zone: Promise<string> | null = null;
  const services: EngineServices = {
    app: ctx,
    engine: ctx.engine,
    run,
    evaluate: async () => {
      throw new NodeError("Nothing is evaluated as an expression here", {
        code: "no_expressions",
      });
    },
    timeZone: () => {
      zone ??= workspaceTimeZone(ctx, opts.workspaceId);
      return zone;
    },
  };
  const log = ctx.log.child({ check: opts.key, node: spec.type });
  const context: NodeContext<EngineServices> = {
    runId: opts.key,
    nodeId: spec.type.replace(/\./g, "_"),
    nodeRunId: opts.key,
    workflowId: "",
    workspaceId: opts.workspaceId,
    ownerId: opts.ownerId,
    iteration: 0,
    attempt: opts.attempt,
    idempotencyKey: opts.key,
    signal: opts.signal,
    log: {
      info: (m, d) => log.info(d ?? {}, m),
      warn: (m, d) => log.warn(d ?? {}, m),
      error: (m, d) => log.error(d ?? {}, m),
    },
    installation: async (id) => {
      const loaded = await loadInstallation(ctx, opts.workspaceId, id);
      if (loaded.installation.connectorId !== spec.connector) {
        throw new NodeError(`${spec.type} can't use installation ${loaded.installation.name}`, {
          code: "installation_not_allowed",
        });
      }
      for (const s of loaded.secrets) secrets.add(s);
      return loaded.installation as never;
    },
    services,
  };
  return { context, secrets };
}

/** The newest version of a node type the registry has, or null. */
export function latestSpec(ctx: AppContext, type: string): AnyServerNodeSpec | null {
  let best: AnyServerNodeSpec | null = null;
  for (const spec of ctx.registry.specs()) {
    if (spec.type !== type) continue;
    if (!best || spec.version > best.version) best = spec;
  }
  return best;
}

/** Text with each secret replaced, so nothing from an account's credentials is stored. */
export function scrub(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[hidden]");
  return out;
}
