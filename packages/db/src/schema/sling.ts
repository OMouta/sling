import type {
  ActionKind,
  ActionState,
  ApprovalState,
  Delivery,
  PermissionMode,
  TaskState,
} from "@sling/core";
import {
  bigint,
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

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").defaultNow().notNull();
const updatedAt = () =>
  ts("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

/** Columns every owned record carries, so multi-user support needs no migration. */
const owned = () => ({
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
});

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  defaultMode: text("default_mode").$type<PermissionMode>().notNull().default("auto"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<"owner" | "admin" | "member">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const credentials = pgTable("credentials", {
  id: text("id").primaryKey(),
  ...owned(),
  kind: text("kind").$type<"model_api_key">().notNull(),
  /** base64 of iv | auth tag | ciphertext, AES-256-GCM. */
  ciphertext: text("ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type ModelProviderId = "openai" | "anthropic" | "openai-compatible";

export const modelConfigs = pgTable("model_configs", {
  id: text("id").primaryKey(),
  ...owned(),
  provider: text("provider").$type<ModelProviderId>().notNull(),
  model: text("model").notNull(),
  baseUrl: text("base_url"),
  credentialId: text("credential_id").references(() => credentials.id, {
    onDelete: "set null",
  }),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface RunnerCapability {
  name: string;
  version: string;
  ready: boolean;
  detail: string;
}

export const runners = pgTable(
  "runners",
  {
    id: text("id").primaryKey(),
    ...owned(),
    name: text("name").notNull(),
    /** Raw 32-byte Ed25519 public key, base64. */
    publicKey: text("public_key").notNull(),
    online: boolean("online").notNull().default(false),
    lastSeenAt: ts("last_seen_at"),
    version: text("version"),
    os: text("os"),
    arch: text("arch"),
    hostname: text("hostname"),
    capabilities: jsonb("capabilities").$type<RunnerCapability[]>().notNull().default([]),
    maxMode: text("max_mode").$type<PermissionMode>().notNull().default("full-access"),
    maxConcurrentTasks: integer("max_concurrent_tasks").notNull().default(2),
    pairedAt: createdAt(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("runners_workspace_idx").on(t.workspaceId)],
);

export const runnerEnrollments = pgTable("runner_enrollments", {
  id: text("id").primaryKey(),
  ...owned(),
  /** SHA-256 of the one-time code, hex. */
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  runnerId: text("runner_id").references(() => runners.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const repos = pgTable(
  "repos",
  {
    id: text("id").primaryKey(),
    ...owned(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    remoteUrl: text("remote_url").notNull().default(""),
    network: boolean("network").notNull().default(false),
    /** Set when the Runner stops advertising this repo. */
    removedAt: ts("removed_at"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("repos_runner_name_idx").on(t.runnerId, t.name)],
);

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    ...owned(),
    title: text("title").notNull().default("New conversation"),
    mode: text("mode").$type<PermissionMode>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts("archived_at"),
  },
  (t) => [index("conversations_workspace_idx").on(t.workspaceId, t.updatedAt)],
);

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    ...owned(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant" | "tool" | "system">().notNull(),
    /** An AI SDK ModelMessage, stored as-is so it can be replayed to the model. */
    content: jsonb("content").notNull(),
    /** Set on system notes the server adds when a task changes. */
    taskId: text("task_id"),
    usage: jsonb("usage").$type<TokenUsage>(),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.id)],
);

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ...owned(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runners.id),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id),
    repoName: text("repo_name").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    /** Mode the task started with. Later mode switches don't change it. */
    mode: text("mode").$type<PermissionMode>().notNull(),
    deliver: text("deliver").$type<Delivery>().notNull().default("pr"),
    harness: text("harness").notNull().default("codex"),
    state: text("state").$type<TaskState>().notNull().default("queued"),
    branch: text("branch").notNull(),
    baseSha: text("base_sha"),
    commitSha: text("commit_sha"),
    diffStats: jsonb("diff_stats").$type<DiffStats>(),
    summary: text("summary"),
    error: text("error"),
    harnessVersion: text("harness_version"),
    usage: jsonb("usage").$type<TokenUsage>(),
    /** Highest event seq stored for this task. */
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    /** Bytes of event payload stored, for the per-task cap. */
    eventBytes: integer("event_bytes").notNull().default(0),
    cancelRequestedAt: ts("cancel_requested_at"),
    runnerOfflineSince: ts("runner_offline_since"),
    createdAt: createdAt(),
    dispatchedAt: ts("dispatched_at"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_conversation_idx").on(t.conversationId),
    index("tasks_runner_state_idx").on(t.runnerId, t.state),
    index("tasks_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const taskEvents = pgTable(
  "task_events",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    at: ts("at").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.seq] }), index("task_events_at_idx").on(t.at)],
);

export const actions = pgTable(
  "actions",
  {
    id: text("id").primaryKey(),
    ...owned(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ActionKind>().notNull(),
    /** Run order within a task: push before PR. */
    position: integer("position").notNull(),
    state: text("state").$type<ActionState>().notNull(),
    requiresApproval: boolean("requires_approval").notNull(),
    prTitle: text("pr_title"),
    prBody: text("pr_body"),
    url: text("url"),
    message: text("message"),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
    finishedAt: ts("finished_at"),
    updatedAt: updatedAt(),
  },
  (t) => [index("actions_task_idx").on(t.taskId, t.position)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    ...owned(),
    actionId: text("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    state: text("state").$type<ApprovalState>().notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_workspace_state_idx").on(t.workspaceId, t.state)],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    ...owned(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type").$type<"branch" | "commit" | "pr" | "compare">().notNull(),
    ref: text("ref").notNull(),
    url: text("url"),
    createdAt: createdAt(),
  },
  (t) => [index("artifacts_task_idx").on(t.taskId)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorType: text("actor_type").$type<"user" | "runner" | "agent" | "system">().notNull(),
    actorId: text("actor_id"),
    verb: text("verb").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    details: jsonb("details").notNull().default({}),
    at: ts("at").defaultNow().notNull(),
  },
  (t) => [index("audit_workspace_at_idx").on(t.workspaceId, t.at)],
);
