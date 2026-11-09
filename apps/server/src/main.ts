import { connector as calendar } from "@sling/integration-calendar";
import { connector as discord } from "@sling/integration-discord";
import { connector as docker } from "@sling/integration-docker";
import { connector as email } from "@sling/integration-email";
import { connector as railway } from "@sling/integration-railway";
import { connector as telegram } from "@sling/integration-telegram";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

const server = await startServer(loadConfig(), {
  connectors: [discord, telegram, email, calendar, docker, railway],
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  server.app.log.info({ signal }, "shutting down");
  try {
    await server.close();
    process.exitCode = 0;
  } catch (err) {
    server.app.log.error({ err }, "shutdown failed");
    process.exitCode = 1;
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
