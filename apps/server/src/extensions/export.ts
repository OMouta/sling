/**
 * Turns a workflow into an unsigned workflow package: one template whose
 * installation IDs are replaced by bindings, so nothing in it points at this
 * server. Workflows hold only installation IDs, never credentials, so no
 * credential can end up in the package.
 */
import {
  type ExtensionManifestInput,
  ExtensionManifestSchema,
  SDK_VERSION,
} from "@sling/connector-sdk";
import { readPackage, writePackage } from "@sling/extension-package";
import type { TemplateBinding, WorkflowDefinition } from "@sling/workflow";
import { ExtensionError } from "./errors.ts";

export interface ExportInput {
  definition: WorkflowDefinition;
  id: string;
  version: string;
  name: string;
  publisher: string;
  /** Installations in the workflow's workspace. */
  installations: ReadonlyMap<string, { connectorId: string }>;
  spec(type: string, version: number): { connector?: string; installationFields?: string[] } | null;
  connectorName(connectorId: string): string;
  /** The installed extension that adds a connector. Null for connectors built into Sling. */
  extensionOf(connectorId: string): { id: string; version: string } | null;
}

export interface ExportedPackage {
  bytes: Uint8Array;
  templateKey: string;
  bindings: TemplateBinding[];
  requires: { extensions: Record<string, string>; connectors: string[] };
}

const enc = new TextEncoder();

/** `My Daily Digest!` → `my-daily-digest`. */
export function slugify(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || fallback;
}

/** `$discord` for a connector ID; dots and hyphens become underscores. */
function placeholderBase(connectorId: string): string {
  const base = connectorId.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return /^[a-z]/.test(base) ? base : `c_${base}`;
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

function walkStrings(value: unknown, fn: (s: string) => void): void {
  if (typeof value === "string") fn(value);
  else if (Array.isArray(value)) for (const v of value) walkStrings(v, fn);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) walkStrings(v, fn);
}

function readme(
  name: string,
  description: string,
  bindings: TemplateBinding[],
  requires: ExportedPackage["requires"],
): string {
  const lines = [`# ${name}`, ""];
  if (description) lines.push(description, "");
  lines.push("A workflow package exported from Sling. It adds one workflow template.", "");
  if (bindings.length > 0) {
    lines.push("## Installations", "", "Installing the template asks for:", "");
    for (const b of bindings) lines.push(`- ${b.label} (\`${b.connectorId}\`)`);
    lines.push("");
  }
  const exts = Object.entries(requires.extensions);
  if (exts.length > 0 || requires.connectors.length > 0) {
    lines.push("## Needs", "");
    for (const [id, range] of exts) lines.push(`- the ${id} extension, ${range}`);
    for (const c of requires.connectors) lines.push(`- the ${c} connector`);
    lines.push("");
  }
  lines.push(
    "Installation IDs were replaced by bindings and the package holds no credentials. Check node settings for anything private before you share it.",
    "",
  );
  return lines.join("\n");
}

export function buildWorkflowPackage(input: ExportInput): ExportedPackage {
  const { definition } = input;
  const placeholders = new Map<string, string>();
  const bindings: TemplateBinding[] = [];
  const perConnector = new Map<string, number>();

  const bind = (installationId: string) => {
    if (placeholders.has(installationId)) return;
    const inst = input.installations.get(installationId);
    if (!inst) return;
    const n = (perConnector.get(inst.connectorId) ?? 0) + 1;
    perConnector.set(inst.connectorId, n);
    const base = placeholderBase(inst.connectorId);
    const placeholder = n === 1 ? `$${base}` : `$${base}_${n}`;
    const name = input.connectorName(inst.connectorId);
    placeholders.set(installationId, placeholder);
    bindings.push({
      placeholder,
      connectorId: inst.connectorId,
      label: n === 1 ? name : `${name} ${n}`,
    });
  };

  // Installation fields first, in node order, so numbering follows the graph.
  for (const node of definition.nodes) {
    for (const field of input.spec(node.type, node.version)?.installationFields ?? []) {
      const v = node.config[field];
      if (typeof v === "string") bind(v);
    }
  }
  // Then any other value that is an installation ID.
  for (const node of definition.nodes) walkStrings(node.config, bind);

  const nodes = definition.nodes.map((n) => ({
    ...n,
    config: mapStrings(n.config, (s) => placeholders.get(s) ?? s) as Record<string, unknown>,
  }));

  const extensions: Record<string, string> = {};
  const connectors = new Set<string>();
  const need = (connectorId: string | undefined) => {
    if (!connectorId) return;
    const ext = input.extensionOf(connectorId);
    if (ext) {
      if (ext.id !== input.id) extensions[ext.id] = `^${ext.version}`;
    } else connectors.add(connectorId);
  };
  for (const node of definition.nodes) need(input.spec(node.type, node.version)?.connector);
  for (const b of bindings) need(b.connectorId);
  const requires = {
    extensions: Object.fromEntries(
      Object.entries(extensions).sort(([a], [b]) => a.localeCompare(b)),
    ),
    connectors: [...connectors].sort(),
  };

  const templateKey = slugify(input.name, "workflow");
  const description = definition.description.slice(0, 500);
  const manifestInput: ExtensionManifestInput = {
    format: "sling.extension/v1",
    id: input.id,
    name: input.name,
    version: input.version,
    description,
    publisher: input.publisher,
    // No code, so any server on this major version can install it.
    sdk: `^${SDK_VERSION.split(".")[0]}.0.0`,
    templates: [templateKey],
    requires,
  };
  const manifest = ExtensionManifestSchema.safeParse(manifestInput);
  if (!manifest.success) {
    const issue = manifest.error.issues[0];
    throw new ExtensionError(
      `The package can't be built: ${issue?.path.join(".") || "manifest"} ${issue?.message ?? "is invalid"}.`,
    );
  }

  const files = new Map<string, Uint8Array>();
  const json = (v: unknown) => enc.encode(`${JSON.stringify(v, null, 2)}\n`);
  files.set("sling-extension.json", json(manifestInput));
  files.set("README.md", enc.encode(readme(input.name, description, bindings, requires)));
  files.set(
    `templates/${templateKey}/template.json`,
    json({ name: input.name, description, bindings }),
  );
  files.set(`templates/${templateKey}/workflow.json`, json({ ...definition, nodes }));

  const bytes = writePackage(files);
  // Fails loudly here rather than when someone installs it.
  readPackage(bytes);
  return { bytes, templateKey, bindings, requires };
}
