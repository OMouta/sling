import type {
  AgentStatus,
  ApprovalView,
  ConversationView,
  MessageView,
  PermissionMode,
  RunnerView,
  TaskEventView,
  TaskView,
} from "@sling/core";

export interface Status {
  needsSetup: boolean;
  signedIn: boolean;
  email: string | null;
  version: string;
}

export interface ConversationDetail {
  conversation: ConversationView;
  messages: MessageView[];
  tasks: TaskView[];
  agentStatus: AgentStatus;
  usage: { inputTokens: number; outputTokens: number };
}

export interface TaskDetail {
  task: TaskView;
  events: TaskEventView[];
}

export interface ProviderInfo {
  id: "openai" | "anthropic" | "openai-compatible";
  label: string;
  needsBaseUrl: boolean;
  defaultModel: string;
  hasKey: boolean;
  baseUrl: string | null;
  connected: boolean;
}

export interface Settings {
  defaultMode: PermissionMode;
  modes: PermissionMode[];
  providers: ProviderInfo[];
  model: {
    provider: ProviderInfo["id"];
    model: string;
    baseUrl: string | null;
    hasKey: boolean;
  } | null;
}

export interface Enrollment {
  code: string;
  expiresAt: string;
  /** For a machine that already has sling-runner. */
  command: string;
  /** Installs, pairs, and starts the Runner on macOS and Linux. */
  installCommand: string;
  windowsInstallCommand: string;
}

export type { ApprovalView, ConversationView, MessageView, RunnerView, TaskEventView, TaskView };
