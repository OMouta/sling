/** API views of installed extensions, catalog entries, and catalogs. */
import {
  type CatalogEntry,
  type CatalogVersion,
  type ExtensionDescription,
  type ExtensionManifest,
  SDK_VERSION,
} from "@sling/connector-sdk";
import {
  compareVersions,
  describePermissions,
  kindsOf,
  satisfiesRange,
} from "@sling/connector-sdk/host";
import type {
  CatalogView,
  ExtensionContents,
  ExtensionRef,
  ExtensionView,
  PublisherRef,
} from "@sling/core";
import type { schema } from "@sling/db";
import type { Template } from "../workflows/templates.ts";
import type { CatalogState } from "./catalogs.ts";

export type ExtensionRow = typeof schema.extensions.$inferSelect;

/** An installed extension as the service keeps it in memory. */
export interface InstalledExtension {
  row: ExtensionRow;
  manifest: ExtensionManifest;
  digest: string;
  size: number;
  description: ExtensionDescription | null;
  contents: ExtensionContents;
  readme: string | null;
  icon: { bytes: Uint8Array; type: string } | null;
  /** Keyed `<id>/<key>`, with the extension on the view. */
  templates: Template[];
  /** False when the stored package failed its digest check. */
  intact: boolean;
  /** This run's unpacked copy, while its code is active. */
  dir: string | null;
  /** Activated in the runtime and not deactivated since. */
  active: boolean;
  /** Connectors registered for it, real or stand-ins. */
  connectorIds: string[];
}

export function extensionRef(x: InstalledExtension): ExtensionRef {
  return { id: x.row.id, name: x.row.name, version: x.row.version, hasIcon: x.icon !== null };
}

/** Versions this server can install, newest first. */
export function installableVersions(entry: CatalogEntry): CatalogVersion[] {
  return entry.versions
    .filter((v) => v.revoked === null && satisfiesRange(SDK_VERSION, v.sdk))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Why none of an entry's versions can be installed. */
export function unavailableReason(entry: CatalogEntry): string {
  if (entry.versions.every((v) => v.revoked !== null)) return "Every version is revoked.";
  const ranges = [...new Set(entry.versions.filter((v) => v.revoked === null).map((v) => v.sdk))];
  return `It needs SDK ${ranges.join(" or ")}, and this server has ${SDK_VERSION}.`;
}

/** A newer installable version in the catalog the extension came from. */
export function updateFor(
  x: InstalledExtension,
  catalog: CatalogState | undefined,
): { version: string; catalogId: string } | null {
  if (!catalog?.enabled || !catalog.document || x.row.source === "upload") return null;
  const entry = catalog.document.extensions.find((e) => e.id === x.row.id);
  if (!entry) return null;
  const newest = installableVersions(entry)[0];
  if (!newest || compareVersions(newest.version, x.row.version) <= 0) return null;
  return { version: newest.version, catalogId: catalog.id };
}

export function toExtensionView(
  x: InstalledExtension,
  extra: {
    publisher: PublisherRef | null;
    update: { version: string; catalogId: string } | null;
    usedBy: { installations: number; workflows: number };
  },
): ExtensionView {
  const r = x.row;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    version: r.version,
    source: r.source,
    catalogId: r.catalogId,
    publisher: extra.publisher,
    signed: r.signed,
    enabled: r.enabled,
    status: r.status,
    statusDetail: r.statusDetail,
    kinds: kindsOf(x.manifest, x.description),
    contents: x.contents,
    permissions: describePermissions(r.granted),
    update: extra.update,
    revoked: r.revokedReason ? { reason: r.revokedReason } : null,
    usedBy: extra.usedBy,
    hasIcon: x.icon !== null,
    homepage: x.manifest.homepage ?? null,
    installedAt: r.installedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toCatalogView(c: CatalogState): CatalogView {
  return {
    id: c.id,
    url: c.url,
    name: c.name,
    enabled: c.enabled,
    included: c.included,
    fetchedAt: c.fetchedAt?.toISOString() ?? null,
    error: c.error,
    extensionCount: c.document?.extensions.length ?? 0,
  };
}
