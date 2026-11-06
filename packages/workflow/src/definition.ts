import { z } from "zod";

/** Format tag for workflow JSON. Bump only with a migration path. */
export const WORKFLOW_SCHEMA = "sling.workflow/v1";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "IDs use letters, digits, '_' and '-'");

/**
 * Node types: dot-separated lowercase names, such as `core.if`. Extension IDs
 * may contain hyphens, so their node types can too (`acme-crm.create_contact`).
 */
export const NODE_TYPE_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

export const PositionSchema = z.object({ x: z.number(), y: z.number() });

export const NodeInstanceSchema = z.object({
  id,
  /** NodeSpec.type, for example "core.if" or "discord.send_message". */
  type: z.string().regex(NODE_TYPE_PATTERN),
  /** NodeSpec.version the config was written for. */
  version: z.number().int().positive(),
  label: z.string().max(120).optional(),
  position: PositionSchema,
  config: z.record(z.string(), z.unknown()).default({}),
});

export const PortRefSchema = z.object({ node: id, port: z.string().min(1).max(64) });

export const EdgeSchema = z.object({
  id,
  kind: z.enum(["exec", "data"]),
  from: PortRefSchema,
  to: PortRefSchema,
});

export const WorkflowDefinitionSchema = z.object({
  schema: z.literal(WORKFLOW_SCHEMA),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  nodes: z.array(NodeInstanceSchema).max(500),
  edges: z.array(EdgeSchema).max(2000),
});

export type Position = z.infer<typeof PositionSchema>;
export type NodeInstance = z.infer<typeof NodeInstanceSchema>;
export type PortRef = z.infer<typeof PortRefSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export function emptyDefinition(name: string): WorkflowDefinition {
  return { schema: WORKFLOW_SCHEMA, name, description: "", nodes: [], edges: [] };
}

/** Every exec input is called this. */
export const EXEC_IN = "in";
/** Implicit exec output taken when a node fails, if it's connected. */
export const EXEC_ERROR = "error";

const EXPRESSION = /^=\{\{([\s\S]*)\}\}$/;

/** Config strings written as `={{ … }}` hold a JSONata expression. */
export function isExpression(value: unknown): value is string {
  return typeof value === "string" && EXPRESSION.test(value.trim());
}

export function expressionSource(value: string): string {
  const m = EXPRESSION.exec(value.trim());
  return m?.[1]?.trim() ?? "";
}

export function toExpression(source: string): string {
  return `={{ ${source} }}`;
}
