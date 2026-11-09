import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { agentToolRoutes } from "../agent/tool-routes.ts";
import { checkRoutes } from "../checks/routes.ts";
import type { Config } from "../config.ts";
import type { AppContext } from "../context.ts";
import { replaceRoutes } from "../conversations/replace-routes.ts";
import { conversationRoutes } from "../conversations/routes.ts";
import { deployRoutes } from "../deploys/routes.ts";
import { extensionRoutes } from "../extensions/routes.ts";
import { feedbackRoutes } from "../feedback/routes.ts";
import { memoryRoutes } from "../memory/routes.ts";
import { bearerMatches, databaseStats } from "../metrics.ts";
import { oauthRoutes } from "../oauth/routes.ts";
import { personalityRoutes } from "../personalities/routes.ts";
import { personalityTransferRoutes } from "../personalities/transfer.ts";
import { pushRoutes } from "../push/routes.ts";
import { hubRoutes } from "../realtime/hub.ts";
import { authRoutes } from "../routes/auth.ts";
import { settingsRoutes } from "../routes/settings.ts";
import { setupRoutes } from "../routes/setup.ts";
import { ruleRoutes } from "../rules/routes.ts";
import { installRoutes } from "../runners/install.ts";
import { runnerRoutes } from "../runners/routes.ts";
import { sandboxRoutes } from "../sandboxes/routes.ts";
import { sourceRoutes } from "../sources/routes.ts";
import { taskRoutes } from "../tasks/routes.ts";
import { connectorRoutes } from "../workflows/connectors/routes.ts";
import { webhookRoutes, workflowRoutes } from "../workflows/routes.ts";
import { requestLog } from "./logging.ts";

export function createServer(config: Config): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: { req: requestLog },
      redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
    },
    trustProxy: config.trustedProxies ?? false,
    bodyLimit: 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

export type Routes = ReturnType<FastifyInstance["withTypeProvider"]>;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function registerRoutes(app: FastifyInstance, ctx: AppContext) {
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  // Cookie-authenticated requests that change state must come from our own origin.
  app.addHook("onRequest", async (request, reply) => {
    if (SAFE_METHODS.has(request.method) || !request.url.startsWith("/api/")) return;
    if (!request.headers.cookie) return;
    const origin = request.headers.origin;
    if (origin && origin !== ctx.config.publicUrl.origin) {
      return reply.code(403).send({ error: "bad origin" });
    }
  });

  app.get("/healthz", { logLevel: "silent" }, async () => ({ ok: true }));
  // Off unless the operator sets a token, and then only for requests that carry it.
  app.get("/metrics", { logLevel: "silent" }, async (request, reply) => {
    const token = ctx.config.metricsToken;
    if (!token) return reply.code(404).send({ error: "not found" });
    if (!bearerMatches(request.headers.authorization, token)) {
      return reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthorized" });
    }
    const body = await ctx.metrics.render({
      runnersConnected: () => ctx.runners.connectedCount,
      database: () => databaseStats(ctx.db),
      onDatabaseError: (err) => ctx.log.warn({ err }, "metrics couldn't read the database"),
    });
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(body);
  });

  await app.register(async (scope) => authRoutes(scope, ctx));
  await app.register(async (scope) => installRoutes(scope, ctx));
  await app.register(async (scope) => agentToolRoutes(scope, ctx));
  await app.register(async (scope) => hubRoutes(scope, ctx));
  await app.register(async (scope) => {
    ctx.runners.register(scope);
    await runnerRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    const r = scope.withTypeProvider<ZodTypeProvider>();
    await setupRoutes(r, ctx);
  });
  await app.register(async (scope) => {
    await settingsRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await pushRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await taskRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await sandboxRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await deployRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await checkRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await ruleRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await memoryRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await conversationRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await replaceRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await feedbackRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await personalityRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await personalityTransferRoutes(scope, ctx);
  });
  // Its own scope too: its raw body parser is for its uploads only.
  await app.register(async (scope) => {
    await sourceRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await workflowRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await connectorRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await oauthRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await extensionRoutes(scope, ctx);
  });
  await app.register(async (scope) => {
    await webhookRoutes(scope, ctx);
  });

  serveWebApp(app, ctx.config);
}

function serveWebApp(app: FastifyInstance, config: Config) {
  const dist = config.webDist;
  if (!dist || !existsSync(join(dist, "index.html"))) {
    app.log.info("no built web app found, serving the API only");
    return;
  }
  app.register(fastifyStatic, { root: dist, wildcard: false, index: false });
  const sendIndex = (_req: unknown, reply: { sendFile: (f: string) => unknown }) =>
    reply.sendFile("index.html");
  app.get("/", sendIndex);
  app.get("/*", (request, reply) => {
    const path = request.url.split("?")[0] ?? "/";
    if (path.startsWith("/api/") || path.startsWith("/runner/") || path.startsWith("/hooks/")) {
      return reply.code(404).send({ error: "not found" });
    }
    const file = path.slice(1);
    if (file && existsSync(join(dist, file))) return reply.sendFile(file);
    return reply.sendFile("index.html");
  });
}
