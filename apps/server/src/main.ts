import { createDatabase, runMigrations } from "@sling/db";
import { createAuth } from "./auth/auth.ts";
import { loadConfig } from "./config.ts";
import type { AppContext } from "./context.ts";
import { deriveKey } from "./crypto.ts";
import { createServer, registerRoutes } from "./http/app.ts";
import { Hub } from "./realtime/hub.ts";

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
};

await registerRoutes(app, ctx);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
