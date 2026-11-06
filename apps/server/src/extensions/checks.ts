/**
 * Checks on a package that depend on what this server already has: names
 * other connectors use, required extensions and connectors, and the key that
 * ties a preview to its confirm.
 */
import { createHash } from "node:crypto";
import type {
  AssistantUse,
  ExtensionDescription,
  ExtensionManifest,
  ExtensionPermissions,
  NodeDescription,
} from "@sling/connector-sdk";
import { satisfiesRange } from "@sling/connector-sdk/host";
import type { ExtensionContents } from "@sling/core";
import { NODE_TYPE_PATTERN } from "@sling/workflow";

/**
 * A stable hash of what a manifest asks for. Host lists are sorted, so the
 * same permissions always give the same key.
 */
export function permissionsKey(p: ExtensionPermissions): string {
  const normalized = {
    network: {
      hosts: [...p.network.hosts].sort(),
      configHosts: [...p.network.configHosts].sort(),
      localNetwork: p.network.localNetwork,
    },
    approvals: p.approvals,
    sandboxes: p.sandboxes,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * How the assistant may use a described node, or null. Only a node that
 * runs to its end in one call can be a tool: a chat can't wait on a trigger
 * or a resume.
 */
export function assistantUse(n: NodeDescription): AssistantUse | null {
  if (!n.assistant || !n.execInput || n.trigger || n.hasResume) return null;
  return {
    sends: n.assistant.sends,
    ...(n.assistant.summary ? { summary: n.assistant.summary } : {}),
  };
}

/** What a package adds, for cards and dialogs. Template keys are as installed: `<id>/<key>`. */
export function contentsOf(
  description: ExtensionDescription | null,
  templates: { key: string; name: string }[],
): ExtensionContents {
  const connectors = description?.connectors ?? [];
  return {
    connectors: connectors.map((c) => ({
      id: c.id,
      name: c.name,
      isExecutionProvider: c.isExecutionProvider,
    })),
    nodes: connectors.flatMap((c) =>
      c.nodes.map((n) => {
        const use = assistantUse(n);
        return {
          type: n.type,
          version: n.version,
          title: n.title,
          isTrigger: n.trigger !== null || !n.execInput,
          ...(use ? { assistant: { sends: use.sends } } : {}),
        };
      }),
    ),
    templates: templates.map((t) => ({ key: t.key, name: t.name })),
  };
}

/** Node types a workflow couldn't use, because its definition format refuses the name. */
export function nodeTypeProblems(description: ExtensionDescription | null): string[] {
  const problems: string[] = [];
  for (const c of description?.connectors ?? []) {
    for (const n of c.nodes) {
      if (!NODE_TYPE_PATTERN.test(n.type)) {
        problems.push(
          `Node ${n.type} isn't a valid node type. Use lowercase letters, digits, "_" and "-", separated by dots.`,
        );
      }
    }
  }
  return problems;
}

/** Who registered a name: an extension ID, or null for Sling's built-in nodes and connectors. */
export interface NameIndex {
  connectors: ReadonlyMap<string, string | null>;
  /** The part of each node type and connector ID before its first dot. */
  namespaces: ReadonlyMap<string, string | null>;
}

/** The part of a node type or connector ID before its first dot. */
export function namespaceOf(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

function ownerLabel(owner: string | null): string {
  return owner === null ? "Sling's built-in nodes" : `the ${owner} extension`;
}

/**
 * Connector IDs and node names the package would take from something
 * already registered. An update may reuse its own names.
 */
export function nameClashes(
  extensionId: string,
  description: ExtensionDescription | null,
  index: NameIndex,
): string[] {
  if (!description || description.connectors.length === 0) return [];
  const problems: string[] = [];
  if (index.namespaces.has(extensionId)) {
    const owner = index.namespaces.get(extensionId) ?? null;
    if (owner !== extensionId) {
      problems.push(`The name ${extensionId} is already used by ${ownerLabel(owner)}.`);
    }
  }
  for (const c of description.connectors) {
    if (!index.connectors.has(c.id)) continue;
    const owner = index.connectors.get(c.id) ?? null;
    if (owner !== extensionId) {
      problems.push(`Connector ${c.id} is already registered by ${ownerLabel(owner)}.`);
    }
  }
  return problems;
}

export interface RequirementsInput {
  /** Installed extensions and their versions. */
  installed: ReadonlyMap<string, string>;
  hasConnector(id: string): boolean;
  /** A catalog with an installable version of the extension in the range, if any. */
  findInCatalogs(id: string, range: string): string | null;
}

export interface Missing {
  extensions: { id: string; range: string; catalogId: string | null }[];
  connectors: string[];
}

/** What the package needs that this server doesn't have. Each missing item is also a problem. */
export function checkRequirements(
  manifest: Pick<ExtensionManifest, "id" | "requires">,
  input: RequirementsInput,
): { missing: Missing; problems: string[] } {
  const missing: Missing = { extensions: [], connectors: [] };
  const problems: string[] = [];
  for (const [id, range] of Object.entries(manifest.requires.extensions)) {
    if (id === manifest.id) continue;
    const version = input.installed.get(id);
    if (version !== undefined && satisfiesRange(version, range)) continue;
    missing.extensions.push({ id, range, catalogId: input.findInCatalogs(id, range) });
    problems.push(
      version === undefined
        ? `It needs the ${id} extension (${range}), which isn't installed.`
        : `It needs the ${id} extension (${range}), and version ${version} is installed.`,
    );
  }
  for (const id of manifest.requires.connectors) {
    if (input.hasConnector(id)) continue;
    missing.connectors.push(id);
    problems.push(`It needs the ${id} connector, which this server doesn't have.`);
  }
  return { missing, problems };
}

/**
 * The hostname in an installation config value: a URL, or a bare host.
 * Null for anything else.
 */
export function hostOf(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const raw = value.trim();
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
