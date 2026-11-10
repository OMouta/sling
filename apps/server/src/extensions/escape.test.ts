/**
 * An extension that tries every way out of its process. Each attempt must be
 * refused, show in the extension's log, and leave the server running.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnyConnector } from "@sling/connector-sdk";
import { NodeError } from "@sling/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alive,
  fakeNodeContext,
  fixtureExtension,
  SDK,
  type TestRuntime,
  testRuntime,
} from "../../test/fixtures/extension-processes.ts";

const SERVER_SOURCE = fileURLToPath(new URL("./host.ts", import.meta.url));
const TEMP_FILE = `/tmp/sling-escape-${process.pid}-${Date.now()}`;

const source = `${SDK}
import fs from "node:fs";
import fsp from "node:fs/promises";
import cp from "node:child_process";
import { Worker } from "node:worker_threads";
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import http from "node:http";
import os, { setPriority } from "node:os";

const attempts = {
  readHosts: () => fs.readFileSync("/etc/hosts", "utf8"),
  readServer: (c) => fsp.readFile(c.path, "utf8"),
  readOwn: () => fs.readFileSync(new URL("./sling-extension.json", import.meta.url), "utf8").length,
  writeTemp: (c) => fs.writeFileSync(c.path, "escaped"),
  spawn: () => cp.execFileSync("/bin/echo", ["escaped"]).toString(),
  worker: () => new Worker("process.exit(0)", { eval: true }),
  env: () => ({ ...process.env }),
  socket: () =>
    new Promise((resolve, reject) => {
      const s = net.connect(80, "1.1.1.1");
      s.on("connect", () => resolve("connected"));
      s.on("error", reject);
    }),
  listen: () =>
    new Promise((resolve, reject) => {
      const s = net.createServer();
      s.on("error", reject);
      s.listen(0, () => resolve("listening"));
    }),
  udp: () =>
    new Promise((resolve, reject) => {
      const s = dgram.createSocket("udp4");
      s.on("error", reject);
      s.bind(0, () => resolve("bound"));
    }),
  dns: () => dns.lookup("example.com"),
  http: () =>
    new Promise((resolve, reject) => {
      const req = http.get("http://1.1.1.1/", (res) => resolve(res.statusCode));
      req.on("error", reject);
    }),
  binding: () => process.binding("fs"),
  // Signal 0 only checks that the server is there, so a miss sends nothing.
  kill: () => process.kill(process.ppid, 0),
  rawKill: () => process._kill(process.ppid, 0),
  // Past any real pid, so a miss doesn't turn on a debugger anywhere.
  debugProcess: () => process._debugProcess(99999999),
  report: () => process.report.getReport(),
  priority: () => os.setPriority(process.ppid, os.getPriority(process.ppid)),
  namedPriority: () => setPriority(process.ppid, os.getPriority(process.ppid)),
  eval: () => eval("1 + 1"),
  newFunction: () => new Function("return 1")(),
};

const escape = defineNode({
  type: "escape.try",
  version: 1,
  title: "Try",
  description: "Tries one way out.",
  category: "action",
  configSchema: z.object({ attempt: z.string(), path: z.string().default("") }),
  inputs: [],
  outputs: [],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: false,
  async run(_ctx, { config }) {
    const result = await attempts[config.attempt](config);
    return { exec: "next", outputs: { result: typeof result === "object" ? result : String(result) } };
  },
});

export default defineExtension({
  connectors: [
    defineConnector({
      id: "escape",
      name: "Escape",
      description: "Tries to get out.",
      credentialsSchema: z.object({}),
      secretFields: [],
      configSchema: z.object({}),
      async test() {
        return { ok: true };
      },
      nodes: [escape],
    }),
  ],
});
`;

let t: TestRuntime;
let connector: AnyConnector;

beforeAll(async () => {
  t = testRuntime();
  const ext = await fixtureExtension(t.runtime, { id: "escape", source });
  [connector] = t.runtime.activate(ext) as [AnyConnector];
}, 30_000);

afterAll(async () => {
  await t.runtime.stopAll();
});

async function attempt(name: string, path = "") {
  const node = connector.nodes[0];
  const { ctx } = fakeNodeContext();
  return node?.run?.(ctx, { inputs: {}, config: { attempt: name, path } });
}

describe("an extension trying to get out of its process", () => {
  it.each([
    ["readHosts", "", /Sling refused FileSystemRead access to \/etc\/hosts/],
    ["readServer", SERVER_SOURCE, /Sling refused FileSystemRead access to .*host\.ts/],
    ["writeTemp", TEMP_FILE, /Sling refused FileSystemWrite access/],
    ["spawn", "", /Sling refused ChildProcess access/],
    ["worker", "", /Sling refused WorkerThreads access/],
    ["socket", "", /Sling refused Net access/],
    ["listen", "", /Sling refused Net access/],
    ["udp", "", /Sling refused Net access/],
    ["dns", "", /Sling refused Net access to example\.com/],
    ["http", "", /Sling refused Net access/],
    ["binding", "", /Sling refused access: process\.binding/],
    ["kill", "", /Sling refused access: process\.kill/],
    ["rawKill", "", /Sling refused access: process\._kill/],
    ["debugProcess", "", /Sling refused access: process\._debugProcess/],
    ["report", "", /Sling refused access: process\.report/],
    ["priority", "", /Sling refused access: os\.setPriority/],
    ["namedPriority", "", /Sling refused access: os\.setPriority/],
    ["eval", "", /Sling refused code generation from strings/],
    ["newFunction", "", /Sling refused code generation from strings/],
  ])("refuses %s and logs it", async (name, path, logged) => {
    const pid = t.runtime.host("escape")?.process?.pid;
    const before = t.runtime.log("escape").length;
    const err = await attempt(name, path).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, `${name} should have been refused`).toBeInstanceOf(Error);
    const lines = t.runtime.log("escape").slice(before);
    expect(lines.map((l) => l.message).join("\n")).toMatch(logged);
    // The refusal didn't take the process down, let alone the server.
    if (pid) expect(t.runtime.host("escape")?.process?.pid).toBe(pid);
  });

  it("wrote nothing", () => {
    expect(existsSync(TEMP_FILE)).toBe(false);
  });

  it("starts with an empty environment", async () => {
    const out = await attempt("env");
    expect(out).toEqual({ exec: "next", outputs: { result: {} } });
  });

  it("can read its own package", async () => {
    const out = (await attempt("readOwn")) as unknown as { outputs: { result: string } };
    expect(Number(out.outputs.result)).toBeGreaterThan(10);
  });

  it("keeps the same process through every refusal", () => {
    const proc = t.runtime.host("escape")?.process;
    expect(alive(proc?.pid)).toBe(true);
    expect(t.crashes).toEqual([]);
  });

  it("fails the node with the refusal as its error", async () => {
    const err = await attempt("readHosts").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NodeError);
    expect((err as Error & { code?: string }).code).toBe("ERR_ACCESS_DENIED");
  });
});
