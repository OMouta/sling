import type { AnyConnector } from "@sling/connector-sdk";
import { createDatabase, type Database, runMigrations } from "@sling/db";
import type { AnyNodeSpec } from "@sling/workflow";
import type { LanguageModel } from "ai";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { Agent } from "./agent/agent.ts";
import { CliChat } from "./agent/cli-chat.ts";
import { Commands } from "./agent/commands.ts";
import { createAuth } from "./auth/auth.ts";
import { channelConnectors } from "./channels/connectors.ts";
import { Channels } from "./channels/service.ts";
import { Checks } from "./checks/service.ts";
import type { Config } from "./config.ts";
import type { AppContext } from "./context.ts";
import { deriveKey } from "./crypto.ts";
import { enqueueSettlement, startDeliveries } from "./deliveries.ts";
import { DeployService } from "./deploys/service.ts";
import { ProcessRuntime } from "./extensions/process-runtime.ts";
import type { ExtensionRuntime } from "./extensions/runtime.ts";
import { ExtensionService } from "./extensions/service.ts";
import { Files } from "./files/service.ts";
import { createServer, registerRoutes } from "./http/app.ts";
import { startJobs } from "./jobs.ts";
import { DEFAULT_SHUTDOWN_MS, deadline, onceAsync, within } from "./lifecycle.ts";
import { Memories } from "./memory/service.ts";
import { Metrics } from "./metrics.ts";
import { OAuth } from "./oauth/service.ts";
import { ensurePersonalities } from "./personalities/service.ts";
import { PushService } from "./push/service.ts";
import { Hub } from "./realtime/hub.ts";
import { Rules } from "./rules/service.ts";
import { RunnerGateway } from "./runners/gateway.ts";
import { SandboxService } from "./sandboxes/service.ts";
import { Sources } from "./sources/service.ts";
import { TaskService } from "./tasks/service.ts";
import { ConnectorRuntime } from "./workflows/connectors/runtime.ts";
import { Engine } from "./workflows/engine.ts";
import { EventBus } from "./workflows/events.ts";
import { registerCoreNodes } from "./workflows/nodes/index.ts";
import { NodeRegistry } from "./workflows/registry.ts";
import { WorkflowService } from "./workflows/service.ts";
import { startScheduleWorker } from "./workflows/triggers.ts";

export interface StartOptions {
  /** Replaces the configured model. Tests use a scripted mock. */
  model?: LanguageModel;
  /** Skip the sweep and prune schedules (tests call them directly). */
  jobs?: boolean;
  /** Tests can pause durable deliveries to simulate a crash before dispatch. */
  deliveries?: boolean;
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
  /** Aborting it stops a startup in progress; whatever already started is shut down. */
  signal?: AbortSignal;
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
  // An idle connection the database closes (a restart, or a shutdown while the pool is still
  // ending) is an "error" event on the pool, and with no listener it would crash the process.
  // The pool has already dropped that connection, and the next query opens a new one.
  database.pool.on("error", (err) => app.log.warn({ err }, "database connection dropped"));
  const metrics = new Metrics();
  metrics.observe(app);

  // What startup has brought up so far. Shutdown stops only these, so the same sequence
  // cleans up after a start that failed partway.
  let ctx: AppContext | undefined;
  let boss: PgBoss | null = null;
  let extensionsStarted = false;
  let releaseOwner: (() => void) | undefined;
  let stopDeliveries: (() => Promise<void>) | undefined;
  let draining = false;
  let ready = false;
  app.addHook("onRequest", async (request, reply) => {
    if (draining && request.url !== "/healthz")
      return reply.code(503).send({ error: "Server is shutting down" });
  });
  app.get("/readyz", { logLevel: "silent" }, async (_request, reply) => {
    if (!ready || draining) return reply.code(503).send({ ok: false });
    try {
      await within(database.pool.query("select 1"), 1500);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  const shutdownMs = config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_MS;
  const close = onceAsync(async () => {
    draining = true;
    ready = false;
    // Every step shares one deadline. Part of it is held back for closing connections, so a
    // drain step that hangs can't leave the database pool and the advisory lock open.
    const overall = deadline(shutdownMs);
    const closing = Math.min(5_000, shutdownMs / 4);
    const drain = deadline(shutdownMs - closing);
    const errors: unknown[] = [];
    const step = async (
      name: string,
      work: () => unknown,
      capMs: number,
      until: { left(): number } = drain,
    ) => {
      try {
        await within(Promise.resolve().then(work), Math.min(capMs, until.left()));
      } catch (err) {
        errors.push(err);
        app.log.error({ err, step: name }, "shutdown step failed");
      }
    };
    const s = ctx;
    if (s) {
      // Stop new connector events and engine claims before waiting on jobs.
      await step("intake", () => Promise.all([s.connectors.stopAll(), s.engine.stop()]), 10_000);
      await step("deliveries", () => stopDeliveries?.(), 10_000);
      await step(
        "jobs",
        () => boss?.stop({ graceful: true, timeout: Math.min(10_000, drain.left()) }),
        Number.POSITIVE_INFINITY,
      );
      await step(
        "in-flight work",
        () =>
          Promise.all([
            s.sandboxes.idle(),
            s.push.idle(),
            s.deploys.idle(),
            s.checks.idle(),
            s.sources.idle?.(),
          ]),
        35_000,
      );
      if (extensionsStarted) await step("extensions", () => s.extensions.stop(), 10_000);
      s.runners.stop();
    }
    await step("http", () => app.close(), Number.POSITIVE_INFINITY, overall);
    if (s)
      await step("runner disconnects", () => s.runners.idle(), Number.POSITIVE_INFINITY, overall);
    releaseOwner?.();
    await step("database", () => database.close(), Number.POSITIVE_INFINITY, overall);
    metrics.stop();
    if (errors.length) throw new AggregateError(errors, "Server shutdown failed");
  });

  try {
    const owner = await database.pool.connect();
    releaseOwner = () => owner.release(true);
    const lock = await owner.query("select pg_try_advisory_lock(1936484718, 1) as acquired");
    if (!lock.rows[0]?.acquired)
      throw new Error("Another Sling control plane is already using this database");
    owner.on("error", (err) => {
      draining = true;
      ready = false;
      app.log.fatal({ err }, "control-plane ownership lost");
      void close().catch((error) => app.log.error({ err: error }, "ownership shutdown failed"));
    });
    opts.signal?.throwIfAborted();
    await runMigrations(database.db);
    app.log.info("database migrated");
    opts.signal?.throwIfAborted();

    const c = createContext(app, database, config, metrics, opts);
    ctx = c;
    // Approvals that waited in turns a restart ended can't happen anymore.
    const interrupted = await c.commands.expireInterrupted();
    if (interrupted > 0) {
      app.log.info({ count: interrupted }, "ended chat approvals a restart cut off");
    }
    c.runners.start();
    boss = await startJobs(c, config.databaseUrl, { schedules: opts.jobs !== false });
    c.boss = boss;
    await startScheduleWorker(c, boss);
    // Before built-in workflows and the engine, so extension node types are registered.
    extensionsStarted = true;
    await c.extensions.start();
    await ensurePersonalities(c);
    await c.workflows.ensureBuiltIns();
    opts.signal?.throwIfAborted();
    const paused = config.automationPaused === true;
    if (paused) {
      app.log.warn(
        "automation is paused: workflow runs, deliveries, connector sources, schedules, checks, webhooks, and push are held until a start without SLING_AUTOMATION_PAUSED",
      );
    }
    await c.engine.start(boss, { concurrency: opts.runConcurrency ?? 10, paused });
    await c.deploys.start(boss);
    await c.checks.start(boss, { schedules: opts.jobs !== false && !paused });
    await c.sources.start(boss);

    await registerRoutes(app, c);
    opts.signal?.throwIfAborted();
    await app.listen({ host: config.host, port: config.port });
    await c.connectors.reconcile();
    if (opts.deliveries !== false && !paused) stopDeliveries = startDeliveries(c);
    opts.signal?.throwIfAborted();
    ready = true;
  } catch (err) {
    // Each failed cleanup step is logged by itself; the startup error is what the caller needs.
    await close().catch(() => {});
    throw err;
  }
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  return { app, ctx, url: `http://127.0.0.1:${port}`, close };
}

/** The services the routes and workers share. Nothing here starts work yet. */
function createContext(
  app: FastifyInstance,
  database: Database,
  config: Config,
  metrics: Metrics,
  opts: StartOptions,
): AppContext {
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
          await ensurePersonalities(ctx, workspaceId);
          await ctx.workflows.ensureBuiltIns(workspaceId);
        } catch (err) {
          app.log.error({ err, workspaceId }, "couldn't install built-in workflows");
        }
      },
    }),
    log: app.log,
    secretsKey: deriveKey(config.secretKey, "credentials-v1"),
    hub: new Hub((err) => app.log.warn({ err }, "realtime listener failed")),
    metrics,
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
    deploys: undefined as unknown as DeployService,
    push: undefined as unknown as PushService,
    memory: undefined as unknown as Memories,
    files: undefined as unknown as Files,
    rules: undefined as unknown as Rules,
    checks: undefined as unknown as Checks,
    channels: undefined as unknown as Channels,
    oauth: undefined as unknown as OAuth,
    sources: undefined as unknown as Sources,
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
  ctx.deploys = new DeployService(ctx);
  ctx.push = new PushService(ctx);
  ctx.memory = new Memories(ctx);
  ctx.files = new Files(ctx);
  ctx.rules = new Rules(ctx);
  ctx.checks = new Checks(ctx);
  ctx.channels = new Channels(ctx);
  for (const c of channelConnectors(ctx)) registry.registerConnector(c);
  ctx.oauth = new OAuth(ctx);
  ctx.sources = new Sources(ctx);
  ctx.runners.handlers = ctx.tasks;
  ctx.tasks.onSettled = (taskId, reason) => enqueueSettlement(ctx, taskId, reason);
  ctx.tasks.onWorkflowApproval = (approval) => ctx.engine.onApprovalSettled(approval);
  return ctx;
}
