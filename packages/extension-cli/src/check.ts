/**
 * `sling-ext check`: what Sling checks when it reads a package, run locally.
 * The manifest, the files it names, each template, and, for packages with
 * code, the bundle run under Sling's restrictions and the description it
 * returns.
 */
import {
  type ExtensionDescription,
  type ExtensionKind,
  type ExtensionManifest,
  SDK_VERSION,
} from "@sling/connector-sdk";
import {
  checkDescription,
  describePermissions,
  kindsOf,
  ownsConnectorId,
  type PermissionLine,
  satisfiesRange,
} from "@sling/connector-sdk/host";
import { LIMITS, PackageError, parseManifest } from "@sling/extension-package";
import { parseDefinition, type WorkflowDefinition } from "@sling/workflow";
import { z } from "zod";
import { describeFiles } from "./describe.ts";
import { zodIssues } from "./project.ts";
import { errorMessage, formatBytes, type Output, plural } from "./util.ts";

/** The `template.json` format, as the server reads it. */
export const TemplateFileSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().default(""),
  builtIn: z.boolean().default(false),
  bindings: z
    .array(
      z.object({
        placeholder: z.string().regex(/^\$[a-z][a-z0-9_]*$/),
        connectorId: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .default([]),
});

export type TemplateFile = z.output<typeof TemplateFileSchema>;

/** Node type prefixes Sling itself provides. */
const CORE_PREFIXES = new Set(["agent", "ai", "app", "core", "http", "human", "sling", "state"]);
/** Connectors built into Sling that have workflow nodes. */
const BUILT_IN_CONNECTORS = new Set(["discord", "email"]);

export interface TemplateSummary {
  key: string;
  name: string;
  bindings: TemplateFile["bindings"];
}

export interface CheckReport {
  manifest: ExtensionManifest | null;
  description: ExtensionDescription | null;
  templates: TemplateSummary[];
  kinds: ExtensionKind[];
  permissions: PermissionLine[];
  files: number;
  unpackedBytes: number;
  /** Anything here stops Sling from installing the package. */
  problems: string[];
  warnings: string[];
  /** What the bundle printed while it was described. */
  output: string[];
  describeMs: number | null;
}

function emptyReport(): CheckReport {
  return {
    manifest: null,
    description: null,
    templates: [],
    kinds: [],
    permissions: [],
    files: 0,
    unpackedBytes: 0,
    problems: [],
    warnings: [],
    output: [],
    describeMs: null,
  };
}

function parseJson(bytes: Uint8Array | undefined): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Placeholder strings such as `"$ntfy"` used as whole config values. */
function placeholdersIn(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    if (/^\$[a-z][a-z0-9_]*$/.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) placeholdersIn(v, found);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) placeholdersIn(v, found);
  }
}

/** Where a node type or connector comes from, and whether the manifest declares it. */
function requirementProblem(
  manifest: ExtensionManifest,
  owner: string,
  what: string,
): string | null {
  if (CORE_PREFIXES.has(owner) || owner === manifest.id) return null;
  if (BUILT_IN_CONNECTORS.has(owner) || ["docker", "railway"].includes(owner)) {
    return manifest.requires.connectors.includes(owner)
      ? null
      : `${what} comes from the built-in ${owner} connector. Add "${owner}" to requires.connectors.`;
  }
  return Object.keys(manifest.requires.extensions).includes(owner)
    ? null
    : `${what} comes from an extension called ${owner}. Add it to requires.extensions with a version range, such as "${owner}": "^1.0.0".`;
}

function checkTemplate(
  key: string,
  files: Map<string, Uint8Array>,
  manifest: ExtensionManifest,
  report: CheckReport,
): void {
  const where = `Template ${key}`;
  let meta: TemplateFile;
  let definition: WorkflowDefinition;
  try {
    const parsed = TemplateFileSchema.safeParse(
      parseJson(files.get(`templates/${key}/template.json`)),
    );
    if (!parsed.success) {
      report.problems.push(...zodIssues(parsed.error).map((l) => `${where}, template.json: ${l}`));
      return;
    }
    meta = parsed.data;
  } catch (error) {
    report.problems.push(`${where}: template.json isn't valid JSON: ${errorMessage(error)}`);
    return;
  }
  try {
    const parsed = parseDefinition(parseJson(files.get(`templates/${key}/workflow.json`)));
    if (!parsed.ok) {
      report.problems.push(...parsed.issues.map((i) => `${where}, workflow.json: ${i.message}`));
      return;
    }
    definition = parsed.definition;
  } catch (error) {
    report.problems.push(`${where}: workflow.json isn't valid JSON: ${errorMessage(error)}`);
    return;
  }
  if (meta.key !== key) {
    report.problems.push(`${where}: template.json says its key is ${meta.key}. Use ${key}.`);
  }
  report.templates.push({ key, name: meta.name, bindings: meta.bindings });

  const types = new Set(definition.nodes.map((n) => n.type));
  for (const type of [...types].sort()) {
    const owner = type.split(".")[0] as string;
    const problem = requirementProblem(manifest, owner, `${where} uses ${type}, which`);
    if (problem) report.warnings.push(problem);
  }
  const used = new Set<string>();
  for (const node of definition.nodes) placeholdersIn(node.config, used);
  const declared = new Set(meta.bindings.map((b) => b.placeholder));
  for (const b of meta.bindings) {
    if (!used.has(b.placeholder)) {
      report.warnings.push(`${where}: binding ${b.placeholder} isn't used in workflow.json.`);
    }
    const owner = ownsConnectorId(manifest.id, b.connectorId)
      ? manifest.id
      : (b.connectorId.split(".")[0] as string);
    const problem = requirementProblem(
      manifest,
      owner,
      `${where}: binding ${b.placeholder} is for the ${b.connectorId} connector, which`,
    );
    if (problem) report.warnings.push(problem);
  }
  for (const p of used) {
    if (!declared.has(p)) {
      report.warnings.push(
        `${where}: workflow.json uses ${p}, which no binding in template.json declares.`,
      );
    }
  }
}

/** Checks a package's files the way Sling does when it reads the package. */
export async function checkFiles(
  files: Map<string, Uint8Array>,
  options: { timeoutMs?: number } = {},
): Promise<CheckReport> {
  const report = emptyReport();
  report.files = files.size;
  for (const [path, data] of files) {
    report.unpackedBytes += data.length;
    if (path.length > LIMITS.maxPathLength) {
      report.problems.push(`${path} is longer than ${LIMITS.maxPathLength} characters.`);
    }
  }
  if (report.unpackedBytes > LIMITS.maxUnpacked) {
    report.problems.push(
      `The package is ${formatBytes(report.unpackedBytes)} unpacked. The limit is ${formatBytes(LIMITS.maxUnpacked)}.`,
    );
  }
  if (files.size > LIMITS.maxFiles) {
    report.problems.push(`The package has ${files.size} files. The limit is ${LIMITS.maxFiles}.`);
  }

  let manifest: ExtensionManifest;
  try {
    manifest = parseManifest(files);
  } catch (error) {
    report.problems.push(error instanceof PackageError ? error.message : errorMessage(error));
    return report;
  }
  report.manifest = manifest;
  report.permissions = describePermissions(manifest.permissions);

  if (!satisfiesRange(SDK_VERSION, manifest.sdk)) {
    report.problems.push(
      `sdk is "${manifest.sdk}", which doesn't include SDK ${SDK_VERSION}. Use "^${SDK_VERSION}".`,
    );
  }
  if (!files.has("README.md")) {
    report.warnings.push("There's no README.md. Sling shows it in the extension's details.");
  }
  for (const key of manifest.templates) checkTemplate(key, files, manifest, report);

  let description: ExtensionDescription | null = null;
  if (manifest.main) {
    const result = await describeFiles(files, manifest.main, {
      memoryMb: manifest.memoryMb,
      timeoutMs: options.timeoutMs,
    });
    report.output = result.output;
    if (result.ok) {
      description = result.description;
      report.describeMs = result.ms;
      if (
        typeof description.sdkVersion !== "string" ||
        !satisfiesRange(description.sdkVersion, manifest.sdk)
      ) {
        report.problems.push(
          `The bundle was built with SDK ${String(description.sdkVersion)}, which the manifest's sdk range "${manifest.sdk}" doesn't include.`,
        );
      }
    } else {
      report.problems.push(`Running the bundle failed: ${result.error}`);
    }
  }
  report.description = description;
  if (!manifest.main || description) {
    report.problems.push(...checkDescription(manifest, description));
  }
  report.kinds = kindsOf(manifest, description);
  return report;
}

/** Prints a report in plain lines. */
export function printReport(report: CheckReport, out: Output): void {
  const m = report.manifest;
  if (m) {
    out.out(`${m.name} (${m.id}) ${m.version}, published by ${m.publisher}`);
    out.out();
    out.out("Adds");
    const description = report.description;
    for (const c of description?.connectors ?? []) {
      const extras = [
        c.isExecutionProvider ? "sandbox provider" : null,
        c.hasSource ? "event source" : null,
      ].filter(Boolean);
      out.out(`  Connector ${c.id}: ${c.name}${extras.length ? ` (${extras.join(", ")})` : ""}`);
      for (const n of c.nodes) {
        const kind = n.trigger ? `trigger on ${n.trigger.event}` : n.category;
        out.out(`    ${n.type} v${n.version}, ${kind}: ${n.title}`);
      }
    }
    for (const t of report.templates) {
      const bindings = t.bindings.map((b) => `${b.placeholder} for ${b.connectorId}`).join(", ");
      out.out(`  Template ${m.id}/${t.key}: ${t.name}${bindings ? ` (asks for ${bindings})` : ""}`);
    }
    if (!description?.connectors.length && !report.templates.length) out.out("  Nothing yet");
    out.out(`Kinds: ${report.kinds.join(", ") || "none"}`);
    out.out();
    out.out("Permissions");
    if (report.permissions.length === 0) out.out("  None beyond the fixed minimum");
    for (const p of report.permissions) {
      out.out(`  ${p.risk === "high" ? "[high] " : ""}${p.text}`);
    }
    const requires = [
      ...Object.entries(m.requires.extensions).map(([id, range]) => `${id} ${range}`),
      ...m.requires.connectors.map((c) => `the built-in ${c} connector`),
    ];
    if (requires.length) out.out(`Requires: ${requires.join(", ")}`);
    out.out();
  }
  out.out(
    `Package: ${plural(report.files, "file")}, ${formatBytes(report.unpackedBytes)} unpacked${
      report.describeMs !== null ? `. The bundle described itself in ${report.describeMs} ms.` : ""
    }`,
  );
  if (report.output.length) {
    out.out();
    out.out("The bundle printed");
    for (const line of report.output.slice(-40)) out.out(`  ${line}`);
  }
  if (report.warnings.length) {
    out.out();
    out.out("Warnings");
    for (const w of report.warnings) out.out(`  ${w}`);
  }
  if (report.problems.length) {
    out.out();
    out.out("Problems");
    for (const p of report.problems) out.out(`  ${p}`);
  }
}
