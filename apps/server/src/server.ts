import type { AnyConnector } from "@sling/connector-sdk";
import { createDatabase, runMigrations } from "@sling/db";
import type { AnyNodeSpec } from "@sling/workflow";
import type { LanguageModel } from "ai";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { Agent } from "./agent/agent.ts";
import { CliChat } from "./agent/cli-chat.ts";
import { Commands } from "./agent/commands.ts";
import { createAuth } from "./auth/auth.ts";
import type { Config } from "./config.ts";
import type { AppContext } from "./context.ts";
import { deriveKey } from "./crypto.ts";
import { ProcessRuntime } from "./extensions/process-runtime.ts";
import type { ExtensionRuntime } from "./extensions/runtime.ts";
import { ExtensionService } from "./extensions/service.ts";
import { createServer, registerRoutes } from "./http/app.ts";
import { startJobs } from "./jobs.ts";
import { Hub } from "./realtime/hub.ts";
import { RunnerGateway } from "./runners/gateway.ts";
import { SandboxService } from "./sandboxes/service.ts";
import { TaskService } from "./tasks/service.ts";
import { ConnectorRuntime } from "./workflows/connectors/runtime.ts";
import { Engine } from "./workflows/engine.ts";
import { EventBus } from "./workflows/events.ts";
import { registerCoreNodes } from "./workflows/nodes/index.ts";
import { NodeRegistry } from "./workflows/registry.ts";
import { WorkflowService } from "./workflows/service.ts";
import { emitTaskSettled } from "./workflows/sling-events.ts";
import { startScheduleWorker } from "./workflows/triggers.ts";

export interface StartOptions {
  /** Replaces the configured model. Tests use a scripted mock. */
  model?: LanguageModel;
  /** Skip the sweep and prune schedules (tests call them directly). */
  jobs?: boolean;
  /** Connectors to register. */
  connectors?: AnyConnector[];
  /** Extra node types to register. Tests use them. */
  nodes?: AnyNodeSpec[];
  /** Where bundled workflow templates live. Defaults to the repo's `workflows/`. */
  templatesDir?: string;
  /** How many runs one process executes at once. */
  runConcurrency?: number;
  /** Replaces the process runtime for extension code. Tests use an in-process one. */
  extensionRuntime?: ExtensionRuntime;
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

  const registry = new NodeRegistry();
  registerCoreNodes(registry);
  for (const spec of opts.nodes ?? []) registry.register(spec);
  for (const c of opts.connectors ?? []) registry.registerConnector(c);

  const ctx: AppContext = {
    config,
    db: database.db,
    auth: createAuth(database.db, config, {
      // The first sign-up creates the workspace; it gets the built-in workflows right away.
      onWorkspaceCreated: async (workspaceId) => {
        try {
          await ctx.workflows.ensureBuiltIns(workspaceId);
        } catch (err) {
          app.log.error({ err, workspaceId }, "couldn't install built-in workflows");
        }
      },
    }),
    log: app.log,
    secretsKey: deriveKey(config.secretKey, "credentials-v1"),
    hub: new Hub(),
    registry,
    boss: null,
    modelOverride: opts.model,
    // Filled in right below; each service needs the finished context.
    runners: undefined as unknown as RunnerGateway,
    tasks: undefined as unknown as TaskService,
    sandboxes: undefined as unknown as SandboxService,
    agent: undefined as unknown as Agent,
    cliChat: undefined as unknown as CliChat,
    commands: undefined as unknown as Commands,
    engine: undefined as unknown as Engine,
    events: undefined as unknown as EventBus,
    workflows: undefined as unknown as WorkflowService,
    connectors: undefined as unknown as ConnectorRuntime,
    extensions: undefined as unknown as ExtensionService,
  };
  ctx.runners = new RunnerGateway(ctx);
  ctx.tasks = new TaskService(ctx);
  ctx.sandboxes = new SandboxService(ctx);
  ctx.agent = new Agent(ctx, opts.model);
  ctx.cliChat = new CliChat(ctx);
  ctx.commands = new Commands(ctx);
  ctx.engine = new Engine(ctx);
  ctx.events = new EventBus(ctx);
  ctx.workflows = new WorkflowService(ctx, opts.templatesDir);
  ctx.connectors = new ConnectorRuntime(ctx);
  ctx.extensions = new ExtensionService(
    ctx,
    opts.extensionRuntime ??
      new ProcessRuntime({ log: app.log.child({ component: "extensions" }) }),
  );
  ctx.runners.handlers = ctx.tasks;
  ctx.tasks.onSettled = async (taskId, reason) => {
    // First, so a failing hook below can't keep a sandbox alive.
    await ctx.sandboxes.onTaskSettled(taskId);
    await ctx.agent.onTaskSettled(taskId, reason);
    await emitTaskSettled(ctx, taskId, reason);
  };
  ctx.tasks.onWorkflowApproval = (approval) => ctx.engine.onApprovalSettled(approval);
  ctx.runners.start();

  let boss: PgBoss | null = null;
  try {
    boss = await startJobs(ctx, config.databaseUrl, { schedules: opts.jobs !== false });
    ctx.boss = boss;
    await startScheduleWorker(ctx, boss);
    // Before built-in workflows and the engine, so extension node types are registered.
    await ctx.extensions.start();
    await ctx.workflows.ensureBuiltIns();
    await ctx.engine.start(boss, { concurrency: opts.runConcurrency ?? 10 });

    await registerRoutes(app, ctx);
    await app.listen({ host: config.host, port: config.port });
    await ctx.connectors.reconcile();
  } catch (err) {
    await ctx.extensions.stop();
    ctx.runners.stop();
    await boss?.stop({ graceful: false });
    await app.close();
    await database.close();
    throw err;
  }
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    app,
    ctx,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await ctx.connectors.stopAll();
      await ctx.engine.stop();
      await ctx.extensions.stop();
      await Promise.race([ctx.sandboxes.idle(), new Promise((ok) => setTimeout(ok, 10_000))]);
      ctx.runners.stop();
      await boss?.stop({ graceful: true, timeout: 10_000 });
      await app.close();
      await database.close();
    },
  };
}
