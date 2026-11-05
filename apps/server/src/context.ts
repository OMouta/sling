import type { Db } from "@sling/db";
import type { FastifyBaseLogger } from "fastify";
import type { Agent } from "./agent/agent.ts";
import type { Auth } from "./auth/auth.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./realtime/hub.ts";
import type { RunnerGateway } from "./runners/gateway.ts";
import type { TaskService } from "./tasks/service.ts";

/** Everything route handlers and services share. Built once in main.ts. */
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
}
