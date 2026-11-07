/**
 * What an extension's bundle exports, and the description Sling reads from it
 * when the package is installed.
 */
import type {
  AssistantUse,
  DynamicExecOutputs,
  ExecPortSpec,
  NodeCategory,
  PortSpec,
  RetryPolicy,
} from "@sling/workflow/spec";
import { z } from "zod";
import type { AnyConnector } from "./connector.ts";
import { SDK_VERSION } from "./manifest.ts";

/** A JSON Schema document, as `z.toJSONSchema` produces it. */
export type JsonSchemaObject = Record<string, unknown>;

export interface NodeDescription {
  type: string;
  version: number;
  title: string;
  description: string;
  category: NodeCategory;
  inputs: PortSpec[];
  outputs: PortSpec[];
  execInput: boolean;
  execOutputs: ExecPortSpec[];
  dynamicExecOutputs: DynamicExecOutputs | null;
  configSchema: JsonSchemaObject;
  expressionFields: string[];
  installationFields: string[];
  idempotent: boolean;
  retry: RetryPolicy | null;
  /** Present on trigger nodes. */
  trigger: { event: string } | null;
  hasResume: boolean;
  /** Present when the assistant may call the node from chat. Absent in descriptions from SDK 1.0. */
  assistant?: AssistantUse | null;
}

export interface ConnectorDescription {
  id: string;
  name: string;
  description: string;
  setupHelp: string | null;
  credentialsSchema: JsonSchemaObject;
  secretFields: string[];
  configSchema: JsonSchemaObject;
  hasSource: boolean;
  isExecutionProvider: boolean;
  /** Has a setup lookup. Absent in descriptions from SDK 1.1 and older. */
  hasSetup?: boolean;
  nodes: NodeDescription[];
}

/** Everything an extension adds, as plain JSON. Sling stores it when the package is installed. */
export interface ExtensionDescription {
  format: "sling.description/v1";
  /** The SDK version the bundle was built with. */
  sdkVersion: string;
  connectors: ConnectorDescription[];
}

export interface ExtensionDefinition {
  connectors: AnyConnector[];
  /** Turns every schema into JSON Schema with the extension's own copy of zod. */
  describe(): ExtensionDescription;
}

function jsonSchema(schema: unknown): JsonSchemaObject {
  const out = z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "any" });
  const { $schema: _drop, ...rest } = out as Record<string, unknown>;
  return rest;
}

/**
 * The default export of an extension's bundle:
 *
 * ```ts
 * export default defineExtension({ connectors: [myConnector] });
 * ```
 */
export function defineExtension(def: { connectors: AnyConnector[] }): ExtensionDefinition {
  const connectors = [...def.connectors];
  return {
    connectors,
    describe: () => ({
      format: "sling.description/v1",
      sdkVersion: SDK_VERSION,
      connectors: connectors.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        setupHelp: c.setupHelp ?? null,
        credentialsSchema: jsonSchema(c.credentialsSchema),
        secretFields: [...c.secretFields],
        configSchema: jsonSchema(c.configSchema),
        hasSource: c.source !== undefined,
        isExecutionProvider: c.executionProvider !== undefined,
        hasSetup: typeof c.setup === "function",
        nodes: c.nodes.map((n) => ({
          type: n.type,
          version: n.version,
          title: n.title,
          description: n.description,
          category: n.category,
          inputs: n.inputs,
          outputs: n.outputs,
          execInput: n.execInput,
          execOutputs: n.execOutputs,
          dynamicExecOutputs: n.dynamicExecOutputs ?? null,
          configSchema: jsonSchema(n.configSchema),
          expressionFields: n.expressionFields ?? [],
          installationFields: n.installationFields ?? [],
          idempotent: n.idempotent,
          retry: n.retry ?? null,
          trigger: n.trigger ? { event: n.trigger.event } : null,
          hasResume: typeof n.resume === "function",
          assistant: n.assistant
            ? {
                sends: n.assistant.sends,
                ...(n.assistant.summary ? { summary: n.assistant.summary } : {}),
              }
            : null,
        })),
      })),
    }),
  };
}
