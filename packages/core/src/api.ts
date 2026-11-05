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
}

export interface RepoView {
  id: string;
  name: string;
  defaultBranch: string;
  remoteUrl: string;
  network: boolean;
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
}

export interface DiffStatsView {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface TaskView {
  id: string;
  conversationId: string | null;
  runnerId: string;
  runnerName: string;
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
  /** `task_action`: a push or PR step. `workflow`: a `human.approval` node. */
  kind: "task_action" | "workflow";
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
  /** Workflow approvals only: the run waiting on it, and what the node showed. */
  runId: string | null;
  payload: Record<string, unknown> | null;
}

export interface ConversationView {
  id: string;
  title: string;
  mode: PermissionMode;
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

export type AgentStatus = "idle" | "thinking" | "error";

export type ServerEvent =
  | { type: "runner.updated"; runner: RunnerView }
  | { type: "task.updated"; task: TaskView }
  | { type: "task.event"; event: TaskEventView }
  | { type: "approval.updated"; approval: ApprovalView }
  | { type: "conversation.updated"; conversation: ConversationView }
  | { type: "message.created"; message: MessageView }
  | { type: "agent.delta"; conversationId: string; text: string }
  | { type: "agent.status"; conversationId: string; status: AgentStatus; error?: string }
  | { type: "workflow.updated"; workflow: WorkflowSummaryView }
  | { type: "run.updated"; run: RunView }
  | { type: "node_run.updated"; nodeRun: NodeRunView }
  | { type: "installation.updated"; installation: InstallationView };
