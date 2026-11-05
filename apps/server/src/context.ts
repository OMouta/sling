import type { Db } from "@sling/db";
import type { FastifyBaseLogger } from "fastify";
import type { Auth } from "./auth/auth.ts";
import type { Config } from "./config.ts";
import type { Hub } from "./realtime/hub.ts";
import type { RunnerGateway } from "./runners/gateway.ts";

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
  /** Set once the task service is built. */
  tasks?: { runnerRevoked(runnerId: string): Promise<void> };
}
