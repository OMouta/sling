import { createDatabase, runMigrations } from "@sling/db";
import { Agent } from "./agent/agent.ts";
import { createAuth } from "./auth/auth.ts";
import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { deriveKey } from "./crypto.ts";
import { createServer, registerRoutes } from "./http/app.ts";
import { startJobs } from "./jobs.ts";
import { Hub } from "./realtime/hub.ts";
import { RunnerGateway } from "./runners/gateway.ts";
import { TaskService } from "./tasks/service.ts";

const config = loadConfig();
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
  // Replaced right below; the gateway needs the finished context.
  runners: undefined as unknown as RunnerGateway,
  tasks: undefined as unknown as TaskService,
  agent: undefined as unknown as Agent,
};
ctx.runners = new RunnerGateway(ctx);
ctx.tasks = new TaskService(ctx);
ctx.agent = new Agent(ctx);
ctx.runners.handlers = ctx.tasks;
ctx.tasks.onSettled = (taskId, reason) => ctx.agent.onTaskSettled(taskId, reason);
ctx.runners.start();
const boss = await startJobs(ctx, config.databaseUrl);

await registerRoutes(app, ctx);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  ctx.runners.stop();
  await boss.stop();
  await app.close();
  await database.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
await ctx.agent.recover();
