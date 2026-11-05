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
  taskId: string;
  actionId: string;
  actionKind: ActionKind;
  state: ApprovalState;
  expiresAt: string;
  createdAt: string;
  task: {
    title: string;
    repoName: string;
    runnerName: string;
    branch: string;
    remoteUrl: string;
    diffStats: DiffStatsView | null;
    summary: string | null;
    conversationId: string | null;
  };
  prTitle: string | null;
  prBody: string | null;
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

export type AgentStatus = "idle" | "thinking" | "error";

export type ServerEvent =
  | { type: "runner.updated"; runner: RunnerView }
  | { type: "task.updated"; task: TaskView }
  | { type: "task.event"; event: TaskEventView }
  | { type: "approval.updated"; approval: ApprovalView }
  | { type: "conversation.updated"; conversation: ConversationView }
  | { type: "message.created"; message: MessageView }
  | { type: "agent.delta"; conversationId: string; text: string }
  | { type: "agent.status"; conversationId: string; status: AgentStatus; error?: string };
