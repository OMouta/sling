/**
 * A control plane in its own process, so the engine tests can SIGKILL it
 * mid-node. Prints `READY <url>` once it's listening.
 */
import { startServer } from "../../src/server.ts";
import { testNodes } from "./nodes.ts";

const server = await startServer(
  {
    databaseUrl: process.env.DATABASE_URL ?? "",
    publicUrl: new URL(process.env.SLING_PUBLIC_URL ?? "http://127.0.0.1"),
    secretKey: process.env.SLING_SECRET_KEY ?? "",
    host: "127.0.0.1",
    port: 0,
    logLevel: "warn",
    webDist: undefined,
  },
  { nodes: testNodes, jobs: false },
);
process.stdout.write(`READY ${server.url}\n`);
