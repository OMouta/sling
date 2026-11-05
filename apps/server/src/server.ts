import { createDatabase, runMigrations } from "@sling/db";
import type { LanguageModel } from "ai";
import type { FastifyInstance } from "fastify";
import { Agent } from "./agent/agent.ts";
import { createAuth } from "./auth/auth.ts";
import type { Config } from "./config.ts";
import type { AppContext } from "./context.ts";
import { deriveKey } from "./crypto.ts";
import { createServer, registerRoutes } from "./http/app.ts";
import { startJobs } from "./jobs.ts";
import { Hub } from "./realtime/hub.ts";
import { RunnerGateway } from "./runners/gateway.ts";
import { TaskService } from "./tasks/service.ts";

export interface StartOptions {
  /** Replaces the configured model. Tests use a scripted mock. */
  model?: LanguageModel;
  /** Skip pg-boss schedules (tests call sweeps directly). */
  jobs?: boolean;
}

export interface RunningServer {
  app: FastifyInstance;
  ctx: AppContext;
  url: string;
  close(): Promise<void>;
}

/** Builds the whole control plane and starts listening. */
export async function startServer(config: Config, opts: StartOptions = {}): Promise<RunningServer> {
  const app = createServer(config);
  const database = createDatabase(config.databaseUrl);

  await runMigrations(database.db);
  app.log.info("database migrated");

  const ctx: AppContext = {
    config,
    db: database.db,
    auth: createAuth(database.db, config),
    log: app.log,
    secretsKey: deriveKey(config.secretKey, "credentials-v1"),
    hub: new Hub(),
    // Filled in right below; each service needs the finished context.
    runners: undefined as unknown as RunnerGateway,
    tasks: undefined as unknown as TaskService,
    agent: undefined as unknown as Agent,
  };
  ctx.runners = new RunnerGateway(ctx);
  ctx.tasks = new TaskService(ctx);
  ctx.agent = new Agent(ctx, opts.model);
  ctx.runners.handlers = ctx.tasks;
  ctx.tasks.onSettled = (taskId, reason) => ctx.agent.onTaskSettled(taskId, reason);
  ctx.runners.start();
  const boss = opts.jobs === false ? null : await startJobs(ctx, config.databaseUrl);

  await registerRoutes(app, ctx);
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  await ctx.agent.recover();

  return {
    app,
    ctx,
    url: `http://127.0.0.1:${port}`,
    async close() {
      ctx.runners.stop();
      await boss?.stop();
      await app.close();
      await database.close();
    },
  };
}
