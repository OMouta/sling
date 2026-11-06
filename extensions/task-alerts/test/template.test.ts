/**
 * Checks the template against the node specs a server with ntfy installed
 * has: the server's own registry plus the ntfy connector, and the JSON
 * description ntfy's bundle gives Sling.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AnyConnector } from "@sling/connector-sdk";
import { checkFiles, collectFiles, loadProject, TemplateFileSchema } from "@sling/extension-cli";
import extension, { connector as ntfy } from "@sling/extension-ntfy";
import { publishBody, publishConfigSchema } from "@sling/extension-ntfy/publish";
import {
  evaluateConfig,
  parseDefinition,
  type SpecLookup,
  validate,
  type WorkflowDefinition,
} from "@sling/workflow";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIR = fileURLToPath(new URL("../templates/notify-task-finished/", import.meta.url));

/**
 * The server's own modules, loaded at run time so this package's typecheck
 * doesn't take in the whole server, which needs its own tsconfig.
 */
const SERVER = "@sling/server/src/workflows/";
interface Registry extends SpecLookup {
  registerConnector(def: AnyConnector): void;
}
const { NodeRegistry } = (await import(`${SERVER}registry.ts`)) as {
  NodeRegistry: new () => Registry;
};
const { registerCoreNodes } = (await import(`${SERVER}nodes/index.ts`)) as {
  registerCoreNodes(registry: Registry): void;
};
const { applyBindings } = (await import(`${SERVER}templates.ts`)) as {
  applyBindings(def: WorkflowDefinition, map: Record<string, string>): WorkflowDefinition;
};

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(`${DIR}${path}`, "utf8"));
}

function registry(): Registry {
  const r = new NodeRegistry();
  registerCoreNodes(r);
  r.registerConnector(ntfy);
  return r;
}

async function definition() {
  const parsed = parseDefinition(await json("workflow.json"));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.definition;
}

const task = (over: Record<string, unknown> = {}) => ({
  id: "task_1",
  title: "Fix the footer",
  state: "succeeded",
  runnerName: "laptop",
  repoName: "site",
  branch: "sling/fix-footer",
  summary: "Moved the footer links into a grid.",
  error: null,
  settleReason: "finished",
  prUrl: "https://github.com/acme/site/pull/12",
  ...over,
});

/** What the publish node sends ntfy for a task. */
async function sent(t: Record<string, unknown>) {
  const def = await definition();
  const node = def.nodes.find((n) => n.id === "notify");
  const { config } = await evaluateConfig(
    node?.config ?? {},
    ["topic", "message", "title", "priority", "tags", "click"],
    { inputs: {}, trigger: { task: t, reason: "finished" }, vars: {}, execution: {} },
  );
  return publishBody("alerts", String(config.message), publishConfigSchema.parse(config));
}

describe("Notify when a task finishes", () => {
  it("validates against the server's nodes and the ntfy connector", async () => {
    const def = await definition();
    expect(validate(def, registry())).toEqual([]);
    expect(validate(applyBindings(def, { $ntfy: "ins_123" }), registry())).toEqual([]);
  });

  it("uses only nodes that are in the ntfy description or built into Sling", async () => {
    const described = new Set(
      extension.describe().connectors.flatMap((c) => c.nodes.map((n) => `${n.type}@${n.version}`)),
    );
    const core = registry();
    for (const n of (await definition()).nodes) {
      const key = `${n.type}@${n.version}`;
      expect(
        described.has(key) || (core.get(n.type, n.version) && !n.type.startsWith("ntfy.")),
      ).toBe(true);
    }
  });

  it("binds $ntfy to an ntfy installation", async () => {
    const meta = TemplateFileSchema.parse(await json("template.json"));
    expect(meta.bindings).toEqual([
      { placeholder: "$ntfy", connectorId: "ntfy", label: "ntfy server" },
    ]);
    expect((await definition()).nodes.find((n) => n.id === "notify")?.config.installationId).toBe(
      "$ntfy",
    );
  });

  it("builds the notification from the task's outputs", async () => {
    expect(await sent(task())).toEqual({
      topic: "alerts",
      title: "Done: Fix the footer",
      message: "Moved the footer links into a grid.\n\nsite on laptop",
      priority: 3,
      tags: ["white_check_mark"],
      click: "https://github.com/acme/site/pull/12",
    });
    expect(
      await sent(task({ state: "failed", error: "Tests failed", summary: null, prUrl: null })),
    ).toEqual({
      topic: "alerts",
      title: "Failed: Fix the footer",
      message: "Tests failed\n\nsite on laptop",
      priority: 4,
      tags: ["x"],
    });
    expect(
      await sent(task({ state: "interrupted", summary: null, repoName: null, prUrl: null })),
    ).toMatchObject({
      title: "Stopped: Fix the footer",
      message: "No summary.",
      tags: ["warning"],
    });
  });

  it("passes sling-ext check with no warnings", async () => {
    const { files, missing } = await collectFiles(await loadProject(ROOT));
    expect(missing).toEqual([]);
    const report = await checkFiles(files);
    expect(report.problems).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.kinds).toEqual(["workflows"]);
  });
});
