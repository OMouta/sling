import type { WorkflowDefinition } from "./definition.ts";
import type { DynamicExecOutputs, ExecPortSpec, NodeCategory, PortSpec } from "./spec.ts";
import type { JsonSchema } from "./types.ts";

/** A node spec as the editor sees it. `configSchema` is JSON Schema. */
export interface NodeSpecView {
  type: string;
  version: number;
  title: string;
  description: string;
  category: NodeCategory;
  connector: string | null;
  inputs: PortSpec[];
  outputs: PortSpec[];
  execInput: boolean;
  execOutputs: ExecPortSpec[];
  dynamicExecOutputs: DynamicExecOutputs | null;
  configSchema: JsonSchema;
  expressionFields: string[];
  installationFields: string[];
  idempotent: boolean;
  isTrigger: boolean;
}

export interface NamedTypeView {
  name: string;
  description: string;
  schema: JsonSchema;
}

/** Response of GET /api/workflow-nodes. */
export interface NodeCatalog {
  nodes: NodeSpecView[];
  types: NamedTypeView[];
}

export interface ValidationIssue {
  /** Machine-readable, for example "unknown_node_type" or "type_mismatch". */
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  port?: string;
}

/** GET /api/workflows/:id. Summary fields match WorkflowSummaryView in @sling/core. */
export interface WorkflowDetailView {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  templateKey: string | null;
  activeVersion: number | null;
  hasUnpublishedChanges: boolean;
  draft: WorkflowDefinition;
  /** Goes up with every write to the draft. Saves and publishes send the one they're based on. */
  draftRevision: number;
  /** Definition of the active version, null before the first publish. */
  active: WorkflowDefinition | null;
  /** Webhook URLs for `core.webhook` triggers of the active version. */
  webhooks: { nodeId: string; url: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersionView {
  number: number;
  note: string;
  createdAt: string;
  definition: WorkflowDefinition;
}

/**
 * The body of a 409 from `PUT /api/workflows/:id/draft` or `POST .../publish`
 * when the draft changed after the revision the request was based on: the
 * draft as it's saved now, to load or to save over.
 */
export interface DraftConflictView {
  error: string;
  conflict: {
    revision: number;
    draft: WorkflowDefinition;
    updatedAt: string;
  };
}

export interface PublishResult {
  ok: boolean;
  version: number | null;
  issues: ValidationIssue[];
}

export interface TemplateBinding {
  /** Placeholder used in the template's config values, for example "$discord". */
  placeholder: string;
  connectorId: string;
  label: string;
}

export interface TemplateView {
  key: string;
  name: string;
  description: string;
  bindings: TemplateBinding[];
  /** Whether it's installed by default on first start. */
  builtIn: boolean;
  /** The extension package it came from. Absent for templates bundled with Sling. */
  extension?: { id: string; name: string; version: string; hasIcon: boolean } | null;
}
