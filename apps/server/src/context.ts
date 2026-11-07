import type { Db } from "@sling/db";
import type { LanguageModel } from "ai";
import type { FastifyBaseLogger } from "fastify";
import type { PgBoss } from "pg-boss";
import type { Agent } from "./agent/agent.ts";
import type { CliChat } from "./agent/cli-chat.ts";
import type { Commands } from "./agent/commands.ts";
import type { Auth } from "./auth/auth.ts";
import type { ChannelService } from "./channels/service.ts";
import type { CheckService } from "./checks/service.ts";
import type { Config } from "./config.ts";
import type { DeployService } from "./deploys/service.ts";
import type { ExtensionService } from "./extensions/service.ts";
import type { FileService } from "./files/service.ts";
import type { MemoryService } from "./memory/service.ts";
import type { OAuthService } from "./oauth/service.ts";
import type { PushService } from "./push/service.ts";
import type { Hub } from "./realtime/hub.ts";
import type { RuleService } from "./rules/service.ts";
import type { RunnerGateway } from "./runners/gateway.ts";
import type { SandboxService } from "./sandboxes/service.ts";
import type { SourceService } from "./sources/service.ts";
import type { TaskService } from "./tasks/service.ts";
import type { ConnectorRuntime } from "./workflows/connectors/runtime.ts";
import type { Engine } from "./workflows/engine.ts";
import type { EventBus } from "./workflows/events.ts";
import type { NodeRegistry } from "./workflows/registry.ts";
import type { WorkflowService } from "./workflows/service.ts";

/** Everything route handlers and services share. Built once in server.ts. */
export interface AppContext {
  config: Config;
  db: Db;
  auth: Auth;
  log: FastifyBaseLogger;
  /** Key for credentials at rest (AES-256-GCM). */
  secretsKey: Buffer;
  hub: Hub;
  runners: RunnerGateway;
  tasks: TaskService;
  sandboxes: SandboxService;
  agent: Agent;
  /** Assistant turns run on a coding agent's CLI on one of the user's machines. */
  cliChat: CliChat;
  /** The assistant's shell commands, and the ones waiting for approval. */
  commands: Commands;
  /** Node types the workflow engine can run, and the connectors that brought some. */
  registry: NodeRegistry;
  engine: Engine;
  /** Offers events to workflow triggers. */
  events: EventBus;
  workflows: WorkflowService;
  connectors: ConnectorRuntime;
  /** Installed extensions, catalogs, and trusted publishers. */
  extensions: ExtensionService;
  /** Deploy targets, and the merge, deploy, and verify steps of tasks. */
  deploys: DeployService;
  /** Web Push to people's devices. */
  push: PushService;
  /** Lasting facts about the user, for prompts and `recall`. */
  memory: MemoryService;
  /** Searching and reading the folders machines share. */
  files: FileService;
  /** Allow rules that skip a question, and start rules that open a chat. */
  rules: RuleService;
  /** What Sling watches on its own, and the checks of actions outside Sling. */
  checks: CheckService;
  /** iMessage and Signal, through the machines that relay them. */
  channels: ChannelService;
  /** OAuth sign-in and tokens for connectors that use the user's own client. */
  oauth: OAuthService;
  /** Files and links personalities answer from, and files attached in chats. */
  sources: SourceService;
  /** Durable jobs. Null until the server has started it. */
  boss: PgBoss | null;
  /** Replaces the workspace model everywhere. Tests use a scripted mock. */
  modelOverride: LanguageModel | undefined;
}
