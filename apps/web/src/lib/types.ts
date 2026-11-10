import type {
  AgentStatus,
  ApprovalView,
  ConversationView,
  LiveReplyView,
  MessageView,
  NotificationSettings,
  PermissionMode,
  PersonalityView,
  RunnerView,
  TaskEventView,
  TaskView,
} from "@sling/core";

export interface Status {
  needsSetup: boolean;
  signedIn: boolean;
  email: string | null;
  /** The name given at setup. */
  name?: string | null;
  version: string;
  /** Where Sling is set up to be opened. Sign-in only works there. */
  publicUrl: string;
}

export interface ConversationDetail {
  conversation: ConversationView;
  /** Who answers here. Still set when the personality was deleted later. */
  personality: PersonalityView | null;
  messages: MessageView[];
  tasks: TaskView[];
  agentStatus: AgentStatus;
  /** The reply being written, when the page opens mid-turn. */
  live?: LiveReplyView | null;
  /**
   * Tokens across every turn, cached input included. Each turn reads the
   * chat again, so this counts the chat once per turn. `lastTurn` is the
   * latest reply's alone.
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    lastTurn?: { inputTokens: number; outputTokens: number } | null;
  };
  /** The oldest loaded message's ID when there are older ones to load. */
  olderCursor?: string | null;
}

/** A page of a chat's messages from before the loaded ones. */
export interface OlderMessages {
  messages: MessageView[];
  tasks: TaskView[];
  olderCursor: string | null;
}

export interface TaskDetail {
  task: TaskView;
  events: TaskEventView[];
  /** The oldest loaded event's sequence number when there are earlier ones. */
  olderCursor?: number | null;
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
  /** The workspace's IANA time zone. Null until the web app sets it. */
  timeZone: string | null;
  /** Which pushes the signed-in user gets. Missing from a server older than this app. */
  notifications?: NotificationSettings;
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
