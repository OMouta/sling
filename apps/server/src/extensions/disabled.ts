/**
 * Connectors that stand in for an extension whose code can't run: disabled,
 * revoked, broken, or on a server that can't isolate it. They come from the
 * stored description, so workflows that use the extension still validate and
 * the editor still shows its nodes, but nothing reaches the extension's code.
 */
import type {
  AnyConnector,
  ConnectorDescription,
  ExtensionDescription,
  JsonSchemaObject,
  NodeDescription,
} from "@sling/connector-sdk";
import { type AnyNodeSpec, NodeError } from "@sling/workflow";
import { z } from "zod";

export const DISABLED_MESSAGE = "The extension is disabled";
export const DISABLED_CODE = "extension_disabled";

/** A zod schema from JSON Schema. Anything it can't convert accepts any object. */
export function schemaFromJson(schema: JsonSchemaObject): z.ZodType {
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

function standInNode(connectorId: string, n: NodeDescription, reason: string): AnyNodeSpec {
  const fail = async (): Promise<never> => {
    throw new NodeError(reason, { code: DISABLED_CODE });
  };
  return {
    type: n.type,
    version: n.version,
    title: n.title,
    description: n.description,
    category: n.category,
    connector: connectorId,
    configSchema: schemaFromJson(n.configSchema),
    expressionFields: [...n.expressionFields],
    installationFields: [...n.installationFields],
    inputs: n.inputs,
    outputs: n.outputs,
    execInput: n.execInput,
    execOutputs: n.execOutputs,
    ...(n.dynamicExecOutputs ? { dynamicExecOutputs: n.dynamicExecOutputs } : {}),
    idempotent: n.idempotent,
    ...(n.retry ? { retry: n.retry } : {}),
    ...(n.trigger ? { trigger: { event: n.trigger.event, match: () => null } } : { run: fail }),
    ...(n.hasResume ? { resume: fail } : {}),
  };
}

function standInConnector(c: ConnectorDescription, reason: string): AnyConnector {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    ...(c.setupHelp ? { setupHelp: c.setupHelp } : {}),
    credentialsSchema: schemaFromJson(c.credentialsSchema),
    secretFields: [...c.secretFields],
    configSchema: schemaFromJson(c.configSchema),
    test: async () => ({ ok: false, error: reason }),
    nodes: c.nodes.map((n) => standInNode(c.id, n, reason)),
  };
}

/** Stand-ins for every connector the description lists. Their nodes fail with `reason`. */
export function standInConnectors(
  description: ExtensionDescription,
  reason: string = DISABLED_MESSAGE,
): AnyConnector[] {
  return description.connectors.map((c) => standInConnector(c, reason));
}
