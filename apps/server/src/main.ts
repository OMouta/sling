import { connector as discord } from "@sling/integration-discord";
import { connector as email } from "@sling/integration-email";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

const server = await startServer(loadConfig(), { connectors: [discord, email] });

const shutdown = async (signal: string) => {
  server.app.log.info({ signal }, "shutting down");
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
