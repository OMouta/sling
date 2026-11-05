/**
 * Realistic API payloads shaped like the contract types, shared by unit and
 * DOM tests. Config schemas are what zod's `toJSONSchema` writes.
 */
import type {
  ApprovalView,
  ConnectorView,
  InstallationView,
  NodeRunView,
  RunDetailView,
  RunnerView,
  RunView,
  SandboxListView,
  SandboxRepoView,
  SandboxSettingsView,
  SandboxView,
  TaskView,
  WorkflowSummaryView,
} from "@sling/core";
import {
  NAMED_TYPES,
  type NodeCatalog,
  type NodeSpecView,
  type TemplateView,
  type WorkflowDefinition,
  type WorkflowDetailView,
  type WorkflowVersionView,
} from "@sling/workflow";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

function spec(partial: Partial<NodeSpecView> & Pick<NodeSpecView, "type" | "title" | "category">) {
  const s: NodeSpecView = {
    version: 1,
    description: "",
    connector: null,
    inputs: [],
    outputs: [],
    execInput: true,
    execOutputs: [{ name: "next" }],
    dynamicExecOutputs: null,
    configSchema: { $schema: SCHEMA, type: "object", properties: {}, additionalProperties: false },
    expressionFields: [],
    installationFields: [],
    idempotent: true,
    isTrigger: false,
    ...partial,
  };
  return s;
}

export const catalog: NodeCatalog = {
  types: Object.values(NAMED_TYPES),
  nodes: [
    spec({
      type: "core.manual",
      title: "Manual run",
      category: "trigger",
      description: "Starts when you press Run.",
      outputs: [{ name: "input", type: "json" }],
      execInput: false,
      isTrigger: true,
    }),
    spec({
      type: "core.webhook",
      title: "Webhook",
      category: "trigger",
      description: "Starts on POST /hooks/:token.",
      outputs: [{ name: "body", type: "json" }],
      execInput: false,
      isTrigger: true,
    }),
    spec({
      type: "email.received",
      title: "Email received",
      category: "trigger",
      connector: "email",
      description: "New mail in an IMAP folder.",
      outputs: [{ name: "email", type: "email" }],
      execInput: false,
      isTrigger: true,
      installationFields: ["installationId"],
      configSchema: {
        $schema: SCHEMA,
        type: "object",
        properties: {
          installationId: { type: "string", description: "Email installation" },
          folder: { default: "INBOX", type: "string", description: "IMAP folder" },
          from: { type: "array", items: { type: "string" }, description: "Only these senders" },
        },
        required: ["installationId", "folder"],
        additionalProperties: false,
      },
    }),
    spec({
      type: "core.if",
      title: "If",
      category: "logic",
      description: "Branches on a condition.",
      inputs: [{ name: "value", type: "any" }],
      execOutputs: [{ name: "true" }, { name: "false" }],
      expressionFields: ["condition"],
      configSchema: {
        $schema: SCHEMA,
        type: "object",
        properties: {
          condition: { type: "string", description: "JSONata, truthy" },
        },
        required: ["condition"],
        additionalProperties: false,
      },
    }),
    spec({
      type: "core.switch",
      title: "Switch",
      category: "logic",
      inputs: [{ name: "value", type: "any" }],
      execOutputs: [],
      dynamicExecOutputs: { fromConfig: "cases", field: "name", extra: [{ name: "default" }] },
      configSchema: {
        $schema: SCHEMA,
        type: "object",
        properties: {
          cases: {
            default: [],
            description: "Branches, tried in order",
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, when: { type: "string" } },
              required: ["name", "when"],
              additionalProperties: false,
            },
          },
        },
        required: ["cases"],
        additionalProperties: false,
      },
    }),
    spec({
      type: "core.for_each",
      title: "For each",
      category: "logic",
      inputs: [{ name: "items", type: "list<any>", required: true }],
      outputs: [
        { name: "item", type: "any" },
        { name: "index", type: "number" },
      ],
      execOutputs: [{ name: "each" }, { name: "done" }],
    }),
    spec({
      type: "core.transform",
      title: "Transform",
      category: "data",
      inputs: [{ name: "value", type: "any" }],
      outputs: [{ name: "result", type: "json" }],
      expressionFields: ["expression"],
      configSchema: {
        $schema: SCHEMA,
        type: "object",
        properties: { expression: { type: "string", description: "JSONata" } },
        additionalProperties: false,
      },
    }),
    spec({
      type: "core.set_var",
      title: "Set variable",
      category: "state",
      configSchema: {
        $schema: SCHEMA,
        type: "object",
        properties: { name: { type: "string" }, value: { type: "string" } },
        required: ["name", "value"],
        additionalProperties: false,
      },
      expressionFields: ["value"],
    }),
    spec({
      type: "ai.prompt",
      title: "Prompt",
      category: "ai",
      description: "Asks the model and returns its text.",
      inputs: [{ name: "context", type: "json" }],
      outputs: [{ name: "text", type: "string" }],
      idempotent: false,
      expressionFields: ["prompt"],
      configSchema: {
        $schema: SCHEMA,
        type: "object",
        properties: {
          prompt: { type: "string", description: "What to ask", widget: "textarea" },
          model: { type: ["string", "null"], description: "Model override" },
          temperature: { default: 0.2, type: "number", minimum: 0, maximum: 2 },
        },
        required: ["prompt", "temperature"],
        additionalProperties: false,
      },
    }),
    spec({
      type: "http.request",
      title: "HTTP request",
      category: "action",
      inputs: [{ name: "body", type: "json" }],
      outputs: [{ name: "response", type: "http.response" }],
      expressionFields: ["url"],
      configSchema: {
        $schema: SCHEMA,
        type: "object",
        properties: {
          method: { default: "GET", type: "string", enum: ["GET", "POST", "HEAD"] },
          url: { type: "string", description: "Full URL" },
          timeoutMs: { default: 10000, type: "integer", minimum: 1, maximum: 60000 },
          headers: {
            type: "object",
            propertyNames: { type: "string" },
            additionalProperties: { type: "string" },
          },
        },
        required: ["method", "url", "timeoutMs"],
        additionalProperties: false,
      },
    }),
    spec({
      type: "discord.send_message",
      title: "Send Discord message",
      category: "action",
      connector: "discord",
      description: "Posts to a channel or DMs a user.",
      inputs: [{ name: "content", type: "string" }],
      outputs: [{ name: "messageId", type: "string" }],
      idempotent: false,
      installationFields: ["installationId"],
      expressionFields: ["content"],
      configSchema: {
        $schema: SCHEMA,
        type: "object",
        properties: {
          installationId: { type: "string" },
          userId: { type: "string", description: "DM this Discord user" },
          content: { type: "string", widget: "textarea" },
          approvalButtons: { default: false, type: "boolean" },
        },
        required: ["installationId", "approvalButtons"],
        additionalProperties: false,
      },
    }),
  ],
};

export const definition: WorkflowDefinition = {
  schema: "sling.workflow/v1",
  name: "Important email to Discord",
  description: "DMs me a summary of mail from people I care about.",
  nodes: [
    {
      id: "n_trigger",
      type: "email.received",
      version: 1,
      label: "New email",
      position: { x: 0, y: 0 },
      config: { installationId: "ins_email", folder: "INBOX" },
    },
    {
      id: "n_if",
      type: "core.if",
      version: 1,
      label: "From a VIP?",
      position: { x: 300, y: 0 },
      config: { condition: '={{ inputs.value.from.address in ["boss@example.com"] }}' },
    },
    {
      id: "n_ai",
      type: "ai.prompt",
      version: 1,
      label: "Summarize",
      position: { x: 600, y: -80 },
      config: { prompt: "Summarize this email.", model: null, temperature: 0.2 },
    },
    {
      id: "n_send",
      type: "discord.send_message",
      version: 1,
      label: "DM me",
      position: { x: 900, y: -80 },
      config: { installationId: "ins_discord", userId: "1234", approvalButtons: false },
    },
  ],
  edges: [
    {
      id: "e1",
      kind: "exec",
      from: { node: "n_trigger", port: "next" },
      to: { node: "n_if", port: "in" },
    },
    {
      id: "e2",
      kind: "data",
      from: { node: "n_trigger", port: "email" },
      to: { node: "n_if", port: "value" },
    },
    {
      id: "e3",
      kind: "exec",
      from: { node: "n_if", port: "true" },
      to: { node: "n_ai", port: "in" },
    },
    {
      id: "e4",
      kind: "data",
      from: { node: "n_trigger", port: "email" },
      to: { node: "n_ai", port: "context" },
    },
    {
      id: "e5",
      kind: "exec",
      from: { node: "n_ai", port: "next" },
      to: { node: "n_send", port: "in" },
    },
    {
      id: "e6",
      kind: "data",
      from: { node: "n_ai", port: "text" },
      to: { node: "n_send", port: "content" },
    },
  ],
};

const t0 = "2026-11-05T09:00:00.000Z";

export const workflowSummary: WorkflowSummaryView = {
  id: "wf_1",
  name: definition.name,
  description: definition.description,
  enabled: true,
  templateKey: "important-email-to-discord",
  activeVersion: 1,
  hasUnpublishedChanges: true,
  triggers: [{ nodeId: "n_trigger", type: "email.received", label: "New email" }],
  lastRun: { id: "run_1", status: "failed", createdAt: "2026-11-05T10:00:00.000Z" },
  updatedAt: "2026-11-05T10:05:00.000Z",
};

export const assistantSummary: WorkflowSummaryView = {
  id: "wf_2",
  name: "Sling Assistant",
  description: "Web chat",
  enabled: false,
  templateKey: "sling-assistant",
  activeVersion: null,
  hasUnpublishedChanges: false,
  triggers: [],
  lastRun: null,
  updatedAt: t0,
};

export const workflowDetail: WorkflowDetailView = {
  id: "wf_1",
  name: definition.name,
  description: definition.description,
  enabled: true,
  templateKey: "important-email-to-discord",
  activeVersion: 1,
  hasUnpublishedChanges: true,
  draft: definition,
  active: definition,
  webhooks: [],
  createdAt: t0,
  updatedAt: "2026-11-05T10:05:00.000Z",
};

export const version1: WorkflowVersionView = {
  number: 1,
  note: "First version",
  createdAt: t0,
  definition,
};

export const run: RunView = {
  id: "run_1",
  workflowId: "wf_1",
  workflowName: definition.name,
  versionNumber: 1,
  status: "failed",
  triggerNodeId: "n_trigger",
  triggerType: "email.received",
  concurrencyKey: null,
  output: null,
  error: { message: "Discord said 403", code: "forbidden", nodeId: "n_send" },
  parentRunId: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  startedAt: "2026-11-05T10:00:00.100Z",
  finishedAt: "2026-11-05T10:00:04.600Z",
};

function nodeRun(partial: Partial<NodeRunView> & Pick<NodeRunView, "id" | "nodeId" | "nodeType">) {
  const nr: NodeRunView = {
    runId: "run_1",
    iteration: 0,
    attempt: 1,
    status: "succeeded",
    execPort: "next",
    inputs: {},
    outputs: {},
    error: null,
    startedAt: "2026-11-05T10:00:00.100Z",
    finishedAt: "2026-11-05T10:00:00.200Z",
    durationMs: 100,
    ...partial,
  };
  return nr;
}

export const runDetail: RunDetailView = {
  run,
  nodeRuns: [
    nodeRun({
      id: "nr_1",
      nodeId: "n_trigger",
      nodeType: "email.received",
      outputs: { email: { subject: "Quarterly numbers", from: { address: "boss@example.com" } } },
    }),
    nodeRun({
      id: "nr_2",
      nodeId: "n_if",
      nodeType: "core.if",
      execPort: "true",
      startedAt: "2026-11-05T10:00:00.300Z",
      inputs: { value: { subject: "Quarterly numbers" } },
    }),
    nodeRun({
      id: "nr_3",
      nodeId: "n_ai",
      nodeType: "ai.prompt",
      startedAt: "2026-11-05T10:00:00.400Z",
      outputs: { text: "Numbers are up. Reply by Friday." },
      durationMs: 3200,
    }),
    nodeRun({
      id: "nr_4",
      nodeId: "n_send",
      nodeType: "discord.send_message",
      status: "failed",
      execPort: null,
      startedAt: "2026-11-05T10:00:04.500Z",
      outputs: null,
      error: { message: "Discord said 403", code: "forbidden" },
      durationMs: 90,
    }),
  ],
};

export const connectors: ConnectorView[] = [
  {
    id: "discord",
    name: "Discord",
    description: "A bot that reads and sends messages.",
    setupHelp:
      "Create a bot in the Discord developer portal and turn on the Message Content intent.",
    credentialsSchema: {
      $schema: SCHEMA,
      type: "object",
      properties: { botToken: { type: "string", description: "Bot token" } },
      required: ["botToken"],
      additionalProperties: false,
    },
    secretFields: ["botToken"],
    configSchema: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        allowedUserIds: {
          default: [],
          type: "array",
          items: { type: "string" },
          description: "Discord users the bot listens to",
        },
        approverUserIds: { default: [], type: "array", items: { type: "string" } },
      },
      required: ["allowedUserIds", "approverUserIds"],
      additionalProperties: false,
    },
    nodeTypes: ["discord.message_received", "discord.send_message"],
  },
  {
    id: "email",
    name: "Email",
    description: "IMAP for incoming mail, SMTP for sending.",
    setupHelp: null,
    credentialsSchema: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        username: { type: "string" },
        password: { type: "string" },
      },
      required: ["username", "password"],
      additionalProperties: false,
    },
    secretFields: ["password"],
    configSchema: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        imapHost: { type: "string" },
        imapPort: { default: 993, type: "integer" },
      },
      required: ["imapHost", "imapPort"],
      additionalProperties: false,
    },
    nodeTypes: ["email.received", "email.send"],
  },
];

export const installations: InstallationView[] = [
  {
    id: "ins_email",
    connectorId: "email",
    name: "Work mail",
    enabled: true,
    status: "connected",
    statusDetail: "IDLE on INBOX",
    config: { imapHost: "imap.example.com", imapPort: 993 },
    hasCredentials: true,
    createdAt: t0,
    updatedAt: t0,
  },
  {
    id: "ins_discord",
    connectorId: "discord",
    name: "Sling bot",
    enabled: true,
    status: "error",
    statusDetail: "Message Content intent is off",
    config: { allowedUserIds: ["1234"], approverUserIds: ["1234"] },
    hasCredentials: true,
    createdAt: t0,
    updatedAt: t0,
  },
];

export const templates: TemplateView[] = [
  {
    key: "important-email-to-discord",
    name: "Important email to Discord",
    description: "Summarizes mail from allowlisted senders and DMs you.",
    bindings: [
      { placeholder: "$email", connectorId: "email", label: "Mailbox" },
      { placeholder: "$discord", connectorId: "discord", label: "Discord bot" },
    ],
    builtIn: false,
  },
];

/** A large graph, for checking the editor stays usable at size. */
export function bigDefinition(count: number): WorkflowDefinition {
  const nodes: WorkflowDefinition["nodes"] = [
    { id: "t", type: "core.manual", version: 1, position: { x: 0, y: 0 }, config: {} },
  ];
  const edges: WorkflowDefinition["edges"] = [];
  let prev = "t";
  for (let i = 0; i < count - 1; i++) {
    const id = `n${i}`;
    nodes.push({
      id,
      type: "core.transform",
      version: 1,
      position: { x: (i % 20) * 260, y: Math.floor(i / 20) * 160 },
      config: {},
    });
    edges.push({
      id: `e${i}`,
      kind: "exec",
      from: { node: prev, port: "next" },
      to: { node: id, port: "in" },
    });
    prev = id;
  }
  return { schema: "sling.workflow/v1", name: "Big", description: "", nodes, edges };
}

// Machines, sandboxes, and where tasks run.

export const devbox: RunnerView = {
  id: "rnr_1",
  name: "devbox",
  online: true,
  lastSeenAt: "2026-11-05T10:00:00.000Z",
  version: "0.3.0",
  os: "macos",
  arch: "aarch64",
  hostname: "devbox.local",
  capabilities: [
    { name: "coding.codex", version: "0.166.0", ready: true, detail: "" },
    {
      name: "coding.claude-code",
      version: "2.1.4",
      ready: false,
      detail: "Not logged in. Run claude and sign in.",
    },
    { name: "git", version: "2.47.1", ready: true, detail: "" },
  ],
  maxMode: "auto",
  maxConcurrentTasks: 2,
  pairedAt: "2026-10-01T09:00:00.000Z",
  revokedAt: null,
  repos: [
    {
      id: "rpo_1",
      name: "site",
      defaultBranch: "main",
      remoteUrl: "git@github.com:a/site.git",
      network: false,
      remoteKey: "github.com/a/site",
    },
    {
      id: "rpo_2",
      name: "notes",
      defaultBranch: "main",
      remoteUrl: "",
      network: false,
      remoteKey: null,
    },
  ],
  labels: ["ios", "os:macos", "arch:aarch64"],
  ephemeral: false,
  sandboxId: null,
};

export const buildbox: RunnerView = {
  id: "rnr_2",
  name: "buildbox",
  online: false,
  lastSeenAt: "2026-11-05T08:00:00.000Z",
  version: "0.3.0",
  os: "linux",
  arch: "x86_64",
  hostname: "buildbox",
  capabilities: [{ name: "coding.claude-code", version: "2.1.4", ready: true, detail: "" }],
  maxMode: "full-access",
  maxConcurrentTasks: 4,
  pairedAt: "2026-10-02T09:00:00.000Z",
  revokedAt: null,
  repos: [
    {
      id: "rpo_3",
      name: "api",
      defaultBranch: "trunk",
      remoteUrl: "https://github.com/a/api.git",
      network: true,
      remoteKey: "github.com/a/api",
    },
  ],
  labels: ["gpu", "os:linux", "arch:x86_64"],
  ephemeral: false,
  sandboxId: null,
};

/** A sandbox's own Runner, which the Machines page never shows. */
export const sandboxRunner: RunnerView = {
  ...buildbox,
  id: "rnr_sbx",
  name: "sandbox-sbx_1",
  online: true,
  hostname: "3f9c2a1b7d4e",
  repos: [],
  labels: ["os:linux", "arch:x86_64"],
  ephemeral: true,
  sandboxId: "sbx_1",
};

export const providerConnectors: ConnectorView[] = [
  {
    id: "docker",
    name: "Docker",
    description: "Runs each sandbox as a container on a Docker host.",
    setupHelp: "Point it at the Docker socket, or at a remote host over TLS.",
    credentialsSchema: {
      $schema: SCHEMA,
      type: "object",
      properties: { host: { type: "string", description: "Docker host" } },
      required: ["host"],
      additionalProperties: false,
    },
    secretFields: [],
    configSchema: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        image: { default: "ghcr.io/sling/sling-sandbox:latest", type: "string" },
        controlPlaneUrl: { type: "string", description: "Control plane URL" },
      },
      required: ["image"],
      additionalProperties: false,
    },
    nodeTypes: [],
  },
  {
    id: "railway",
    name: "Railway",
    description: "Runs each sandbox in a Railway Sandbox on your own account.",
    setupHelp: null,
    credentialsSchema: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        apiToken: { type: "string", description: "API token" },
        environmentId: { type: "string", description: "Environment ID" },
      },
      required: ["apiToken", "environmentId"],
      additionalProperties: false,
    },
    secretFields: ["apiToken"],
    configSchema: { $schema: SCHEMA, type: "object", properties: {}, additionalProperties: false },
    nodeTypes: [],
  },
];

export const dockerInstallation: InstallationView = {
  id: "ins_docker",
  connectorId: "docker",
  name: "Docker host",
  enabled: true,
  status: "idle",
  statusDetail: null,
  config: { image: "ghcr.io/sling/sling-sandbox:latest" },
  hasCredentials: true,
  createdAt: t0,
  updatedAt: t0,
};

export const busySandbox: SandboxView = {
  id: "sbx_1",
  state: "busy",
  providerInstallationId: "ins_docker",
  providerName: "Docker host",
  connectorId: "docker",
  taskId: "tsk_sbx",
  taskTitle: "Fix the signup form",
  image: "ghcr.io/sling/sling-sandbox:latest",
  externalId: "3f9c2a1b7d4e8f60a1b2c3d4e5f60718293a4b5c6d7e8f90",
  failure: null,
  runnerId: "rnr_sbx",
  requestedAt: "2026-11-05T10:00:00.000Z",
  readyAt: "2026-11-05T10:00:12.000Z",
  destroyedAt: null,
  minutes: 4,
};

export const failedSandbox: SandboxView = {
  id: "sbx_2",
  state: "failed",
  providerInstallationId: "ins_docker",
  providerName: "Docker host",
  connectorId: "docker",
  taskId: "tsk_old",
  taskTitle: "Bump the linter",
  image: "ghcr.io/sling/sling-sandbox:latest",
  externalId: null,
  failure: "The Runner didn't connect within 10 minutes.",
  runnerId: null,
  requestedAt: "2026-11-04T09:00:00.000Z",
  readyAt: null,
  destroyedAt: "2026-11-04T09:10:00.000Z",
  minutes: 0,
};

export const destroyedSandbox: SandboxView = {
  id: "sbx_3",
  state: "destroyed",
  providerInstallationId: "ins_docker",
  providerName: "Docker host",
  connectorId: "docker",
  taskId: "tsk_done",
  taskTitle: "Add a changelog",
  image: "ghcr.io/sling/sling-sandbox:latest",
  externalId: "9a8b7c6d5e4f",
  failure: null,
  runnerId: null,
  requestedAt: "2026-11-03T15:00:00.000Z",
  readyAt: "2026-11-03T15:00:10.000Z",
  destroyedAt: "2026-11-03T15:12:10.000Z",
  minutes: 12,
};

export const sandboxList: SandboxListView = {
  sandboxes: [busySandbox, failedSandbox, destroyedSandbox],
  usage: {
    monthMinutes: 150,
    monthlyMinutesBudget: 600,
    running: 1,
    concurrentLimit: 2,
    estimatedMonthCost: 1.25,
  },
};

export const sandboxRepos: SandboxRepoView[] = [
  {
    remoteKey: "github.com/a/api",
    cloneUrl: "https://github.com/a/api.git",
    defaultBranch: "trunk",
    network: true,
    createdAt: t0,
  },
];

export const sandboxSettings: SandboxSettingsView = {
  defaultHarness: "codex",
  concurrentLimit: 2,
  lifetimeMinutes: 60,
  monthlyMinutesBudget: 600,
  costPerHour: {},
  secrets: { openaiApiKey: true, anthropicApiKey: false, gitToken: false },
};

const baseTask: TaskView = {
  id: "tsk_1",
  conversationId: "cnv_1",
  runnerId: "rnr_1",
  runnerName: "devbox",
  harness: "codex",
  environment: { kind: "machine", sandboxId: null, sandboxState: null, providerName: null },
  routing: null,
  repoName: "site",
  title: "Make footer year dynamic",
  objective: "Use the current year.",
  mode: "supervised",
  deliver: "pr",
  state: "running",
  branch: "sling/abc123-make-footer-year-dynamic",
  commitSha: null,
  diffStats: null,
  summary: null,
  error: null,
  harnessVersion: "0.166.0",
  runnerOffline: false,
  cancelRequested: false,
  createdAt: "2026-11-05T10:01:00.000Z",
  startedAt: "2026-11-05T10:01:01.000Z",
  finishedAt: null,
  actions: [],
};

/** Routed to one of two machines that have the repo. */
export const machineTask: TaskView = {
  ...baseTask,
  routing: {
    target: { kind: "machine", runnerId: "rnr_1", runnerName: "devbox" },
    reason: "devbox has site and Codex ready, and the most free slots.",
    considered: [
      { runnerId: "rnr_2", runnerName: "buildbox", eligible: false, reason: "Offline." },
      { runnerId: "rnr_1", runnerName: "devbox", eligible: true, reason: "2 of 2 slots free." },
    ],
    decidedAt: "2026-11-05T10:01:00.000Z",
  },
};

/** Running in a sandbox, after its fallback was approved. */
export const sandboxTask: TaskView = {
  ...baseTask,
  id: "tsk_sbx",
  runnerId: "rnr_sbx",
  runnerName: "sandbox-sbx_1",
  harness: "claude-code",
  harnessVersion: "2.1.4",
  title: "Fix the signup form",
  environment: {
    kind: "sandbox",
    sandboxId: "sbx_1",
    sandboxState: "busy",
    providerName: "Docker host",
  },
  routing: {
    target: { kind: "sandbox", providerInstallationId: "ins_docker", providerName: "Docker host" },
    reason: "No machine with site is online, so it runs in a sandbox you approved.",
    considered: [{ runnerId: "rnr_1", runnerName: "devbox", eligible: false, reason: "Offline." }],
    decidedAt: "2026-11-05T10:00:00.000Z",
  },
};

/** Not bound yet: no machine could take it, and the fallback waits for you. */
export const waitingTask: TaskView = {
  ...baseTask,
  id: "tsk_wait",
  runnerId: null,
  runnerName: null,
  state: "queued",
  title: "Update the README badges",
  harnessVersion: null,
  startedAt: null,
  environment: { kind: "sandbox", sandboxId: null, sandboxState: null, providerName: null },
  routing: {
    target: null,
    reason: "No machine can take it right now.",
    considered: [
      { runnerId: "rnr_1", runnerName: "devbox", eligible: false, reason: "Offline." },
      {
        runnerId: "rnr_2",
        runnerName: "buildbox",
        eligible: false,
        reason: "Doesn't have site.",
      },
    ],
    decidedAt: "2026-11-05T10:02:00.000Z",
  },
};

export const fallbackApproval: ApprovalView = {
  id: "apv_fb",
  kind: "sandbox_fallback",
  title: "Run Update the README badges in a sandbox?",
  state: "pending",
  expiresAt: "2026-11-06T10:02:00.000Z",
  createdAt: "2026-11-05T10:02:00.000Z",
  taskId: "tsk_wait",
  actionId: null,
  actionKind: null,
  task: null,
  prTitle: null,
  prBody: null,
  runId: null,
  payload: {
    taskId: "tsk_wait",
    taskTitle: "Update the README badges",
    remoteKey: "github.com/a/site",
    cloneUrl: "https://github.com/a/site.git",
    providerInstallationId: "ins_docker",
    providerName: "Docker host",
    harness: "codex",
    reasons: ["devbox: Offline.", "buildbox: Doesn't have site."],
  },
};
