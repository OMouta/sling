/**
 * Checks Sling and `sling-ext` run against a package. Not part of the stable
 * API: import from `@sling/connector-sdk/host`.
 */
import type { ExtensionDescription } from "./extension.ts";
import type {
  ExtensionKind,
  ExtensionManifest,
  ExtensionPermissions,
  NetworkPermission,
} from "./manifest.ts";

export interface PermissionLine {
  /** Stable key, for diffs. */
  key: string;
  text: string;
  /** `high` for permissions that reach past the extension's own installations. */
  risk: "normal" | "high";
}

/** Whether a connector ID belongs to an extension: its ID, or `<id>.<name>`. */
export function ownsConnectorId(extensionId: string, connectorId: string): boolean {
  return connectorId === extensionId || connectorId.startsWith(`${extensionId}.`);
}

/** Whether a node type or event type belongs to an extension: `<id>.<name>`. */
export function ownsName(extensionId: string, name: string): boolean {
  return name.startsWith(`${extensionId}.`) && name.length > extensionId.length + 1;
}

/** `3f2a91c07d4e22b1` as `3f2a 91c0 7d4e 22b1`. */
export function formatFingerprint(keyId: string): string {
  return keyId.match(/.{1,4}/g)?.join(" ") ?? keyId;
}

function hostLine(host: string): PermissionLine {
  return host.startsWith("*.")
    ? {
        key: `host:${host}`,
        text: `Connect to ${host.slice(2)} and its subdomains`,
        risk: "normal",
      }
    : { key: `host:${host}`, text: `Connect to ${host}`, risk: "normal" };
}

/** Plain-language lines for an install dialog, one per thing granted. */
export function describePermissions(p: ExtensionPermissions): PermissionLine[] {
  const network: NetworkPermission = p.network;
  const lines: PermissionLine[] = network.hosts.map(hostLine);
  for (const field of network.configHosts) {
    lines.push({
      key: `configHost:${field}`,
      text: `Connect to the host in each installation's "${field}" setting`,
      risk: "normal",
    });
  }
  if (network.localNetwork) {
    lines.push({
      key: "localNetwork",
      text: "Connect to addresses on your local network, including this server",
      risk: "high",
    });
  }
  if (p.approvals) {
    lines.push({
      key: "approvals",
      text: "Approve or reject pending approvals, for people its installation allows",
      risk: "high",
    });
  }
  if (p.sandboxes) {
    lines.push({
      key: "sandboxes",
      text: "Start sandboxes, and receive each sandbox's secrets: API keys, the GitHub token, and its pairing code",
      risk: "high",
    });
  }
  return lines;
}

export function diffPermissions(
  from: ExtensionPermissions,
  to: ExtensionPermissions,
): { added: PermissionLine[]; removed: PermissionLine[] } {
  const a = describePermissions(from);
  const b = describePermissions(to);
  const before = new Set(a.map((l) => l.key));
  const after = new Set(b.map((l) => l.key));
  return {
    added: b.filter((l) => !before.has(l.key)),
    removed: a.filter((l) => !after.has(l.key)),
  };
}

/** True when the extension asks for nothing beyond the fixed minimum. */
export function hasNoPermissions(p: ExtensionPermissions): boolean {
  return describePermissions(p).length === 0;
}

// --------------------------------------------------------------- versions

type Triple = [number, number, number, string | null];

function parseVersion(v: string): Triple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null];
}

/** Negative when a < b. Prereleases sort before their release. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  if (x[3] === y[3]) return 0;
  if (x[3] === null) return 1;
  if (y[3] === null) return -1;
  return x[3] < y[3] ? -1 : 1;
}

/** `^1.2.3`, `~1.2.3`, `>=1.2.3`, or an exact `1.2.3`. */
export function satisfiesRange(version: string, range: string): boolean {
  const m = /^(\^|~|>=)?(\d+\.\d+\.\d+)$/.exec(range);
  const v = parseVersion(version);
  if (!m || !v) return false;
  const op = m[1] ?? "";
  const base = m[2] as string;
  const b = parseVersion(base) as Triple;
  if (op === "") return compareVersions(version, base) === 0;
  if (compareVersions(version, base) < 0) return false;
  if (op === ">=") return true;
  if (op === "~") return v[0] === b[0] && v[1] === b[1];
  // Caret: the left-most non-zero part stays fixed.
  if (b[0] > 0) return v[0] === b[0];
  if (b[1] > 0) return v[0] === 0 && v[1] === b[1];
  return v[0] === 0 && v[1] === 0 && v[2] === b[2];
}

// --------------------------------------------------------------- checks

/** What a package adds, for filters and cards. */
export function kindsOf(
  manifest: Pick<ExtensionManifest, "templates">,
  description: ExtensionDescription | null,
): ExtensionKind[] {
  const kinds: ExtensionKind[] = [];
  const connectors = description?.connectors ?? [];
  if (connectors.some((c) => !c.isExecutionProvider)) kinds.push("connector");
  if (connectors.some((c) => c.isExecutionProvider)) kinds.push("provider");
  if (manifest.templates.length > 0) kinds.push("workflows");
  return kinds;
}

/**
 * Problems that stop a package from being installed: names outside its ID,
 * duplicates, a provider without the `sandboxes` permission, and so on.
 * `description` is null for packages without code.
 */
export function checkDescription(
  manifest: ExtensionManifest,
  description: ExtensionDescription | null,
): string[] {
  const problems: string[] = [];
  const id = manifest.id;
  if (!manifest.main) {
    if (!hasNoPermissions(manifest.permissions)) {
      problems.push("A package without code can't ask for permissions.");
    }
    return problems;
  }
  if (!description) return ["The package's code didn't describe what it adds."];
  if (description.format !== "sling.description/v1") {
    return [`Unknown description format ${String(description.format)}.`];
  }
  if (description.connectors.length === 0) problems.push("The package's code adds no connectors.");
  const connectorIds = new Set<string>();
  const nodeKeys = new Set<string>();
  const configFields = new Set<string>();
  for (const c of description.connectors) {
    if (!ownsConnectorId(id, c.id)) {
      problems.push(`Connector ${c.id} must be named ${id} or start with ${id}.`);
    }
    if (connectorIds.has(c.id)) problems.push(`Connector ${c.id} is defined twice.`);
    connectorIds.add(c.id);
    if (c.isExecutionProvider && !manifest.permissions.sandboxes) {
      problems.push(`Connector ${c.id} provides sandboxes, which needs the sandboxes permission.`);
    }
    const props = (c.configSchema.properties ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(props)) configFields.add(k);
    for (const n of c.nodes) {
      if (!ownsName(id, n.type)) problems.push(`Node ${n.type} must start with ${id}.`);
      const key = `${n.type}@${n.version}`;
      if (nodeKeys.has(key)) problems.push(`Node ${key} is defined twice.`);
      nodeKeys.add(key);
      if (n.trigger && !ownsName(id, n.trigger.event)) {
        problems.push(`Trigger event ${n.trigger.event} must start with ${id}.`);
      }
      if (!n.execInput && !n.trigger)
        problems.push(`Node ${key} has no exec input and no trigger.`);
    }
  }
  for (const field of manifest.permissions.network.configHosts) {
    if (!configFields.has(field)) {
      problems.push(`configHosts names "${field}", which no connector's config has.`);
    }
  }
  return problems;
}
