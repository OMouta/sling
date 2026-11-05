import type { Harness } from "./harness.ts";
import type { ChatSettings } from "./models.ts";
import type { ActionKind, PermissionMode } from "./modes.ts";
import type { ActionState, ApprovalState, Delivery, TaskState } from "./states.ts";

/**
 * Shapes the server sends to the web app, over REST and the /api/ws socket.
 * Dates are ISO strings.
 */

export interface CapabilityView {
  name: string;
  version: string;
  ready: boolean;
  detail: string;
  /** For coding agents: the models the agent reports. */
  models?: AgentModelView[];
}

export interface AgentModelView {
  id: string;
  displayName: string;
  description: string;
  efforts: string[];
  defaultEffort: string;
  fast: boolean;
  isDefault: boolean;
}

/** A git repo the Runner found on the machine and that isn't allowed yet. */
export interface FoundRepoView {
  path: string;
  name: string;
  defaultBranch: string;
  remoteUrl: string;
}

export interface RepoView {
  id: string;
  name: string;
  defaultBranch: string;
  remoteUrl: string;
  network: boolean;
  /** Normalized remote, `host/owner/name`, shared by the same repo on every machine. Null without a remote. */
  remoteKey: string | null;
}

export interface RunnerView {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  version: string | null;
  os: string | null;
  arch: string | null;
  hostname: string | null;
  capabilities: CapabilityView[];
  maxMode: PermissionMode;
  maxConcurrentTasks: number;
  pairedAt: string;
  revokedAt: string | null;
  repos: RepoView[];
  /** Labels from the machine's config, plus automatic `os:` and `arch:` labels. */
  labels: string[];
  /** A sandbox's Runner. Hidden from the Machines page. */
  ephemeral: boolean;
  sandboxId: string | null;
  /** Git repos the machine found that aren't allowed yet. */
  foundRepos: FoundRepoView[];
  /** Whether repos can be allowed and removed from Sling. Turned off on the machine. */
  remoteRepos: boolean;
}

export interface DiffStatsView {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export type SandboxState =
  | "requested"
  | "provisioning"
  | "ready"
  | "busy"
  | "releasing"
  | "destroyed"
  | "failed";

export interface TaskEnvironmentView {
  kind: "machine" | "sandbox";
  sandboxId: string | null;
  sandboxState: SandboxState | null;
  /** Name of the provider installation, for sandboxes. */
  providerName: string | null;
}

export interface RoutingView {
  /** Where the task went, or null when nothing was eligible. */
  target:
    | { kind: "machine"; runnerId: string; runnerName: string }
    | { kind: "sandbox"; providerInstallationId: string; providerName: string }
    | null;
  /** One sentence on why. */
  reason: string;
  /** Every machine the router looked at, and why it was or wasn't picked. */
  considered: { runnerId: string; runnerName: string; eligible: boolean; reason: string }[];
  decidedAt: string;
}

export interface TaskView {
  id: string;
  conversationId: string | null;
  /** Null until the task is bound to a machine or a sandbox's Runner. */
  runnerId: string | null;
  runnerName: string | null;
  harness: Harness;
  environment: TaskEnvironmentView;
  routing: RoutingView | null;
  repoName: string;
  title: string;
  objective: string;
  mode: PermissionMode;
  deliver: Delivery;
  state: TaskState;
  branch: string;
  commitSha: string | null;
  diffStats: DiffStatsView | null;
  summary: string | null;
  error: string | null;
  harnessVersion: string | null;
  /** The agent's model, effort, and fast tier, when the task named them. */
  model: string | null;
  effort: string | null;
  fast: boolean;
  runnerOffline: boolean;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  actions: ActionView[];
}

export type TaskEventType =
  | "accepted"
  | "rejected"
  | "started"
  | "agent_message"
  | "command"
  | "file_change"
  | "plan"
  | "log"
  | "usage"
  | "finished"
  | "action_result"
  | "truncated";

export interface TaskEventView {
  taskId: string;
  seq: number;
  at: string;
  type: TaskEventType;
  payload: Record<string, unknown>;
}

export interface ActionView {
  id: string;
  taskId: string;
  kind: ActionKind;
  state: ActionState;
  requiresApproval: boolean;
  url: string | null;
  message: string | null;
  approvalId: string | null;
}

export interface ApprovalView {
  id: string;
  /**
   * `task_action`: a push or PR step. `workflow`: a `human.approval` node.
   * `sandbox_fallback`: run a task in a sandbox because no machine could take it.
   */
  kind: "task_action" | "workflow" | "sandbox_fallback";
  title: string;
  state: ApprovalState;
  expiresAt: string;
  createdAt: string;
  /** Task-action approvals only. */
  taskId: string | null;
  actionId: string | null;
  actionKind: ActionKind | null;
  task: {
    title: string;
    repoName: string;
    runnerName: string;
    branch: string;
    remoteUrl: string;
    diffStats: DiffStatsView | null;
    summary: string | null;
    conversationId: string | null;
  } | null;
  prTitle: string | null;
  prBody: string | null;
  /** Workflow approvals only: the run waiting on it. */
  runId: string | null;
  /**
   * What the approver is shown. For `sandbox_fallback`, a SandboxFallbackPayload.
   */
  payload: Record<string, unknown> | null;
}

/** `ApprovalView.payload` of a `sandbox_fallback` approval. */
export interface SandboxFallbackPayload {
  taskId: string;
  taskTitle: string;
  remoteKey: string;
  cloneUrl: string;
  providerInstallationId: string;
  providerName: string;
  harness: Harness;
  /** Why no machine could take it, one line per machine. */
  reasons: string[];
}

export interface ConversationView {
  id: string;
  title: string;
  mode: PermissionMode;
  /** Model choices made in this conversation. Null parts use the workspace defaults. */
  settings: ChatSettings;
  createdAt: string;
  updatedAt: string;
}

/** A message as the chat UI shows it. Tool calls are summarized, not raw. */
export interface MessageView {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  text: string;
  taskIds: string[];
  createdAt: string;
  /** For an assistant reply: its thinking and tool calls, in order. */
  trace: ReplyTrace | null;
}

/** A tool call the assistant made while replying. */
export interface ToolStep {
  kind: "tool";
  id: string;
  name: string;
  /** The arguments, or a shortened JSON string when they're large. */
  input: unknown;
  status: "running" | "done" | "error";
  /** The result as text, shortened. */
  output: string | null;
}

/** One step of a reply: a stretch of thinking, or a tool call. */
export type TraceStep = { kind: "thinking"; text: string } | ToolStep;

/** How the assistant got to a reply, and how long it worked on it. */
export interface ReplyTrace {
  steps: TraceStep[];
  ms: number;
}

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type NodeRunStatus = "running" | "succeeded" | "failed" | "waiting" | "skipped";

export interface WorkflowSummaryView {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  templateKey: string | null;
  activeVersion: number | null;
  hasUnpublishedChanges: boolean;
  /** Trigger nodes of the active version, for the list page. */
  triggers: { nodeId: string; type: string; label: string }[];
  lastRun: { id: string; status: RunStatus; createdAt: string } | null;
  updatedAt: string;
}

export interface RunView {
  id: string;
  workflowId: string;
  workflowName: string;
  versionNumber: number;
  status: RunStatus;
  triggerNodeId: string;
  triggerType: string;
  concurrencyKey: string | null;
  output: unknown;
  error: { message: string; code: string; nodeId?: string } | null;
  parentRunId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface NodeRunView {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  iteration: number;
  attempt: number;
  status: NodeRunStatus;
  /** Exec output the node took. */
  execPort: string | null;
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  error: { message: string; code: string } | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

/** GET /api/runs/:id */
export interface RunDetailView {
  run: RunView;
  nodeRuns: NodeRunView[];
}

export interface ConnectorView {
  id: string;
  name: string;
  description: string;
  setupHelp: string | null;
  /** JSON Schema. */
  credentialsSchema: Record<string, unknown>;
  secretFields: string[];
  /** JSON Schema. */
  configSchema: Record<string, unknown>;
  nodeTypes: string[];
  /** Creates sandboxes (Docker, Railway). Listed with providers rather than with triggers and actions. */
  isExecutionProvider?: boolean;
}

export type InstallationStatus = "idle" | "connecting" | "connected" | "error" | "disabled";

export interface InstallationView {
  id: string;
  connectorId: string;
  name: string;
  enabled: boolean;
  /** `idle` when no enabled workflow uses it, so its event source isn't running. */
  status: InstallationStatus;
  statusDetail: string | null;
  config: Record<string, unknown>;
  hasCredentials: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxView {
  id: string;
  state: SandboxState;
  providerInstallationId: string;
  providerName: string;
  connectorId: string;
  taskId: string | null;
  taskTitle: string | null;
  image: string;
  /** The provider's own ID, for example a container ID. */
  externalId: string | null;
  failure: string | null;
  runnerId: string | null;
  requestedAt: string;
  readyAt: string | null;
  destroyedAt: string | null;
  /** Billable minutes so far, from ready to destroyed (or now). */
  minutes: number;
}

/** GET /api/sandboxes */
export interface SandboxListView {
  sandboxes: SandboxView[];
  usage: {
    monthMinutes: number;
    monthlyMinutesBudget: number;
    running: number;
    concurrentLimit: number;
    /** From the per-provider cost per hour, when set. */
    estimatedMonthCost: number | null;
  };
}

export interface SandboxRepoView {
  /** Normalized remote, `host/owner/name`. */
  remoteKey: string;
  /** HTTPS clone URL. */
  cloneUrl: string;
  defaultBranch: string;
  network: boolean;
  createdAt: string;
}

export interface SandboxSettingsView {
  defaultHarness: Harness;
  concurrentLimit: number;
  lifetimeMinutes: number;
  monthlyMinutesBudget: number;
  /** Provider installation ID to estimated cost per hour, in the user's currency. */
  costPerHour: Record<string, number>;
  /** Which write-only secrets are stored. Values are never returned. */
  secrets: { openaiApiKey: boolean; anthropicApiKey: boolean; gitToken: boolean };
}

export type AgentStatus = "idle" | "thinking" | "error";

export type ServerEvent =
  | { type: "runner.updated"; runner: RunnerView }
  | { type: "task.updated"; task: TaskView }
  | { type: "task.event"; event: TaskEventView }
  | { type: "approval.updated"; approval: ApprovalView }
  | { type: "conversation.updated"; conversation: ConversationView }
  | { type: "message.created"; message: MessageView }
  | { type: "agent.delta"; conversationId: string; text: string }
  | { type: "agent.thinking"; conversationId: string; text: string }
  | { type: "agent.tool"; conversationId: string; step: ToolStep }
  | { type: "agent.status"; conversationId: string; status: AgentStatus; error?: string }
  | { type: "workflow.updated"; workflow: WorkflowSummaryView }
  | { type: "run.updated"; run: RunView }
  | { type: "node_run.updated"; nodeRun: NodeRunView }
  | { type: "installation.updated"; installation: InstallationView }
  | { type: "sandbox.updated"; sandbox: SandboxView };
