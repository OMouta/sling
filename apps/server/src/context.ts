import type { Db } from "@sling/db";
import type { LanguageModel } from "ai";
import type { FastifyBaseLogger } from "fastify";
import type { PgBoss } from "pg-boss";
import type { Agent } from "./agent/agent.ts";
import type { Auth } from "./auth/auth.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./realtime/hub.ts";
import type { RunnerGateway } from "./runners/gateway.ts";
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
  agent: Agent;
  /** Node types the workflow engine can run, and the connectors that brought some. */
  registry: NodeRegistry;
  engine: Engine;
  /** Offers events to workflow triggers. */
  events: EventBus;
  workflows: WorkflowService;
  connectors: ConnectorRuntime;
  /** Durable jobs. Null until the server has started it. */
  boss: PgBoss | null;
  /** Replaces the workspace model everywhere. Tests use a scripted mock. */
  modelOverride: LanguageModel | undefined;
}
