import { readPackage } from "@sling/extension-package";
import type { WorkflowDefinition } from "@sling/workflow";
import { describe, expect, it } from "vitest";
import { buildWorkflowPackage, type ExportInput, slugify } from "./export.ts";

const dec = new TextDecoder();

function node(id: string, type: string, config: Record<string, unknown> = {}) {
  return { id, type, version: 1, position: { x: 0, y: 0 }, config };
}

const definition: WorkflowDefinition = {
  schema: "sling.workflow/v1",
  name: "Ops alerts",
  description: "Pings the team.",
  nodes: [
    node("trig", "discord.message_received", { installationId: "ins_d1", scope: "dm" }),
    node("a", "ntfy.publish", { installationId: "ins_n1", topic: "ops" }),
    node("b", "discord.send_message", { installationId: "ins_d2", content: "hi" }),
    // The same installation again, and one in a field that isn't an installation field.
    node("c", "discord.send_message", { installationId: "ins_d1", extra: { copyTo: "ins_n1" } }),
    node("d", "core.transform", { expression: "ins_unknown" }),
  ],
  edges: [],
};

const specs: Record<string, { connector?: string; installationFields?: string[] }> = {
  "discord.message_received": { connector: "discord", installationFields: ["installationId"] },
  "discord.send_message": { connector: "discord", installationFields: ["installationId"] },
  "ntfy.publish": { connector: "ntfy", installationFields: ["installationId"] },
  "core.transform": {},
};

function input(over: Partial<ExportInput> = {}): ExportInput {
  return {
    definition,
    id: "ops-alerts",
    version: "1.2.0",
    name: "Ops alerts",
    publisher: "Ana",
    installations: new Map([
      ["ins_d1", { connectorId: "discord" }],
      ["ins_d2", { connectorId: "discord" }],
      ["ins_n1", { connectorId: "ntfy" }],
    ]),
    spec: (type) => specs[type] ?? null,
    connectorName: (id) => ({ discord: "Discord", ntfy: "ntfy" })[id] ?? id,
    extensionOf: (id) => (id === "ntfy" ? { id: "ntfy", version: "1.0.3" } : null),
    ...over,
  };
}

describe("buildWorkflowPackage", () => {
  const out = buildWorkflowPackage(input());
  const pkg = readPackage(out.bytes);
  const workflow = JSON.parse(dec.decode(pkg.files.get("templates/ops-alerts/workflow.json")));

  it("binds every installation ID, numbered per connector in node order", () => {
    expect(out.bindings).toEqual([
      { placeholder: "$discord", connectorId: "discord", label: "Discord" },
      { placeholder: "$ntfy", connectorId: "ntfy", label: "ntfy" },
      { placeholder: "$discord_2", connectorId: "discord", label: "Discord 2" },
    ]);
    expect(workflow.nodes.map((n: { config: unknown }) => n.config)).toEqual([
      { installationId: "$discord", scope: "dm" },
      { installationId: "$ntfy", topic: "ops" },
      { installationId: "$discord_2", content: "hi" },
      { installationId: "$discord", extra: { copyTo: "$ntfy" } },
      { expression: "ins_unknown" },
    ]);
    const all = [...pkg.files.values()].map((f) => dec.decode(f)).join("\n");
    for (const id of ["ins_d1", "ins_d2", "ins_n1"]) expect(all).not.toContain(id);
  });

  it("writes a workflow package manifest with what it needs", () => {
    expect(pkg.manifest).toMatchObject({
      id: "ops-alerts",
      version: "1.2.0",
      name: "Ops alerts",
      description: "Pings the team.",
      publisher: "Ana",
      sdk: "^1.0.0",
      templates: ["ops-alerts"],
      requires: { extensions: { ntfy: "^1.0.3" }, connectors: ["discord"] },
      permissions: { network: { hosts: [] }, approvals: false, sandboxes: false },
    });
    expect(pkg.manifest.main).toBeUndefined();
    expect(pkg.signature).toBeNull();
    const template = JSON.parse(dec.decode(pkg.files.get("templates/ops-alerts/template.json")));
    expect(template).toEqual({
      name: "Ops alerts",
      description: "Pings the team.",
      bindings: out.bindings,
    });
    const readme = dec.decode(pkg.files.get("README.md"));
    expect(readme).toContain("# Ops alerts");
    expect(readme).toContain("- Discord 2 (`discord`)");
    expect(readme).toContain("- the ntfy extension, ^1.0.3");
  });

  it("is the same bytes every time", () => {
    expect(buildWorkflowPackage(input()).bytes).toEqual(out.bytes);
  });

  it("refuses a manifest it can't build", () => {
    expect(() => buildWorkflowPackage(input({ id: "X" }))).toThrow(/^The package can't be built/);
  });
});

describe("slugify", () => {
  it("makes a template key from a name", () => {
    expect(slugify("Daily Digest!", "workflow")).toBe("daily-digest");
    expect(slugify("  --  ", "workflow")).toBe("workflow");
    expect(slugify("a".repeat(60), "workflow")).toHaveLength(40);
  });
});
