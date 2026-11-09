import { connector as calendar } from "@sling/integration-calendar";
import { connector as discord } from "@sling/integration-discord";
import { connector as docker } from "@sling/integration-docker";
import { connector as email } from "@sling/integration-email";
import { connector as railway } from "@sling/integration-railway";
import { connector as telegram } from "@sling/integration-telegram";
import { pino } from "pino";
import { loadConfig } from "./config.ts";
import { DEFAULT_SHUTDOWN_MS, FORCED_EXIT_MARGIN_MS, serve } from "./lifecycle.ts";
import { startServer } from "./server.ts";

const config = loadConfig();
const log = pino({ level: config.logLevel });

await serve(
  (signal) =>
    startServer(config, {
      connectors: [discord, telegram, email, calendar, docker, railway],
      signal,
    }),
  {
    on: (signal, listener) => process.on(signal, listener),
    exit: (code) => process.exit(code),
    log,
  },
  (config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_MS) + FORCED_EXIT_MARGIN_MS,
);
