/**
 * Measures what isolation costs: starting a process, a node run through it,
 * a fetch through the broker, and an idle process's memory. Prints the
 * numbers; fails only well past each budget, so a busy machine doesn't
 * fail the suite.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AnyConnector } from "@sling/connector-sdk";
import { type AnyNodeSpec, defineNode } from "@sling/connector-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type FixtureExtension,
  fakeNodeContext,
  fixtureExtension,
  SDK,
  type TestRuntime,
  testRuntime,
} from "../../test/fixtures/extension-processes.ts";
import { DEFAULT_TIMINGS, ExtensionProcess } from "./host.ts";

const SOURCE = `${SDK}
export default defineExtension({
  connectors: [
    defineConnector({
      id: "bench",
      name: "Bench",
      description: "",
      credentialsSchema: z.object({}),
      secretFields: [],
      configSchema: z.object({}),
      async test() { return { ok: true }; },
      nodes: [
        defineNode({
          type: "bench.add",
          version: 1,
          title: "Add",
          description: "",
          category: "data",
          configSchema: z.object({ by: z.number().default(1) }),
          inputs: [],
          outputs: [],
          execInput: true,
          execOutputs: [{ name: "next" }],
          idempotent: true,
          async run(_ctx, { inputs, config }) {
            return { exec: "next", outputs: { sum: (inputs.n ?? 0) + config.by } };
          },
        }),
        defineNode({
          type: "bench.fetch",
          version: 1,
          title: "Fetch",
          description: "",
          category: "data",
          configSchema: z.object({ url: z.string(), times: z.number() }),
          inputs: [],
          outputs: [],
          execInput: true,
          execOutputs: [{ name: "next" }],
          idempotent: true,
          async run(_ctx, { config }) {
            const ms = [];
            for (let i = 0; i < config.times; i++) {
              const t = performance.now();
              const res = await fetch(config.url);
              await res.text();
              ms.push(performance.now() - t);
            }
            return { exec: "next", outputs: { ms } };
          },
        }),
      ],
    }),
  ],
});
`;

/** The same node, in the server's process. */
const inProcess: AnyNodeSpec = defineNode({
  type: "bench.add",
  version: 1,
  title: "Add",
  description: "",
  category: "data",
  configSchema: z.object({ by: z.number().default(1) }),
  inputs: [],
  outputs: [],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: true,
  async run(_ctx, { inputs, config }) {
    const parsed = this.configSchema.parse(config) as { by: number };
    return { exec: "next", outputs: { sum: ((inputs.n as number) ?? 0) + parsed.by } };
  },
});

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

const fmt = (ms: number) => `${ms.toFixed(3)} ms`;

function rssMb(pid: number | undefined): number {
  return (
    Number(
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)])
        .toString()
        .trim(),
    ) / 1024
  );
}

let t: TestRuntime;
let ext: FixtureExtension;
let connectors: AnyConnector[];
let server: Server;
let port: number;
function report(line: string) {
  console.log(`[budget] ${line}`);
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  t = testRuntime({
    network: { resolver: async () => [{ address: "127.0.0.1", family: 4 }] },
  });
  ext = await fixtureExtension(t.runtime, {
    id: "bench",
    source: SOURCE,
    manifest: { permissions: { network: { hosts: ["local.bench.test"], localNetwork: true } } },
  });
  connectors = t.runtime.activate(ext);
}, 30_000);

afterAll(async () => {
  await t.runtime.stopAll();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe("budgets", () => {
  it("starts a process and answers its first call quickly", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const proc = await ExtensionProcess.start({
        extensionId: "bench",
        dir: ext.dir,
        main: "extension.mjs",
        memoryMb: 256,
        timings: DEFAULT_TIMINGS,
        hooks: {
          onRequest: async () => null,
          onNote: () => {},
          onStderr: () => {},
          onExit: () => {},
        },
      });
      await proc.call("describe", {}, 5_000);
      samples.push(performance.now() - started);
      await proc.stop();
    }
    const median = pct(samples, 50);
    report(
      `spawn to first answer: median ${fmt(median)}, max ${fmt(Math.max(...samples))} (budget 150 ms)`,
    );
    expect(median).toBeLessThan(300);
  }, 30_000);

  it("adds little to a node run", async () => {
    const proxied = connectors[0]?.nodes.find((n) => n.type === "bench.add") as AnyNodeSpec;
    const { ctx } = fakeNodeContext();
    const args = { inputs: { n: 1 }, config: { by: 2 } };
    const time = async (spec: AnyNodeSpec, n: number) => {
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const started = performance.now();
        await spec.run?.(ctx, args);
        ms.push(performance.now() - started);
      }
      return ms;
    };
    await time(proxied, 300);
    await time(inProcess, 300);
    const ext95 = pct(await time(proxied, 3_000), 95);
    const ext50 = pct(await time(proxied, 3_000), 50);
    const local95 = pct(await time(inProcess, 3_000), 95);
    report(
      `node run: extension p95 ${fmt(ext95)} (p50 ${fmt(ext50)}), in-process p95 ${fmt(local95)}, overhead p95 ${fmt(ext95 - local95)} (budget 2 ms)`,
    );
    expect(ext95 - local95).toBeLessThan(4);
  }, 60_000);

  it("adds little to a fetch", async () => {
    const node = connectors[0]?.nodes.find((n) => n.type === "bench.fetch") as AnyNodeSpec;
    const { ctx } = fakeNodeContext();
    const url = `http://local.bench.test:${port}/`;
    const direct = async (times: number) => {
      const ms: number[] = [];
      for (let i = 0; i < times; i++) {
        const started = performance.now();
        const res = await fetch(`http://127.0.0.1:${port}/`);
        await res.text();
        ms.push(performance.now() - started);
      }
      return ms;
    };
    const brokered = async (times: number) => {
      const out = (await node.run?.(ctx, { inputs: {}, config: { url, times } })) as unknown as {
        outputs: { ms: number[] };
      };
      return out.outputs.ms;
    };
    await direct(200);
    await brokered(200);
    const b95 = pct(await brokered(2_000), 95);
    const d95 = pct(await direct(2_000), 95);
    report(
      `fetch: brokered p95 ${fmt(b95)}, direct p95 ${fmt(d95)}, overhead p95 ${fmt(b95 - d95)} (budget 3 ms)`,
    );
    expect(b95 - d95).toBeLessThan(6);
  }, 60_000);

  it("keeps an idle process small", async () => {
    // A fresh process after one call, next to a bare Node process on the same machine.
    await t.runtime.deactivate("bench");
    connectors = t.runtime.activate(ext);
    const proxied = connectors[0]?.nodes.find((n) => n.type === "bench.add") as AnyNodeSpec;
    await proxied.run?.(fakeNodeContext().ctx, { inputs: { n: 1 }, config: {} });
    const bare = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: {} });
    await new Promise((r) => setTimeout(r, 800));
    const mb = rssMb(t.runtime.host("bench")?.process?.pid);
    const base = rssMb(bare.pid);
    bare.kill();
    report(
      `idle process RSS: ${mb.toFixed(1)} MB, ${(mb - base).toFixed(1)} MB over bare Node here (${base.toFixed(1)} MB) (budget 60 MB)`,
    );
    expect(mb - base).toBeLessThan(40);
  });
});
