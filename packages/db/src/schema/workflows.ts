import type { NodeRunStatus, RunStatus } from "@sling/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { credentials, workspaces } from "./sling.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").defaultNow().notNull();
const updatedAt = () =>
  ts("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();
const owned = () => ({
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
});

/** Stored as JSON. The shape is WorkflowDefinition from @sling/workflow. */
type DefinitionJson = Record<string, unknown>;

export const workflows = pgTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    ...owned(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(false),
    /** No foreign key: versions reference workflows, and this points back. */
    activeVersionId: text("active_version_id"),
    draft: jsonb("draft").$type<DefinitionJson>().notNull(),
    /**
     * Goes up by one with every write to the draft. A save names the revision
     * it was based on, so an editor can't overwrite a change it hasn't seen.
     */
    draftRevision: integer("draft_revision").notNull().default(1),
    /** Set when the draft differs from the active version. */
    draftDirty: boolean("draft_dirty").notNull().default(true),
    templateKey: text("template_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("workflows_workspace_idx").on(t.workspaceId, t.updatedAt)],
);

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: text("id").primaryKey(),
    ...owned(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    definition: jsonb("definition").$type<DefinitionJson>().notNull(),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("workflow_versions_number_idx").on(t.workflowId, t.number)],
);

/** One row per trigger node of an enabled workflow's active version. */
export const workflowTriggers = pgTable(
  "workflow_triggers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    versionId: text("version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    /** TriggerSpec.event, for example "email.received". */
    event: text("event").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    installationId: text("installation_id"),
    /** SHA-256 of the webhook token, for `core.webhook`. */
    webhookTokenHash: text("webhook_token_hash").unique(),
    createdAt: createdAt(),
  },
  (t) => [
    index("workflow_triggers_event_idx").on(t.workspaceId, t.event),
    index("workflow_triggers_workflow_idx").on(t.workflowId),
  ],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    ...owned(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    versionId: text("version_id")
      .notNull()
      .references(() => workflowVersions.id),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    triggerNodeId: text("trigger_node_id").notNull(),
    triggerType: text("trigger_type").notNull(),
    triggerPayload: jsonb("trigger_payload").notNull(),
    /** Runs sharing a key run one at a time, oldest first. */
    concurrencyKey: text("concurrency_key"),
    /** Engine state: current node, loop frames, variables, node outputs. */
    cursor: jsonb("cursor").$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb("output"),
    error: jsonb("error").$type<{ message: string; code: string; nodeId?: string }>(),
    parentRunId: text("parent_run_id"),
    parentNodeRunId: text("parent_node_run_id"),
    /** Dedupe key from the event that started it, so a repeated event doesn't start a second run. */
    dedupeKey: text("dedupe_key"),
    nodeRunCount: integer("node_run_count").notNull().default(0),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("workflow_runs_workflow_idx").on(t.workflowId, t.createdAt),
    index("workflow_runs_status_idx").on(t.status),
    index("workflow_runs_key_idx").on(t.concurrencyKey, t.createdAt),
    uniqueIndex("workflow_runs_dedupe_idx")
      .on(t.workflowId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
);

export const nodeRuns = pgTable(
  "node_runs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    nodeType: text("node_type").notNull(),
    iteration: integer("iteration").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    status: text("status").$type<NodeRunStatus>().notNull(),
    execPort: text("exec_port"),
    /** Redacted before storage. */
    inputs: jsonb("inputs").$type<Record<string, unknown>>(),
    outputs: jsonb("outputs").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<{ message: string; code: string }>(),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: ts("started_at").defaultNow().notNull(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("node_runs_run_idx").on(t.runId, t.startedAt)],
);

/** A parked run and what wakes it. */
export const runWaits = pgTable(
  "run_waits",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    nodeRunId: text("node_run_id")
      .notNull()
      .references(() => nodeRuns.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"timer" | "approval" | "task" | "event">().notNull(),
    /** Approval ID, task ID, or event key. */
    key: text("key"),
    eventType: text("event_type"),
    resumeAt: ts("resume_at"),
    createdAt: createdAt(),
  },
  (t) => [index("run_waits_key_idx").on(t.kind, t.key)],
);

export const connectorInstallations = pgTable(
  "connector_installations",
  {
    id: text("id").primaryKey(),
    ...owned(),
    connectorId: text("connector_id").notNull(),
    name: text("name").notNull(),
    credentialId: text("credential_id").references(() => credentials.id, {
      onDelete: "set null",
    }),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status")
      .$type<"idle" | "connecting" | "connected" | "error" | "disabled">()
      .notNull()
      .default("idle"),
    statusDetail: text("status_detail"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("connector_installations_workspace_idx").on(t.workspaceId)],
);

export const connectorState = pgTable(
  "connector_state",
  {
    installationId: text("installation_id")
      .notNull()
      .references(() => connectorInstallations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.installationId, t.key] })],
);

export const workflowKv = pgTable(
  "workflow_kv",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.key] })],
);
