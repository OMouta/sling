import type { ActionCheckView, CheckView } from "./checks.ts";
import type { Harness } from "./harness.ts";
import type { MemoryView, ToolStepMemory } from "./memory.ts";
import type { ChatSettings } from "./models.ts";
import type { ActionKind, PermissionMode } from "./modes.ts";
import type { PersonalityView, ReplyPersonality } from "./personalities.ts";
import type { ConversationStartedBy, RuleOfferView, RuleView } from "./rules.ts";
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
  /** The deploy command set for this repo on the machine. Empty when none is set. */
  deployCommand: string;
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
  /** False when the machine refuses merges and deploys (`deploys off`). */
  deploys: boolean;
  /** Whether repos can be allowed and removed from Sling. Turned off on the machine. */
  remoteRepos: boolean;
  /** Folders shared with `sling-runner folder add`, by name. Only the machine can add one. */
  folders: string[];
  /** False when the machine refuses file searches and reads (`files off`), or its Runner can't do them. */
  files: boolean;
  /** Messaging channels the machine relays, set up with `sling-runner channel add`. */
  channels: ChannelView[];
}

export const CHANNEL_KINDS = ["imessage", "signal"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** A messaging channel on a machine. Only the machine adds one or allows its senders. */
export interface ChannelView {
  kind: ChannelKind;
  /** Unique on the machine. */
  name: string;
  /** Senders the machine forwards. Nothing is forwarded at 0. */
  allowedSenders: number;
  ready: boolean;
  /** What it needs when it isn't ready, such as Full Disk Access. Empty when ready. */
  missing: string;
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
  /** The repo's normalized remote, `host/owner/name`, which deploy targets are keyed by. Null without one. */
  remoteKey: string | null;
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
  /** Merge, deploy, and verify: the deploy target. */
  targetId: string | null;
  targetName: string | null;
  /** Merge and deploy: where it ran, a machine's name or "Sling" for the control plane. */
  ranOn: string | null;
  /** Merge: the merged commit. Deploy and verify: the commit deployed. */
  commitSha: string | null;
  /** A deploy command's output, redacted and shortened. */
  output: string | null;
  /** Verify only. */
  verify: VerifyDetail | null;
  /** A delivered PR: its CI, once Sling starts checking. Absent with nothing to check. */
  check?: ActionCheckView;
}

/** What one health check saw. */
export interface DeployCheckResult {
  url: string;
  ok: boolean;
  /** Null when there was no answer. */
  status: number | null;
  ms: number;
  /** Why it failed: the wrong status, missing text, a timeout, or a network error. */
  error: string | null;
}

export interface VerifyDetail {
  attempts: number;
  /** Results of the last attempt. */
  checks: DeployCheckResult[];
  /** Null when the target has no version URL. */
  versionSeen: boolean | null;
  startedAt: string;
  finishedAt: string | null;
}

export const DEPLOY_METHODS = ["merge", "command", "hook"] as const;
export type DeployMethod = (typeof DEPLOY_METHODS)[number];

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface DeployCheck {
  url: string;
  /** Exact status to expect. Null accepts 200 to 399. */
  status: number | null;
  /** Text the body must contain. */
  contains: string | null;
}

/** A repo Sling knows how to deploy and check. */
export interface DeployTargetView {
  id: string;
  name: string;
  /** Normalized remote, `host/owner/name`. */
  remoteKey: string;
  method: DeployMethod;
  mergeMethod: MergeMethod;
  /** `command` only: the machine that runs it. */
  runnerId: string | null;
  runnerName: string | null;
  /** `command` only: what that machine reports it will run. Empty when it has none set. */
  command: string | null;
  /** `hook` only. The URL itself is never sent back. */
  hook: { httpMethod: "POST" | "GET"; host: string; hasHeader: boolean } | null;
  checks: DeployCheck[];
  versionUrl: string | null;
  settleSeconds: number;
  timeoutSeconds: number;
  lastCheck: {
    at: string;
    up: boolean;
    /** Failed checks in a row. */
    failures: number;
    results: DeployCheckResult[];
  } | null;
  lastDeploy: {
    taskId: string;
    taskTitle: string;
    commitSha: string | null;
    at: string;
    state: ActionState;
  } | null;
  createdAt: string;
  updatedAt: string;
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
  /** Push and PR steps: the rule Always allow would make. Absent when none can cover it. */
  ruleOffer?: RuleOfferView;
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
  /** The personality that answers here, fixed when the chat started. */
  personalityId: string | null;
  /** The start rule that opened it. Null for chats a person or a workflow started. */
  startedBy: ConversationStartedBy | null;
  createdAt: string;
  updatedAt: string;
}

/** A conversation in a list: what it is, where it's at, and its latest message. */
export interface ConversationSummaryView extends ConversationView {
  /** The latest message, shortened to one line. */
  preview: string | null;
  previewRole: "user" | "assistant" | "system" | null;
  lastMessageAt: string | null;
  /** Tasks it started, and how many are still queued or running. */
  taskCount: number;
  activeTasks: number;
  /** Something in it waits for the user: a task's approval, or a command. */
  waiting: boolean;
  agentStatus: AgentStatus;
  /** Where it comes from: the web app, or a channel such as Discord. */
  source: string;
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

/** One line of a change to Sling's setup: a value as it would be, and as it was when editing. */
export interface SetupChangeRow {
  label: string;
  /** What it is now. Absent for something new. */
  before?: string;
  after: string;
}

/** A password, token, or secret URL the user types on the approval card, never in the chat. */
export interface SetupSecretField {
  key: string;
  label: string;
  placeholder?: string;
  /** Where to get one, such as a provider's app password page. */
  link?: { label: string; url: string };
  /** Required ones must be filled in before Apply. Optional ones keep what's stored when blank. */
  required: boolean;
}

/** A change to Sling's own setup that the assistant proposes, as the user sees it. */
export interface SetupChangeView {
  /** The question, for example "Add deploy target Website?". */
  title: string;
  /** While it applies, for example "Adding Website". */
  doing: string;
  /** Once applied, for example "Added Website". */
  done: string;
  rows: SetupChangeRow[];
  /** Inputs the card shows. Their values go from the card to the server, never to the model. */
  secrets: SetupSecretField[];
  /** A workflow written in the chat: its steps in order, in plain words. */
  workflow?: {
    steps: WorkflowStepView[];
    /** Set once applied, for Open in editor. */
    workflowId: string | null;
  };
}

/** One step of a workflow, as a card lists it: "Every Monday at 09:00", "Send to Discord #general". */
export interface WorkflowStepView {
  nodeId: string;
  text: string;
  /** It reaches outside Sling, such as sending a message. */
  sends: boolean;
}

/** A command, a send, or a setup change waiting on the user in a chat, or what they decided. */
export interface CommandApprovalView {
  id: string;
  /**
   * `command`: a command that wants to leave the sandbox. `send`: something
   * that leaves Sling. `change`: a change to Sling's own setup.
   */
  kind: "command" | "send" | "change";
  state: "pending" | "approved" | "denied" | "expired";
  /** Commands: the machine it would run on. Otherwise empty. */
  machine: string;
  /** Sends: what would go out, for example "Email ana@example.com: Lunch moved". Changes: the title. */
  summary: string;
  /** Changes: what would change, and the secrets to type in. */
  change?: SetupChangeView;
  /** Sends: the rule Always allow would make. Absent when none can cover it. */
  ruleOffer?: RuleOfferView;
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
  /** For a command, a send, or a setup change that needs the user's approval. */
  approval?: CommandApprovalView;
  /** For an action outside Sling whose node checks it happened. Absent when nothing checks it. */
  check?: ActionCheckView;
  /** For `remember`: what it saved. */
  memory?: ToolStepMemory;
}

/**
 * One step of a reply: a stretch of thinking, a tool call, or text the
 * assistant wrote before doing more work.
 */
export type TraceStep =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | ToolStep;

/** How the assistant got to a reply, and how long it worked on it. */
export interface ReplyTrace {
  steps: TraceStep[];
  ms: number;
  /** The personality that wrote the reply, and its revision then. */
  personality?: ReplyPersonality;
}

/** A reply still being written: its work so far, and the answer's text so far. */
export interface LiveReplyView {
  text: string;
  steps: TraceStep[];
  /** Milliseconds since the epoch. */
  startedAt: number;
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
  /** Listens for events, such as new mail. Connectors without one have no listening status. */
  hasSource?: boolean;
  /** Can fill in settings from what's typed so far, through `POST /api/connectors/:id/setup`. */
  hasSetup?: boolean;
  /** The extension that adds this connector. Null for connectors built into Sling. */
  extension?: ExtensionRef | null;
}

export interface SetupOptionView {
  value: string;
  label: string;
  detail?: string;
}

export interface SetupNoteView {
  /** The field it sits under. Without one it shows above the form. */
  field?: string;
  tone: "info" | "ok" | "warn" | "error";
  text: string;
  link?: { label: string; url: string };
}

/** What a connector's setup lookup filled in from what's typed so far. */
export interface SetupResultView {
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  options?: Record<string, SetupOptionView[]>;
  name?: string;
  notes?: SetupNoteView[];
  reveal?: string[];
  retryAfterMs?: number;
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

// ------------------------------------------------------------- extensions

/** The extension a connector, node, or template came from. */
export interface ExtensionRef {
  id: string;
  name: string;
  version: string;
  hasIcon: boolean;
}

export type ExtensionSource = "included" | "catalog" | "upload";
export type ExtensionKind = "connector" | "provider" | "workflows";
/**
 * `stopped`: installed and enabled, no process running (they start on demand).
 * `unsupported`: this server's Node can't isolate extension code.
 */
export type ExtensionStatus =
  | "stopped"
  | "starting"
  | "running"
  | "error"
  | "disabled"
  | "unsupported";

export interface PermissionLine {
  /** Stable key, for diffs. */
  key: string;
  text: string;
  /** `high` for permissions that reach past the extension's own installations. */
  risk: "normal" | "high";
}

/** Who signed a package. Null for unsigned packages and the ones that ship with Sling. */
export interface PublisherRef {
  keyId: string;
  name: string;
  /** `3f2a 91c0 7d4e 22b1`. */
  fingerprint: string;
  trusted: boolean;
}

export interface ExtensionContents {
  connectors: { id: string; name: string; isExecutionProvider: boolean }[];
  nodes: {
    type: string;
    version: number;
    title: string;
    isTrigger: boolean;
    /** Present when the assistant may call the node from chat. */
    assistant?: { sends: boolean };
  }[];
  templates: { key: string; name: string }[];
}

export interface ExtensionView {
  id: string;
  name: string;
  description: string;
  version: string;
  source: ExtensionSource;
  /** Catalog it was installed from: an ID, `included`, or null for uploads. */
  catalogId: string | null;
  publisher: PublisherRef | null;
  signed: boolean;
  enabled: boolean;
  status: ExtensionStatus;
  statusDetail: string | null;
  kinds: ExtensionKind[];
  contents: ExtensionContents;
  permissions: PermissionLine[];
  /** A newer, compatible, unrevoked version in an enabled catalog. */
  update: { version: string; catalogId: string } | null;
  /** Set when a catalog revoked the installed version. */
  revoked: { reason: string } | null;
  usedBy: { installations: number; workflows: number };
  hasIcon: boolean;
  homepage: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface ExtensionDetailView extends ExtensionView {
  readme: string | null;
  manifest: Record<string, unknown>;
  digest: string;
  /** Versions the catalog lists, newest first. Empty for uploads. */
  versions: { version: string; publishedAt: string | null; revoked: { reason: string } | null }[];
  /** The last lines its process logged. */
  log: { at: string; level: "info" | "warn" | "error"; message: string }[];
  installations: { id: string; name: string; connectorId: string }[];
  workflows: { id: string; name: string; enabled: boolean }[];
}

export interface DiscoverEntryView {
  catalogId: string;
  catalogName: string;
  id: string;
  name: string;
  description: string;
  publisher: PublisherRef | null;
  kinds: ExtensionKind[];
  homepage: string | null;
  /** The newest version this server can install. Null when none is compatible. */
  latest: {
    version: string;
    size: number;
    permissions: PermissionLine[];
    publishedAt: string | null;
  } | null;
  /** Why no version can be installed, when `latest` is null. */
  unavailable: string | null;
  installed: { version: string; updateAvailable: boolean } | null;
}

/** What an install or update would do. Confirm with the same staging ID. */
export interface ExtensionPreview {
  stagingId: string;
  expiresAt: string;
  id: string;
  name: string;
  description: string;
  version: string;
  digest: string;
  size: number;
  source: ExtensionSource;
  catalogId: string | null;
  publisher: PublisherRef | null;
  signed: boolean;
  kinds: ExtensionKind[];
  contents: ExtensionContents;
  permissions: PermissionLine[];
  /** Raw permissions, echoed back on confirm so the server can check nothing changed. */
  permissionsKey: string;
  /** Set when this is an update. */
  diff: { fromVersion: string; added: PermissionLine[]; removed: PermissionLine[] } | null;
  missing: {
    extensions: { id: string; range: string; catalogId: string | null }[];
    connectors: string[];
  };
  /** Problems that stop the install. Empty when it can go ahead. */
  problems: string[];
  readme: string | null;
}

export interface PublisherView {
  keyId: string;
  name: string;
  fingerprint: string;
  trustedAt: string;
  /** IDs of installed extensions pinned to this key. */
  extensions: string[];
}

export interface CatalogView {
  /** `included` for the catalog that ships with Sling. */
  id: string;
  url: string | null;
  name: string;
  enabled: boolean;
  included: boolean;
  fetchedAt: string | null;
  error: string | null;
  extensionCount: number;
}

/** What a catalog URL holds, fetched before it's added. */
export interface CatalogPreviewView {
  /** The URL as Sling will store it. */
  url: string;
  name: string;
  extensionCount: number;
  /** Its first few extensions, in the catalog's order. */
  extensions: { id: string; name: string; description: string }[];
  /** Who signs its packages, by name. */
  publishers: string[];
}

/** A device that gets push notifications. */
export interface PushSubscriptionView {
  id: string;
  /** From the browser that subscribed, for example "Safari on iPhone". */
  label: string;
  /** The push service's host, such as web.push.apple.com. */
  service: string;
  createdAt: string;
  lastDeliveredAt: string | null;
  lastError: string | null;
}

/** Which pushes a user gets. `app.notify` from a workflow always delivers. */
export interface NotificationSettings {
  approvals: boolean;
  tasks: boolean;
  replies: boolean;
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  approvals: true,
  tasks: true,
  replies: true,
};

/** What a push carries, encrypted for the device. */
export interface PushPayload {
  title: string;
  body: string;
  /** A path in the app to open on tap. */
  url: string;
  /** Pushes with the same tag replace each other on the device. */
  tag: string;
  /**
   * For an approval that can be answered from the notification: Allow and
   * Deny post the token to POST /api/approvals/:id/notification-answer.
   */
  answer?: { approvalId: string; token: string };
}

/** POST /api/approvals/:id/notification-answer, from the service worker. */
export interface NotificationAnswerInput {
  token: string;
  answer: "allow" | "deny";
}

/** What the service worker replaces the notification with. */
export interface NotificationAnswerResult {
  outcome: "allowed" | "denied" | "already_answered" | "expired";
}

/** What the web app's socket tells the server. */
export type ClientEvent = {
  type: "presence";
  /** The conversation a visible window shows, or null. */
  conversationId: string | null;
  visible: boolean;
};

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
  | { type: "sandbox.updated"; sandbox: SandboxView }
  | { type: "extension.updated"; extension: ExtensionView }
  | { type: "extension.removed"; id: string }
  | { type: "personality.updated"; personality: PersonalityView }
  | { type: "personality.removed"; id: string }
  | { type: "deploy_target.updated"; target: DeployTargetView }
  | { type: "deploy_target.removed"; id: string }
  | { type: "memory.updated"; memory: MemoryView }
  | { type: "memory.removed"; id: string }
  | { type: "rule.updated"; rule: RuleView }
  /** Anything about a check changed: its state, its last result, or its settings. */
  | { type: "check.changed"; check: CheckView }
  | { type: "check.removed"; id: string }
  /** An action's check changed after its reply was saved, such as an email bouncing. */
  | {
      type: "tool_step.check";
      conversationId: string;
      /** The reply the step is on. */
      messageId: string;
      /** The step's ID: its tool call. */
      stepId: string;
      check: ActionCheckView;
    }
  /** Workspace or notification settings changed: open settings pages load them again. */
  | { type: "settings.updated" };
