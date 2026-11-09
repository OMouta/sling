import type {
  ActionCheckState,
  ActionKind,
  ActionState,
  AgentModelView,
  ApprovalState,
  AssistantChoice,
  ChannelView,
  ChatSettings,
  CheckConfig,
  CheckKind,
  CheckResultDetail,
  CheckResultView,
  CheckState,
  ConversationStartedBy,
  Delivery,
  DeployCheck,
  DeployCheckResult,
  DeployMethod,
  FeedbackRating,
  FoundRepoView,
  GlyphShape,
  Harness,
  MemorySourceKind,
  MergeMethod,
  ModelProviderId,
  NotificationSettings,
  PermissionMode,
  PersonalityColor,
  PersonalityTool,
  ReplyTrace,
  RoutingView,
  RuleKind,
  SandboxState,
  SourceKind,
  SourceState,
  StartRuleEvent,
  StartRuleMode,
  TaskState,
  VerifyDetail,
} from "@sling/core";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  doublePrecision,
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
import { connectorInstallations } from "./workflows.ts";

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

/** Workspace sandbox limits. Unset keys use the defaults. */
export interface SandboxSettings {
  concurrentLimit?: number;
  lifetimeMinutes?: number;
  monthlyMinutesBudget?: number;
  /** Provider installation ID to estimated cost per hour. */
  costPerHour?: Record<string, number>;
}

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  defaultMode: text("default_mode").$type<PermissionMode>().notNull().default("auto"),
  /** Coding agent for tasks that don't name one. */
  defaultHarness: text("default_harness").$type<Harness>().notNull().default("codex"),
  sandboxSettings: jsonb("sandbox_settings").$type<SandboxSettings>().notNull().default({}),
  /** What new conversations start with: the assistant's model and the coding agent. */
  chatDefaults: jsonb("chat_defaults").$type<ChatSettings>(),
  /** IANA time zone, such as Europe/Lisbon. Null until the web app sets it; null counts as UTC. */
  timeZone: text("time_zone"),
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
    /** Which pushes this member gets. Null uses the defaults. */
    notifications: jsonb("notifications").$type<NotificationSettings>(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export type CredentialKind =
  | "model_api_key"
  | "connector"
  | "harness_openai"
  | "harness_anthropic"
  | "git_token"
  | "deploy_hook";

export const credentials = pgTable("credentials", {
  id: text("id").primaryKey(),
  ...owned(),
  /**
   * `model_api_key` for the assistant's model, `connector` for an installation's
   * blob, the sandbox secrets (`harness_openai`, `harness_anthropic`, `git_token`),
   * and `deploy_hook` for a deploy target's hook.
   */
  kind: text("kind").$type<CredentialKind>().notNull(),
  /** base64 of iv | auth tag | ciphertext, AES-256-GCM. */
  ciphertext: text("ciphertext").notNull(),
  keyVersion: integer("key_version").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type { ModelProviderId };

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
  models?: AgentModelView[];
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
    /** Labels from the machine's own config, as its inventory reports them. */
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    /** Git repos the machine found that aren't allowed yet, from its inventory. */
    foundRepos: jsonb("found_repos").$type<FoundRepoView[]>().notNull().default([]),
    /** Whether the machine accepts repo changes from Sling. */
    remoteRepos: boolean("remote_repos").notNull().default(false),
    /** Whether the machine accepts merges and deploys, from its inventory. */
    deploys: boolean("deploys").notNull().default(true),
    /** Names of the folders the machine shares, from its inventory. */
    folders: jsonb("folders").$type<string[]>().notNull().default([]),
    /** Whether the machine answers file searches and reads, from its inventory. */
    files: boolean("files").notNull().default(false),
    /** Messaging channels the machine relays, from its inventory. */
    channels: jsonb("channels").$type<ChannelView[]>().notNull().default([]),
    /** A sandbox's Runner: hidden from Machines and revoked with its sandbox. */
    ephemeral: boolean("ephemeral").notNull().default(false),
    sandboxId: text("sandbox_id").references((): AnyPgColumn => sandboxes.id, {
      onDelete: "set null",
    }),
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
  /** Set on codes minted for a sandbox. The Runner that uses it is that sandbox's. */
  sandboxId: text("sandbox_id").references((): AnyPgColumn => sandboxes.id, {
    onDelete: "cascade",
  }),
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
    /** Normalized remote, `host/owner/name`, shared by the same repo on every machine. */
    remoteKey: text("remote_key"),
    network: boolean("network").notNull().default(false),
    /** The deploy command set for this repo in the machine's config. Empty when none. */
    deployCommand: text("deploy_command").notNull().default(""),
    /** How long the machine lets that command run before it stops it. */
    deployTimeoutSeconds: integer("deploy_timeout_seconds").notNull().default(900),
    /** Set when the Runner stops advertising this repo. */
    removedAt: ts("removed_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("repos_runner_name_idx").on(t.runnerId, t.name),
    index("repos_remote_key_idx").on(t.workspaceId, t.remoteKey),
  ],
);

/** Named assistants: their instructions, the tools they may use, and their look. */
export const personalities = pgTable(
  "personalities",
  {
    id: text("id").primaryKey(),
    ...owned(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull(),
    tools: jsonb("tools").$type<PersonalityTool[]>().notNull().default([]),
    color: text("color").$type<PersonalityColor>().notNull(),
    shape: text("shape").$type<GlyphShape>().notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    position: integer("position").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    /** The ready-made personality it was added from. */
    templateKey: text("template_key"),
    /** The model its chats start on. Null uses the workspace default. */
    assistant: jsonb("assistant").$type<AssistantChoice>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Archived instead of deleted, so the chats it answered keep working. */
    archivedAt: ts("archived_at"),
  },
  (t) => [
    index("personalities_workspace_idx").on(t.workspaceId, t.position),
    uniqueIndex("personalities_default_idx")
      .on(t.workspaceId)
      .where(sql`${t.isDefault} and ${t.archivedAt} is null`),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    ...owned(),
    title: text("title").notNull().default("New conversation"),
    mode: text("mode").$type<PermissionMode>().notNull(),
    /** Model choices made in this conversation. */
    settings: jsonb("settings").$type<ChatSettings>(),
    /** Fixed when the chat starts. */
    personalityId: text("personality_id").references(() => personalities.id, {
      onDelete: "set null",
    }),
    /** The coding agent CLI session the assistant's turns resume, and the machine it lives on. */
    agentSession: jsonb("agent_session").$type<{
      harness: Harness;
      runnerId: string;
      sessionId: string;
      /** Who the session answered as. Another personality's turn starts a new one. */
      personalityId?: string | null;
    }>(),
    /** Workflow that owns this conversation. Follow-ups go back through it. */
    workflowId: text("workflow_id"),
    /** Stable key for conversations bound to an outside channel, e.g. `discord:<installation>:<channel>`. */
    externalKey: text("external_key"),
    /** The start rule that opened it, and the check change it reacted to. */
    startedBy: jsonb("started_by").$type<ConversationStartedBy>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts("archived_at"),
    /**
     * When its latest user, assistant, or system message was written, which
     * orders the lists. Null until the first one. Kept in the transaction that
     * writes or removes messages, so a rename doesn't move a chat.
     */
    lastMessageAt: ts("last_message_at"),
  },
  (t) => [
    index("conversations_workspace_idx").on(t.workspaceId, t.updatedAt),
    index("conversations_activity_idx").on(t.workspaceId, t.lastMessageAt, t.id),
    uniqueIndex("conversations_external_key_idx")
      .on(t.workspaceId, t.externalKey)
      .where(sql`${t.externalKey} is not null`),
  ],
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
    /** For an assistant reply: its thinking and tool calls, for the chat to show. Never sent to a model. */
    trace: jsonb("trace").$type<ReplyTrace>(),
    /** What a user message was sent with besides its text. */
    meta: jsonb("meta").$type<MessageMeta>(),
    /**
     * The ID the browser gave a message it sent. A resend after a lost
     * response carries the same one, and gets the message already saved.
     */
    clientId: text("client_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.id),
    uniqueIndex("messages_client_id_idx")
      .on(t.conversationId, t.clientId)
      .where(sql`${t.clientId} is not null`),
  ],
);

export interface MessageMeta {
  /** Deep research for this turn. */
  research?: boolean;
  /** The @mentioned personality, who answers this message. */
  personalityId?: string;
}

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
    /** Null until the task is bound to a machine or a sandbox's Runner. */
    runnerId: text("runner_id").references(() => runners.id),
    repoId: text("repo_id").references(() => repos.id),
    repoName: text("repo_name").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    /** Mode the task started with. Later mode switches don't change it. */
    mode: text("mode").$type<PermissionMode>().notNull(),
    deliver: text("deliver").$type<Delivery>().notNull().default("pr"),
    harness: text("harness").$type<Harness>().notNull().default("codex"),
    environment: text("environment").$type<"machine" | "sandbox">().notNull().default("machine"),
    sandboxId: text("sandbox_id").references((): AnyPgColumn => sandboxes.id, {
      onDelete: "set null",
    }),
    /** Where the router sent the task and why. */
    routing: jsonb("routing").$type<RoutingView>(),
    state: text("state").$type<TaskState>().notNull().default("queued"),
    branch: text("branch").notNull(),
    baseSha: text("base_sha"),
    commitSha: text("commit_sha"),
    diffStats: jsonb("diff_stats").$type<DiffStats>(),
    summary: text("summary"),
    error: text("error"),
    harnessVersion: text("harness_version"),
    /** The agent's model, effort level, and fast tier. Null means the agent's defaults. */
    agentModel: text("agent_model"),
    agentEffort: text("agent_effort"),
    agentFast: boolean("agent_fast").notNull().default(false),
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
    /** Merge, deploy, and verify: the deploy target. */
    targetId: text("target_id").references((): AnyPgColumn => deployTargets.id, {
      onDelete: "set null",
    }),
    /** Merge and deploy: the machine it went to. Null when the control plane did it. */
    runnerId: text("runner_id").references(() => runners.id, { onDelete: "set null" }),
    /** Merge: the merged commit. Deploy and verify: the commit deployed. */
    commitSha: text("commit_sha"),
    /** A deploy command's output, redacted, at most 256 KB. */
    output: text("output"),
    /** Verify: what the checks saw. */
    detail: jsonb("detail").$type<VerifyDetail>(),
    /** The `RepoAction` request a merge or deploy on a machine was sent as. */
    requestId: text("request_id"),
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
    /**
     * `task_action`: a push or PR step. `workflow`: a `human.approval` node.
     * `sandbox_fallback`: run a task in a sandbox because no machine could take it.
     */
    kind: text("kind")
      .$type<"task_action" | "workflow" | "sandbox_fallback">()
      .notNull()
      .default("task_action"),
    title: text("title"),
    /** What a workflow approval shows the approver. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    actionId: text("action_id").references(() => actions.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    state: text("state").$type<ApprovalState>().notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    decidedBy: text("decided_by").references(() => users.id),
    /** Set when decided from outside the web app, for example `discord`. */
    decidedVia: text("decided_via"),
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

/** Fresh environments an execution provider creates for one task, then destroys. */
export const sandboxes = pgTable(
  "sandboxes",
  {
    id: text("id").primaryKey(),
    ...owned(),
    /** The provider's connector installation. Kept after the installation is deleted. */
    providerInstallationId: text("provider_installation_id").notNull(),
    taskId: text("task_id").references((): AnyPgColumn => tasks.id, { onDelete: "set null" }),
    /** The sandbox's own Runner, once it has paired. */
    runnerId: text("runner_id"),
    state: text("state").$type<SandboxState>().notNull().default("requested"),
    /** The provider's own ID, for example a container ID. */
    externalId: text("external_id"),
    image: text("image").notNull().default(""),
    harness: text("harness").$type<Harness>().notNull().default("codex"),
    /** The sandbox repo list entry it clones. */
    remoteKey: text("remote_key").notNull(),
    /** SHA-256 of the one-time pairing code, hex. */
    bootCodeHash: text("boot_code_hash"),
    requestedAt: ts("requested_at").defaultNow().notNull(),
    provisioningAt: ts("provisioning_at"),
    readyAt: ts("ready_at"),
    /** Past this, the sweep destroys it and interrupts its task. */
    expiresAt: ts("expires_at"),
    destroyedAt: ts("destroyed_at"),
    failure: text("failure"),
    /** Billable minutes, from ready to destroyed. Set when destroyed. */
    minutes: doublePrecision("minutes").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sandboxes_workspace_idx").on(t.workspaceId, t.requestedAt),
    index("sandboxes_state_idx").on(t.state),
  ],
);

/** Repos a workspace allows in sandboxes, keyed by normalized remote. */
export const sandboxRepos = pgTable(
  "sandbox_repos",
  {
    ...owned(),
    remoteKey: text("remote_key").notNull(),
    /** HTTPS clone URL. */
    cloneUrl: text("clone_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    network: boolean("network").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.remoteKey] })],
);

/** How a deploy target's hook is called. Stored encrypted as JSON in `credentials`. */
export interface DeployHook {
  url: string;
  httpMethod: "POST" | "GET";
  headerName?: string;
  headerValue?: string;
}

/** What the last health check of a target saw. */
export interface DeployLastCheck {
  at: string;
  up: boolean;
  failures: number;
  results: DeployCheckResult[];
  /** When the checks started answering the way they do now, up or down. */
  since?: string;
}

/** A repo Sling knows how to deploy and check, keyed by its normalized remote. */
export const deployTargets = pgTable(
  "deploy_targets",
  {
    id: text("id").primaryKey(),
    ...owned(),
    name: text("name").notNull(),
    remoteKey: text("remote_key").notNull(),
    method: text("method").$type<DeployMethod>().notNull(),
    mergeMethod: text("merge_method").$type<MergeMethod>().notNull().default("squash"),
    /** `command`: the machine that runs the repo's deploy command. */
    runnerId: text("runner_id").references(() => runners.id, { onDelete: "set null" }),
    /** `hook`: the encrypted DeployHook. */
    hookCredentialId: text("hook_credential_id").references(() => credentials.id, {
      onDelete: "set null",
    }),
    /** `hook`: shown in place of the URL. */
    hookHost: text("hook_host"),
    hookMethod: text("hook_method").$type<"POST" | "GET">(),
    hookHasHeader: boolean("hook_has_header").notNull().default(false),
    /**
     * The site check this target deploys for, which holds its URLs, version
     * URL, and results. Null only for targets made before checks existed and
     * not yet moved.
     */
    checkId: text("check_id").references((): AnyPgColumn => checks.id, { onDelete: "cascade" }),
    /** Copied to the site check, which is what's kept up to date. */
    checks: jsonb("checks").$type<DeployCheck[]>().notNull().default([]),
    /** Copied to the site check, which is what's kept up to date. */
    versionUrl: text("version_url"),
    settleSeconds: integer("settle_seconds").notNull().default(0),
    timeoutSeconds: integer("timeout_seconds").notNull().default(600),
    /** Copied to the site check, which is what's kept up to date. */
    lastCheck: jsonb("last_check").$type<DeployLastCheck>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("deploy_targets_name_idx").on(t.workspaceId, t.name),
    uniqueIndex("deploy_targets_remote_idx").on(t.workspaceId, t.remoteKey),
    uniqueIndex("deploy_targets_check_idx").on(t.checkId),
  ],
);

/** A browser that gets push notifications for one user. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    /** The browser's P-256 public key and auth secret, base64url. */
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    label: text("label").notNull(),
    createdAt: createdAt(),
    lastDeliveredAt: ts("last_delivered_at"),
    lastError: text("last_error"),
    /** Failed deliveries in a row. */
    failures: integer("failures").notNull().default(0),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.workspaceId, t.userId)],
);

/** A Postgres full-text search vector. */
const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

/** Lasting facts about a user, for the assistant's prompt and `recall`. */
export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    /** The owner is the user the memory is about. */
    ...owned(),
    /** At most 500 characters. */
    text: text("text").notNull(),
    /** The one personality that sees it. Null when every personality does. */
    personalityId: text("personality_id").references(() => personalities.id, {
      onDelete: "cascade",
    }),
    source: text("source").$type<MemorySourceKind>().notNull(),
    /** `chat`: the chat and the message it was saved from. */
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Moves when a prompt includes it or `recall` returns it. Starts at creation. */
    lastUsedAt: ts("last_used_at").defaultNow().notNull(),
    /** English stems and the words as written, so a search finds either form. */
    search: tsvector("search").generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', ${memories.text}) || to_tsvector('simple', ${memories.text})`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("memories_used_idx").on(t.workspaceId, t.ownerId, t.lastUsedAt),
    index("memories_search_idx").using("gin", t.search),
  ],
);

/**
 * Standing answers. `allow` skips the question for an action that would ask.
 * `start` opens a chat when a check changes. Revoked, never deleted.
 */
export const rules = pgTable(
  "rules",
  {
    id: text("id").primaryKey(),
    ...owned(),
    kind: text("kind").$type<RuleKind>().notNull(),
    /** One line, for the Rules tab and the audit. */
    summary: text("summary").notNull(),
    /** `allow`: a flagged node type, `run_workflow`, `push`, or `open_pr`. */
    action: text("action"),
    /** `allow`: one account, or null for any. Goes with its installation. */
    installationId: text("installation_id").references(() => connectorInstallations.id, {
      onDelete: "cascade",
    }),
    /** `allow`: pinned argument values. Exact, or a suffix after a leading `*`. */
    match: jsonb("match").$type<Record<string, string>>().notNull().default({}),
    /** `start`: one check, or null for every check. */
    checkId: text("check_id").references((): AnyPgColumn => checks.id, { onDelete: "cascade" }),
    /** `start`: what the check did. */
    on: text("on_event").$type<StartRuleEvent>(),
    /** `start`: who answers. Null uses the default personality. */
    personalityId: text("personality_id").references(() => personalities.id, {
      onDelete: "set null",
    }),
    /** `start`: the first message, with `{check}` and `{results}` filled in. */
    message: text("message"),
    /** `start`: never Full access. */
    mode: text("mode").$type<StartRuleMode>(),
    /** The approval whose Always allow made it. Chat approvals live in memory, so no foreign key. */
    approvalId: text("approval_id"),
    /** The chat it was made from. */
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    uses: integer("uses").notNull().default(0),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("rules_active_idx").on(t.workspaceId, t.kind).where(sql`${t.revokedAt} is null`)],
);

/** What Sling watches on its own: a site, a command on a machine, or an email reply. */
export const checks = pgTable(
  "checks",
  {
    id: text("id").primaryKey(),
    ...owned(),
    kind: text("kind").$type<CheckKind>().notNull(),
    name: text("name").notNull(),
    /** By kind. Its `kind` always matches the column. */
    config: jsonb("config").$type<CheckConfig>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    intervalSeconds: integer("interval_seconds").notNull(),
    /** `reply`: when it turns missed. */
    deadline: ts("deadline"),
    /** `command`: the machine it runs on. */
    runnerId: text("runner_id").references(() => runners.id, { onDelete: "set null" }),
    /** `reply`: the email account it watches. */
    installationId: text("installation_id").references(() => connectorInstallations.id, {
      onDelete: "set null",
    }),
    state: text("state").$type<CheckState>().notNull().default("unknown"),
    stateSince: ts("state_since"),
    /** Failed runs in a row. */
    failures: integer("failures").notNull().default(0),
    lastResult: jsonb("last_result").$type<CheckResultView>(),
    lastRunAt: ts("last_run_at"),
    /** When the scheduler runs it next. Null once a reply check stops. */
    nextRunAt: ts("next_run_at"),
    /** Push to the owner when its state changes. */
    notify: boolean("notify").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("checks_name_idx").on(t.workspaceId, t.name),
    index("checks_due_idx").on(t.nextRunAt).where(sql`${t.enabled} and ${t.nextRunAt} is not null`),
  ],
);

/** Each run of a check. The newest 100 per check are kept. */
export const checkResults = pgTable(
  "check_results",
  {
    id: text("id").primaryKey(),
    checkId: text("check_id")
      .notNull()
      .references(() => checks.id, { onDelete: "cascade" }),
    at: ts("at").notNull(),
    passed: boolean("passed").notNull(),
    /** The check's state after this run. */
    state: text("state").$type<CheckState>().notNull(),
    message: text("message").notNull().default(""),
    ms: integer("ms").notNull().default(0),
    detail: jsonb("detail").$type<CheckResultDetail>().notNull(),
  },
  (t) => [index("check_results_check_idx").on(t.checkId, t.at)],
);

/**
 * Whether an action outside Sling happened: a chat tool call whose node has
 * `verify`, or a task's PR waiting for its CI. One row per call or step.
 */
export const actionChecks = pgTable(
  "action_checks",
  {
    id: text("id").primaryKey(),
    ...owned(),
    /** A chat tool call: its conversation, the reply it's on once saved, and the call's ID. */
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id"),
    /** A task's step, such as a PR whose CI it waits for. */
    actionId: text("action_id").references(() => actions.id, { onDelete: "cascade" }),
    /** What checks it: a node type whose `verify` runs, such as `email.send`, or a task step's kind. */
    kind: text("kind").notNull(),
    nodeVersion: integer("node_version"),
    installationId: text("installation_id").references(() => connectorInstallations.id, {
      onDelete: "set null",
    }),
    /** What each check gets: the node's config, inputs, and outputs, redacted. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    state: text("state").$type<ActionCheckState>().notNull().default("waiting"),
    message: text("message").notNull().default(""),
    attempts: integer("attempts").notNull().default(0),
    checkedAt: ts("checked_at"),
    /** While waiting: when it's checked again. */
    nextRunAt: ts("next_run_at"),
    /** A check still waiting then turns unchecked. */
    giveUpAt: ts("give_up_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("action_checks_call_idx")
      .on(t.conversationId, t.toolCallId)
      .where(sql`${t.toolCallId} is not null`),
    uniqueIndex("action_checks_action_idx").on(t.actionId).where(sql`${t.actionId} is not null`),
    index("action_checks_due_idx").on(t.nextRunAt).where(sql`${t.state} = 'waiting'`),
  ],
);

/** OAuth tokens of one installation, encrypted like credentials. */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: text("id").primaryKey(),
    ...owned(),
    installationId: text("installation_id")
      .notNull()
      .references(() => connectorInstallations.id, { onDelete: "cascade" }),
    /** Such as `google`. */
    provider: text("provider").notNull(),
    /** base64 of iv | auth tag | ciphertext, AES-256-GCM. */
    refreshToken: text("refresh_token").notNull(),
    accessToken: text("access_token"),
    keyVersion: integer("key_version").notNull(),
    /** When the access token expires. */
    expiresAt: ts("expires_at"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("oauth_tokens_installation_idx").on(t.installationId)],
);

/** An OAuth consent in progress, from Connect to the provider's callback. Used once. */
export const oauthFlows = pgTable(
  "oauth_flows",
  {
    /** SHA-256 of the `state` sent to the provider, hex. */
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationId: text("installation_id")
      .notNull()
      .references(() => connectorInstallations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** The PKCE verifier, encrypted. */
    codeVerifier: text("code_verifier").notNull(),
    keyVersion: integer("key_version").notNull(),
    /** SHA-256 of the session that started it, hex, so only that browser can finish it. */
    sessionHash: text("session_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_flows_expires_idx").on(t.expiresAt)],
);

/** Approvals answered from a notification, so each notification's token works once. */
/**
 * What a chat asked the user to approve while a turn waited: a command
 * outside the sandbox, a send, or a setup change, and how it ended. The
 * wait itself lives in the turn, so a restart can't resume it; this keeps
 * the outcome, so a late answer hears why it was too late. Never holds
 * what a card's fields were filled with.
 */
export const chatApprovals = pgTable(
  "chat_approvals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"command" | "send" | "change">().notNull(),
    state: text("state")
      .$type<"pending" | "approved" | "denied" | "expired">()
      .notNull()
      .default("pending"),
    /** Why an expired one ended: nobody answered, its turn stopped, or Sling restarted. */
    reason: text("reason").$type<"timeout" | "stopped" | "restart">(),
    expiresAt: ts("expires_at").notNull(),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("chat_approvals_pending_idx").on(t.state).where(sql`${t.state} = 'pending'`),
    index("chat_approvals_created_idx").on(t.createdAt),
  ],
);

export const notificationAnswers = pgTable("notification_answers", {
  /** A task step's approval or a chat send's, which lives in `chat_approvals`, so no foreign key. */
  approvalId: text("approval_id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  answer: text("answer").$type<"allow" | "deny">().notNull(),
  usedAt: ts("used_at").defaultNow().notNull(),
});

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength),
  fromDriver: (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
});

/**
 * Files and links a personality answers from, and files attached in a chat.
 * A chat file has neither scope until its message is sent.
 */
export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(),
    ...owned(),
    personalityId: text("personality_id").references(() => personalities.id, {
      onDelete: "cascade",
    }),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    kind: text("kind").$type<SourceKind>().notNull(),
    name: text("name").notNull(),
    mediaType: text("media_type").notNull(),
    size: integer("size").notNull().default(0),
    /** A link source's address. */
    url: text("url"),
    state: text("state").$type<SourceState>().notNull().default("processing"),
    error: text("error"),
    pages: integer("pages"),
    chars: integer("chars").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sources_personality_idx").on(t.personalityId),
    index("sources_conversation_idx").on(t.conversationId),
    index("sources_message_idx").on(t.messageId),
  ],
);

/** A source's original bytes, apart so lists never load them. */
export const sourceFiles = pgTable("source_files", {
  sourceId: text("source_id")
    .primaryKey()
    .references(() => sources.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
});

/** A source's text, by page and then by paragraph, for full-text search. */
export const sourceChunks = pgTable(
  "source_chunks",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    /** The PDF page it's on, from 1. Null for text without pages. */
    page: integer("page"),
    text: text("text").notNull(),
    /** English stems and the words as written, as memories have. */
    search: tsvector("search").generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('english', ${sourceChunks.text}) || to_tsvector('simple', ${sourceChunks.text})`,
    ),
  },
  (t) => [
    index("source_chunks_source_idx").on(t.sourceId, t.ordinal),
    index("source_chunks_search_idx").using("gin", t.search),
  ],
);

/** Thumbs on a reply, by the user who gave them, against the personality's revision then. */
export const messageFeedback = pgTable(
  "message_feedback",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    personalityId: text("personality_id").references(() => personalities.id, {
      onDelete: "cascade",
    }),
    revision: integer("revision").notNull().default(1),
    rating: text("rating").$type<FeedbackRating>().notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId] }),
    index("message_feedback_personality_idx").on(t.personalityId, t.createdAt),
  ],
);
