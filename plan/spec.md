# Sling

> **Your agents. Your machines. Your workflows.**
>
> Open-source infrastructure for building AI assistants and automations that can delegate work to specialized agents, operate across your devices, and run in self-hosted or cloud environments.

**Document type:** Product vision and technical concept  
**Status:** Concept / proposed architecture  
**License:** Open source; exact license to be chosen  
**Brand:** Sling (working product name; trademark and domain availability not established)

---

## 1. Executive summary

**Sling is an open-source, self-hostable platform that combines a personal AI assistant, a visual workflow builder, and a distributed agent execution system.**

Users interact with Sling from the web app, desktop app, Discord, or other connected interfaces. Sling receives requests, understands intent, runs workflows, and delegates work to the right tool or agent. A user can automate incoming emails, schedule personal briefings, or send a message while away from home asking Sling to investigate and fix a broken website.

Sling's **master agent is an orchestrator, not necessarily the worker**. It should discover available capabilities and delegate coding to an existing coding agent—such as Codex or Claude Code—when one is installed and authorized on a connected machine. It should not duplicate that coding agent by making source-code edits itself when the appropriate specialist is available. The master agent coordinates, checks progress, requests approvals, and returns results.

The system runs wherever the user chooses: on a home server, a local computer, or a hosted server. Separately installed **Sling Runners** connect machines to that central installation. Optional execution providers can provision isolated environments, including disposable cloud VMs through services such as Railway, subject to their current offerings and APIs.

Workflows are a first-class feature, not an afterthought. The assistant itself is built from reusable workflow capabilities, and chat interfaces are delivered through installable integrations and workflow templates rather than being hard-coded into the engine. Users can operate Sling without touching a visual canvas, or open the canvas to inspect and change what their assistants do.

### One-sentence pitch

**Sling lets you talk to your tools, automate your apps, and delegate real work to agents running on your own machines or isolated cloud environments.**

### Product principles

1. **Assistant and automation are equally first-class.** Neither is merely a menu inside the other.
2. **Orchestrate, don't reinvent.** Reuse strong specialized agents instead of rebuilding their abilities inside Sling.
3. **Everything is composable.** Interfaces, triggers, conditions, models, actions, and agent tasks use the same workflow system.
4. **Users control where work runs.** Local PC, home server, self-hosted container, or optional cloud environment.
5. **No artificial lock-in.** Pluggable model providers, coding harnesses, integrations, and execution backends.
6. **Safe by design.** Explicit capabilities, isolation, auditable runs, constrained credentials, and approval gates.
7. **Understandable behavior.** Users can inspect what happened, which agent did it, where it ran, and why it failed.

---

## 2. The problem

Today's tools are often separated into distinct products:

- **AI chat apps** answer questions but do not reliably perform long-running operations across a person's devices and services.
- **Automation builders** connect apps but frequently treat AI as one isolated step, rather than a coordinating agent.
- **Coding agents** can modify repositories but usually expect the user to be near the development environment, or require separately managed remote infrastructure.
- **Cloud sandboxes** offer isolated compute but do not themselves provide a unified personal assistant, workflow editor, or distributed device network.

Sling connects these capabilities into one coherent system. The user shouldn't need to decide in advance whether a request is a chatbot message, a workflow, or a remote coding task. Sling routes the work to the right execution path, while keeping consequential actions under user control.

### Who Sling is for

- Developers who want to ask a remote coding agent to work on a repository from their phone.
- Self-hosters who want an assistant connected to their own PCs, servers, and services.
- Power users who want visual automations with AI reasoning in the middle.
- Teams or individuals who want transparent, auditable, reusable AI workflows.
- Open-source contributors building new connectors, workflow nodes, model providers, and execution backends.

Sling should begin with a strong single-user experience, while designing identities, permissions, and ownership so multi-user setups are possible later.

---

## 3. What using Sling feels like

### 3.1 Chat with your assistant from anywhere

A user can open Sling's web app or message Sling through Discord or another connected messaging service.

**Example:**

> **User:** My website is down. Figure out why and fix it.
>
> **Sling:** I'll check availability, deployment health, and recent changes. Your development PC is online and has Codex installed. I'll delegate the coding task there.
>
> **Sling:** The failure appears related to a recent configuration change. Codex prepared a fix on a new branch, and tests passed. Here's the diff and commit. Do you want to deploy?

Sling is responsible for communicating and coordinating. The remote specialist is responsible for carrying out authorized coding work. Production deployment can be explicitly gated by approval.

### 3.2 Build automations visually

A user can assemble a workflow using a node-based editor inspired by Scratch's approachability and Blueprint's visual data/execution graph.

**Example:**

```text
[Gmail: Email Received]
         |
         v
[Condition: Sender Is Important]
         |
      Yes v
[AI: Summarize Email + Extract Action Items]
         |
         v
[Discord: Send Summary + Mention User]
```

The workflow can use an LLM for a single structured transformation without turning every step into an autonomous agent.

### 3.3 Reuse an assistant across multiple interfaces

```text
[Discord: Message Received] ----\
                                 --> [Load Conversation] --> [Sling Assistant] --> [Route Reply]
[Sling App: Message Sent] -------/
```

Both paths can share the same configured assistant, memories, tools, and policies. The interface is an adapter, not a separate assistant implementation.

### 3.4 Work across many machines

The user may pair a Windows desktop, a MacBook, and a Linux server. Each device reports its status and approved capabilities. Sling can choose an eligible Runner automatically or let the user select a machine explicitly.

**Examples:**

- “Run the tests for this repository on my Windows PC.”
- “Check disk space on my home server.”
- “Use my Mac for the iOS build.”
- “My PC is offline. Create a fresh sandbox, clone the repository, and open a PR instead.”

The last option should require the necessary permissions and must not silently transfer private local files or secrets to a cloud environment.

---

## 4. Product surfaces

Sling has two equally important primary experiences.

### 4.1 Assistant experience

A direct, conversational interface for issuing requests and monitoring work.

Core features:

- Persistent conversations, with resumable histories.
- Text and supported attachments.
- Streaming responses and task progress.
- Tool/agent delegation and status visibility.
- Human approvals for sensitive actions.
- A task timeline showing the acting agent, selected machine, actions taken, outputs, and errors.
- Multiple named assistants or profiles, later if useful.

Users should be able to get value quickly: install Sling, connect a model provider, connect an interface, pair a Runner, and delegate a small task.

### 4.2 Workflow experience

A canvas for designing repeatable operations, including both conventional automations and AI-driven behavior.

Core features:

- Drag-and-drop nodes, zoom, pan, grouping, and keyboard shortcuts.
- Typed input/output ports with editor validation.
- Execution edges for control flow and data edges for passing values.
- Triggers, conditions, loops, transforms, AI nodes, tool actions, approvals, waits, and subworkflows.
- Prompt editing without overcrowding the canvas.
- Run/test controls, step inspection, execution history, and error tracing.
- Versioned workflows and import/export.
- Installable official templates that remain fully editable.

The visual editor should be accessible to non-programmers without hiding its underlying execution logic from technical users.

---

## 5. High-level architecture

```text
                   USER-FACING INTERFACES
          Web App | Desktop | Discord | CLI | API
                              |
                              v
                  +-----------------------+
                  |   SLING CONTROL PLANE |
                  |-----------------------|
                  | Identity & Policies   |
                  | Conversations         |
                  | Master Agent          |
                  | Workflow Engine       |
                  | Scheduling & Queues   |
                  | Credential References |
                  | Logs & Audit          |
                  +-----------------------+
                     |       |        |
           connectors|       | jobs   | providers
                     v       v        v
                 Gmail    Runners   Cloud Sandboxes
                 Discord     |      / Docker / VMs
                 GitHub      |            |
                 HTTP    Local Machines   |
                           |              |
                           v              v
                   Codex / Claude Code / Other
                     Coding and Tool Agents
```

The conceptual components are:

1. **Control plane:** Central, persistent installation for users, configuration, workflows, tasks, scheduling, permissions, and orchestration.
2. **Master agent:** Reasoning and coordination layer that decides when to use tools, run workflows, or delegate to specialists.
3. **Workflow engine:** Executes graphs, manages state, and records results.
4. **Connector system:** Adds external app triggers and actions.
5. **Runner network:** Authenticated agents on user-owned machines that execute authorized work.
6. **Execution providers:** Optional integrations that provision temporary environments such as containers or cloud VMs.
7. **Specialist adapters:** Integrations that invoke and observe Codex, Claude Code, or other agent harnesses.
8. **Model providers:** Pluggable backends for LLM inference.

### The control plane is not the desktop app

The control plane should keep running after a browser tab or desktop UI closes. It can live on a home server, VPS, or always-on computer. The UI is a client of that service.

A single-machine setup may combine the control plane and Runner on one computer. A distributed setup can separate them without changing the workflow model.

---

## 6. Master agent and delegation

This is Sling's defining behavior.

**The master agent coordinates work; specialist agents perform specialized work.**

For coding-related tasks, Sling should prefer an eligible configured coding agent rather than performing direct source edits through a generic LLM tool loop.

### Responsibilities of the master agent

- Interpret a request and identify objectives.
- Decide whether to answer directly, invoke a workflow, call a tool, or delegate to a specialist.
- Find available machines, connectors, and specialists.
- Select an authorized execution environment.
- Prepare a bounded task with context, expected outputs, and constraints.
- Monitor progress, handle failures, and ask clarifying questions or request approvals when necessary.
- Summarize results and link to artifacts such as commits or pull requests.

### Responsibilities of a specialist

- Perform the assigned task using its native harness and tools.
- Operate within an approved environment and scope.
- Return structured status, logs, relevant artifacts, and final results.
- Stop or pause when permissions are insufficient.

### Example delegation contract

```ts
interface DelegatedTask {
  id: string;
  kind: "coding" | "research" | "operations" | "custom";
  objective: string;
  context?: Record<string, unknown>;
  target?: {
    runnerId?: string;
    environmentId?: string;
    workspace?: string;
  };
  constraints: {
    allowedCapabilities: string[];
    requiresApprovalFor: string[];
    timeoutSeconds?: number;
  };
  expectedOutputs?: string[];
}

interface DelegatedResult {
  taskId: string;
  status: "succeeded" | "failed" | "cancelled" | "needs_approval";
  summary: string;
  artifacts?: Array<{ type: string; uri: string }>;
  logsRef?: string;
}
```

The delegation contract should be technology-neutral. An adapter translates it to the invocation pattern of a specific coding harness, including its authorization and session model.

### Important rule

A master agent may inspect and summarize code-related information when authorized, but **should not take over actual source changes when an appropriate approved specialist is available**. Fallback behavior should be explicit and configurable, not a hidden substitution.

---

## 7. Sling Runner: remote execution on your machines

**Sling Runner** is a lightweight companion service installed on Windows, macOS, or Linux. It allows the control plane to delegate approved tasks to a specific device.

### Runner responsibilities

- Pair securely with a Sling installation.
- Initiate an authenticated outbound connection (no inbound port forwarding required by default).
- Advertise machine status and allowed capabilities.
- Receive, validate, execute, and report on authorized tasks.
- Discover or configure supported local specialist harnesses.
- Stream progress and logs; support cancellation and reconnection.
- Enforce machine-level and task-level security boundaries.

### Example capabilities

```text
filesystem.read
filesystem.write
terminal.execute
git.read
git.write
browser.automation
coding.codex
coding.claude-code
system.health
```

Capabilities must describe actual authorized access, not just installed software. A Runner supporting `terminal.execute` does not mean every workflow automatically receives it.

### Pairing and transport

A possible pairing experience:

```bash
sling runner install
sling runner pair
```

The pairing flow should use a short-lived enrollment token or interactive approval, exchange device credentials securely, and give each Runner a revocable identity. Prefer outbound TLS connections with mutually authenticated device identity or equivalent secure authorization. Rotate credentials and avoid storing long-lived master secrets on every Runner.

### Security boundary

A path allowlist is **not** sufficient sandboxing for unrestricted shell access. For untrusted or high-risk tasks, use a dedicated OS user, container, or VM with carefully scoped mounts, credentials, and network access. The local Runner should not silently inherit the full permissions of its human user.

### Multiple devices

Each Runner can advertise labels and requirements such as OS, architecture, available tools, approved workspaces, current availability, and supported isolation modes. The scheduler can then route tasks to a compatible machine.

---

## 8. Execution environments and cloud sandboxes

Sling should treat **where a task runs** as a pluggable concern.

### Supported environment types (proposed)

| Environment | Typical use | Persistence |
|---|---|---|
| Local Runner | User-owned tools, files, and development environments | Long-lived |
| Home-server Runner | Monitoring, background jobs, self-hosted services | Long-lived |
| Docker environment | Isolated self-hosted execution | Configurable |
| Cloud sandbox / VM | Clean disposable coding or research tasks | Ephemeral |
| SSH-managed host | Existing remote infrastructure, when explicitly configured | Long-lived |

### Railway as an optional add-on

A Railway integration could create, manage, and destroy remote sandbox environments using whatever sandbox/VM functionality and API its current product exposes. The desired flow is:

1. User installs and configures the Railway connector, using their own account and credentials.
2. Sling requests a new sandbox for an approved task.
3. The provider creates an isolated environment with necessary tooling.
4. Sling checks out an allowed repository and injects only narrowly scoped credentials.
5. A specialist agent runs the task and produces results.
6. Sling collects logs, commits, patches, or PR links and tears down the environment according to policy.

**Railway is not a required dependency.** It is one potential execution provider. Its exact sandbox availability, API surface, supported images, pricing, and checkpoint/fork semantics must be verified before implementation.

### Environment provider interface

```ts
interface ExecutionProvider {
  id: string;
  capabilities: {
    create: boolean;
    exec: boolean;
    snapshots?: boolean;
    forks?: boolean;
    interactiveSessions?: boolean;
  };

  create(config: EnvironmentConfig): Promise<Environment>;
  execute(id: string, task: ExecutionTask): Promise<ExecutionHandle>;
  destroy(id: string): Promise<void>;
}
```

Snapshots and forks should be optional rather than assumed across providers.

### Automatic routing

The scheduler may consider:

- Is the selected machine online and authenticated?
- Is the required specialist available and configured?
- Does the machine have the correct operating system and workspace access?
- Is the environment allowed to handle this data?
- Does the task need isolation or a human approval?
- What will the environment cost, and what are its limits?

Cloud fallback should never silently upload files, secrets, or repository content that the user restricted to local devices.

---

## 9. Workflow engine

Sling workflows are versioned graphs of connected nodes. A workflow may run from an event, a schedule, an API call, a chat message, or another workflow.

### Node families

| Family | Examples |
|---|---|
| Triggers | Email received, Discord message, webhook, schedule, app message |
| Logic | If/else, switch, filter, loop, transform |
| AI | Prompt, classify, extract, summarize, agent |
| Actions | HTTP request, send Discord message, create file, GitHub operation |
| State | Load conversation, save key/value, retrieve context |
| Human-in-the-loop | Ask for approval, request input, await response |
| Agent delegation | Execute specialist, select Runner, create sandbox |
| Composition | Invoke workflow, return value, handle error |

### Execution semantics

The workflow runtime should distinguish:

- **Workflow definition:** The graph and its configuration.
- **Workflow version:** An immutable revision used for repeatability.
- **Workflow execution:** A specific run of a version with inputs and state.
- **Task:** An individual unit of work, including delegated agent work.
- **Conversation:** Persistent chat context shared across many short executions.
- **Approval:** A durable, auditable checkpoint that may pause execution.

This distinction matters because an email summary takes seconds, a coding task might take much longer, and an approval can remain pending after the user closes the app.

### Reliability requirements

- Persist workflow state and task status.
- Resume or reconcile jobs after process restarts.
- Make action retries explicit and safe.
- Use idempotency keys for external side effects where possible.
- Support cancellation, timeouts, backoff, and dead-letter handling.
- Record structured inputs/outputs with secret redaction.
- Make run versions and agent/harness versions visible in logs.

For especially important actions (sending messages, deploying, deleting resources), avoid accidental duplicate execution during retries.

### Data connections and control connections

The canvas should distinguish *what runs next* from *what data a node receives*. Typed ports, schema-aware autocomplete, validation, and execution tracing are essential for complex workflows.

---

## 10. Interfaces and integrations are workflows too

Sling should not hard-code a Discord chatbot as a special backend feature.

A **connector** provides platform capabilities, while a **template** packages those capabilities into a usable workflow.

### Example: Discord AI assistant template

```text
[Discord: New Message]
           |
           v
[Authorize Sender]
           |
           v
[Load Conversation]
           |
           v
[Invoke Assistant Workflow]
           |
           v
[Discord: Send Reply]
```

### Example: Built-in chat template

```text
[App: Chat Message] -> [Load Conversation] -> [Invoke Assistant Workflow] -> [Stream App Reply]
```

Both are assembled from shared primitives. The native app may provide a polished default chat surface, but its *behavior* should still route through the same workflow engine and agent interfaces.

### Official templates (examples)

- Discord AI Assistant
- Personal Email Briefing
- Website Health Monitor
- GitHub Issue to Coding Agent
- Daily Schedule Summary
- Incident Investigator
- Approval-Based Deployment
- Cross-Machine Test Runner

All official workflows should be inspectable, forkable, and editable. Community workflows can use the same format.

### Connector SDK

Connector packages might provide:

- Actions (send message, fetch file, create issue).
- Event triggers (message received, issue opened).
- Credential configuration and OAuth flows.
- Typed schemas and UI metadata for nodes.
- Rate limit and retry behavior.
- Permissions/secret requirements.

Third-party connectors execute code or handle sensitive credentials, so the extension system needs package signing/verification options, trust indicators, explicit permissions, and meaningful isolation before an open marketplace is offered.

---

## 11. Models, subscriptions, and coding harnesses

Sling must distinguish three independent concepts:

| Concept | Role | Examples |
|---|---|---|
| **Model provider** | Supplies model inference | OpenAI API, eligible ChatGPT subscription integration, Ollama, compatible APIs |
| **Agent harness** | Controls tools and carries out an agent task | Codex, Claude Code, OpenCode, custom harness |
| **Execution provider** | Supplies the machine or sandbox | Local Runner, Docker, Railway-backed environment |

A user should be able to configure combinations supported by the relevant providers and licensing terms.

### Bring your own provider

A proposed provider adapter:

```ts
interface ModelProvider {
  id: string;
  listModels(): Promise<Model[]>;
  generate(request: GenerateRequest): AsyncIterable<GenerateEvent>;
}
```

Adapters should expose their supported features (streaming, tools, structured output, images, rate limits, and so on), so Sling doesn't assume every model behaves identically.

### Existing subscriptions

One of Sling's goals is letting users reuse eligible existing AI subscriptions when a provider explicitly offers an authorized third-party integration. For OpenAI, this may include a supported **Sign in with ChatGPT** flow for eligible open-source software, subject to its current documentation, model eligibility, limits, deployment restrictions, and terms.

**Important:** a consumer subscription is not automatically an unrestricted API key. Nor does access to a ChatGPT subscription necessarily authorize running Codex remotely or using a different agent harness. These are separate integration and licensing questions. Sling should never rely on undocumented authentication tricks or extracting session credentials from another application.

A robust first release can support documented provider flows and API-key providers, with more subscription integrations added only where officially permitted.

### Coding harness adapters

An adapter should be able to:

- Detect whether the harness is installed and usable on a specific Runner.
- Verify or report its existing authentication state without harvesting credentials.
- Submit a scoped task in a supported, noninteractive or interactive mode.
- Stream structured progress and tool results where supported.
- Stop/cancel tasks, capture exit status, and surface artifacts.
- Report harness limitations clearly.

Model-provider configuration and coding-harness authorization should remain independently managed.

---

## 12. Canonical scenarios

### Scenario A: Important email → AI summary → Discord

1. Gmail trigger receives an email event.
2. A condition checks the sender against an allowlist.
3. An LLM node summarizes the message and extracts action items.
4. A Discord action posts the summary to the configured destination and mentions the user.
5. The run is stored with redacted logs and retry state.

### Scenario B: “My website is down; fix it”

1. The user messages Sling from Discord while away.
2. Sling authenticates the sender and identifies the relevant site or asks if ambiguous.
3. An incident workflow checks availability, deployment health, logs, and recent commits using approved connectors.
4. The master agent discovers a suitable connected Runner with Codex or Claude Code.
5. Sling delegates a bounded diagnosis/repair task to that specialist.
6. The specialist creates a branch or isolated worktree, proposes changes, and runs tests.
7. Sling collects the diff, commit, logs, and results.
8. Any production deployment passes through the configured approval gate.
9. Sling reports the outcome, links, and remaining risks in Discord.

**Success is not assumed from a passing test.** Health checks after an approved deployment should confirm whether the incident actually resolved.

### Scenario C: PC offline → cloud fallback

1. A coding workflow requests a project-specific Runner.
2. Sling detects the device is offline.
3. The configured policy permits an alternative cloud environment, and the user approves if required.
4. Sling provisions a disposable sandbox through a configured provider.
5. It clones the authorized remote repository and invokes the coding specialist.
6. It returns a patch/PR, records cost and logs, and destroys or retains the sandbox according to policy.

A cloud fallback cannot access uncommitted local-only files unless the user intentionally supplies them.

### Scenario D: Parallel agent tasks

1. A user asks Sling to investigate three possible causes of a failing build.
2. The workflow forks into bounded subtasks on eligible environments.
3. Each specialist returns evidence and possible fixes.
4. The orchestrator compares results and presents an actionable recommendation.
5. Any merged or deployed change follows the repository policy.

Parallelism is optional and must have concurrency, spending, and time limits.

---

## 13. Security, privacy, and trust

Remote execution and autonomous action create real risks. Security should be a core product feature, not a disclaimer.

### Core requirements

**Identity and authorization**

- Authenticate users and external message senders.
- Pair Runners with revocable per-device credentials.
- Scope workflows, users, and agents to specific capabilities.
- Prevent one compromised integration from gaining unrestricted access to every device.

**Least privilege**

- Workspace and repository allowlists.
- Read-only by default where practical.
- Separate permissions for reading, modifying, pushing, deploying, and deleting.
- Explicit permission to move data from local machines to cloud environments.

**Isolation**

- Sandbox untrusted work.
- Use dedicated users, containers, or VMs for risky command execution.
- Treat local unrestricted terminal access as a high-trust capability.

**Credentials**

- Encrypt secrets at rest with an appropriate key-management approach.
- Prefer short-lived credentials and scoped tokens.
- Never paste all user secrets into model context.
- Redact secrets in logs and traces.
- Allow credentials and devices to be revoked.

**Human approvals**

- Approval gates for production deploys, external communications, purchases, destructive file operations, or other configured sensitive actions.
- Clear previews of the proposed action and affected systems.
- Durable approvals that survive restarts and can expire.

**Prompt injection and untrusted inputs**

- Treat emails, webpages, repository files, logs, and tool outputs as untrusted data.
- Do not let instructions embedded in retrieved content override the user or system's permissions.
- Keep capability enforcement outside the LLM.

**Auditability**

- Record who requested a task, where it ran, which agent/harness acted, and what changed.
- Provide logs and artifacts with configurable retention and redaction.
- Support task cancellation and emergency disabling of individual Runners or connectors.

---

## 14. Suggested technical stack

This is an initial direction, not a permanent commitment.

| Layer | Candidate technology |
|---|---|
| Web client | React + TypeScript |
| Visual editor | React Flow / XYFlow |
| Desktop client | Tauri, optionally later |
| Control plane | Node.js + TypeScript |
| API / realtime | HTTP + WebSocket |
| Schema validation | Zod |
| Initial persistence | SQLite for simple single-instance installs |
| More scalable persistence | PostgreSQL if required |
| Job execution | Durable queue and workflow state machine |
| Runner | Cross-platform service with a secure control-plane connection |
| Isolation | Docker/OS sandbox/VM, depending on task |
| Extensions | Versioned TypeScript SDK and manifest |

### Data model concepts

```text
User
Workspace / Installation
Identity / Auth Session
Credential Reference
Connector Installation
Workflow
Workflow Version
Workflow Execution
Node Execution
Conversation
Message
Agent Profile
Delegated Task
Runner
Execution Environment
Approval Request
Artifact
Audit Event
```

The long-running task system is central. It needs durable task IDs, retry-safe state transitions, cancellation, and reconciliation if a Runner disconnects halfway through a task.

### Possible monorepo shape

```text
sling/
  apps/
    web/                 # assistant + workflow UI
    desktop/             # optional desktop shell
    server/              # control plane
    runner/              # local execution companion
  packages/
    core/                # shared domain contracts
    workflow-engine/     # DAG execution + durable state
    agent-orchestrator/  # master-agent routing/delegation
    provider-sdk/        # model provider contracts
    connector-sdk/       # triggers/actions/credentials
    runner-protocol/     # device transport and jobs
    harness-sdk/         # specialist agent adapters
    execution-sdk/       # local/docker/cloud backends
    ui/                  # shared interface components
  integrations/
    discord/
    gmail/
    github/
    codex/
    claude-code/
    docker/
    railway/
  workflows/
    discord-assistant/
    important-email/
    website-incident/
  docs/
```

These are conceptual package boundaries; avoid over-splitting into packages until their interfaces are needed.

---

## 15. Development strategy

The goal is to prove the entire architecture through useful end-to-end paths, not to launch a giant catalog of shallow integrations.

### Stage 1 — One assistant, one Runner, one specialist

**Outcome:** From another device, ask Sling to delegate a coding task to a connected PC and receive a reliable result.

- Persistent local/self-hosted control plane.
- Basic app chat UI and conversations.
- One model provider using a documented auth method.
- Secure Runner pairing and connection.
- One coding-harness adapter (e.g., Codex), with capability detection.
- Delegated task lifecycle and logs.
- Safe repo-scoped execution with branch/worktree output.
- Approval for consequential actions.

This is the highest-value proof of Sling's difference.

### Stage 2 — Workflows become first-class

**Outcome:** Users can build and run the email example and modify the assistant's behavior.

- Workflow data model and durable engine.
- Visual canvas and typed ports.
- Conditions, basic transforms, LLM nodes, actions, and subworkflows.
- Discord and email connectors.
- Versioning, debug traces, and retries.
- Official templates using the same public node system.

### Stage 3 — More machines and environments

**Outcome:** A task can be routed to the right machine or a fresh sandbox.

- Multiple registered Runners.
- Machine capability discovery and routing.
- Docker execution provider.
- Optional Railway-backed execution provider after API validation.
- Sandbox cleanup, quotas, cost controls, and cloud data boundaries.
- Additional coding-harness adapters.

### Stage 4 — Open ecosystem

**Outcome:** Other developers can extend Sling without editing its core.

- Stable connector and execution-provider SDKs.
- Community workflow package format.
- Discovery/install UI for trusted extensions.
- Sandboxing, permission manifests, and package integrity controls.
- Documentation and runnable example integrations.

Stages describe dependency order, not predetermined release names or deadlines.

---

## 16. What Sling should not try to do initially

To keep the product coherent:

- **Do not build a new coding agent from scratch** before testing delegation to existing harnesses.
- **Do not require Railway** or any particular cloud service for normal operation.
- **Do not equate cloud VM access with model access.** Compute, inference, and harness authorization are separate.
- **Do not create bespoke chatbot backends for every interface.** Use connectors and workflows.
- **Do not grant every workflow full remote shell access.** Enforce privileges at the Runner and job level.
- **Do not launch a public extension marketplace** before addressing untrusted code and credentials.
- **Do not make the visual canvas a prerequisite** for ordinary assistant use.
- **Do not hide significant costs.** Cloud execution and API model usage need budgets, visibility, and limits.
- **Do not promise autonomous repair of production systems** without verification, rollback paths, and approval policies.

---

## 17. Open-source approach and ecosystem

Sling should be useful as a fully self-hosted project. The core assistant, visual workflow builder, Runner, and extension interfaces should not require a proprietary hosted control plane.

A potential community ecosystem includes:

- Connector packages for external services.
- Official and community-maintained workflow templates.
- Adapters for new coding harnesses and inference providers.
- Execution providers for local containers and cloud sandboxes.
- Example assistant configurations, with secrets excluded.
- Shared documentation for permissions and security review.

The precise license should be decided intentionally after reviewing project goals and dependency requirements. Do not assume that every connector or bundled external tool can be redistributed under Sling's license.

---

## 18. Brand and product language

**Name:** Sling  
**Category:** Open-source agent and workflow orchestration platform  
**Primary tagline:** *Your agents. Your machines. Your workflows.*

**Alternative short descriptions:**

- “Delegate work to agents, wherever they run.”
- “A home for your assistants and automations.”
- “Connect your tools. Build workflows. Get things done.”

**Suggested terminology:**

| Term | Meaning |
|---|---|
| **Sling** | The product as a whole |
| **Assistant** | User-facing conversational entry point |
| **Master agent** | Orchestrates tasks and delegates to specialists |
| **Workflow** | Reusable graph of triggers, logic, and actions |
| **Connector** | Adds capabilities from an external service |
| **Runner** | Companion running on a user's own machine |
| **Environment** | Location/context where a job executes |
| **Execution provider** | Creates/manages environments (e.g., Docker, Railway) |
| **Specialist** | Coding or other task-focused agent harness |
| **Task** | A delegated or scheduled unit of work |

Avoid inventing separate branded subproducts for every component. “Sling Runner,” “Sling workflow,” and “Sling connector” communicate enough.

### Example README introduction

> **Sling** is an open-source platform for personal AI assistants and visual automations. Connect your apps and machines, build workflows, and delegate work to specialized agents like Codex and Claude Code. Run Sling on your own server, pair your computers with Sling Runner, or provision isolated cloud environments through optional integrations. You control your models, tools, infrastructure, and approvals.

---

## 19. Open design questions

These should be answered during implementation rather than silently assumed:

1. **Runtime:** How much of the orchestration engine must work without any LLM access? (Ideally, deterministic workflows always do.)
2. **Harness integration:** What stable, documented programmatic invocation and status interfaces do the selected coding agents expose?
3. **Local isolation:** What is the safest cross-platform Runner strategy for terminal access on Windows and macOS?
4. **Networking:** Should Runners connect directly to a user's control plane, or should an optional relay service support difficult network setups?
5. **Persistence:** At what scale should PostgreSQL replace SQLite, and how will queue state remain durable?
6. **Model subscriptions:** Which official subscription-based third-party integrations actually authorize Sling's intended deployment modes?
7. **Secrets:** How should credentials be delivered to isolated tasks without exposing unrelated secrets?
8. **Templates:** What is the portable format for workflow graphs, schemas, versions, and referenced connectors?
9. **Approval design:** Which actions should require approval by default, and which can be explicitly preauthorized?
10. **Cloud economics:** How will sandbox time, provider quotas, billing limits, and abandoned sessions be controlled?
11. **Multi-user support:** Which concepts need ownership, roles, and sharing from day one?
12. **Licensing:** Which open-source license best matches the desired contributor and commercial ecosystem?

---

## 20. The north star

A user is away from their computer. They notice their website is down, send Sling a message, and get a useful response:

> “I checked the deployment and logs, delegated a fix to Codex on your development machine, and verified the tests. The proposed change is ready. Approve deployment?”

Another user never touches coding agents. They connect email, Discord, and their calendar, then create visual workflows that extract information, summarize it with an LLM, and send the right notifications.

Both users are using the same system: the same control plane, workflow runtime, extension model, identities, and permissions.

**Sling is the place where an intention becomes a coordinated, observable, authorized execution—whether the work happens in an app, on a personal computer, or inside a disposable cloud environment.**
