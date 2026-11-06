/**
 * Extensions are server software, like the built-in connectors, so these
 * tables have no workspace. Installations of their connectors, and audit
 * entries about them, still belong to a workspace.
 */
import type { ExtensionContents, ExtensionSource, ExtensionStatus } from "@sling/core";
import {
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").defaultNow().notNull();
const updatedAt = () =>
  ts("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength),
  fromDriver: (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
});

/** Permissions as the manifest declares them. Same shape as `ExtensionPermissions` in the SDK. */
type PermissionsJson = {
  network: { hosts: string[]; configHosts: string[]; localNetwork: boolean };
  approvals: boolean;
  sandboxes: boolean;
};

export const extensions = pgTable("extensions", {
  /** The extension's own ID from its manifest. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  version: text("version").notNull(),
  source: text("source").$type<ExtensionSource>().notNull(),
  /** `included`, a catalog ID, or null for uploads. No foreign key: catalogs can be removed. */
  catalogId: text("catalog_id"),
  /** The key the installed version is pinned to. Null when unsigned or included. */
  publisherKeyId: text("publisher_key_id"),
  publisherName: text("publisher_name"),
  signed: boolean("signed").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  status: text("status").$type<ExtensionStatus>().notNull().default("stopped"),
  statusDetail: text("status_detail"),
  /** What you approved at install or the last update. */
  granted: jsonb("granted").$type<PermissionsJson>().notNull(),
  /** Set when a catalog revoked the installed version. */
  revokedReason: text("revoked_reason"),
  installedBy: text("installed_by").references(() => users.id, { onDelete: "set null" }),
  installedAt: ts("installed_at").defaultNow().notNull(),
  updatedAt: updatedAt(),
});

/** Package bytes, kept for the installed version and the one before it. */
export const extensionPackages = pgTable(
  "extension_packages",
  {
    extensionId: text("extension_id")
      .notNull()
      .references(() => extensions.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    /** `sha256:<hex>` over the package's files. Checked every time the package is unpacked. */
    digest: text("digest").notNull(),
    size: integer("size").notNull(),
    archive: bytea("archive").notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    /** What the code said it adds (`ExtensionDescription`). Null for workflow packages. */
    description: jsonb("description").$type<Record<string, unknown>>(),
    contents: jsonb("contents").$type<ExtensionContents>().notNull(),
    signature: jsonb("signature").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.extensionId, t.version] })],
);

/** Keys you trust to sign packages. */
export const extensionPublishers = pgTable("extension_publishers", {
  keyId: text("key_id").primaryKey(),
  name: text("name").notNull(),
  /** Raw Ed25519 key, base64. */
  publicKey: text("public_key").notNull(),
  trustedBy: text("trusted_by").references(() => users.id, { onDelete: "set null" }),
  trustedAt: ts("trusted_at").defaultNow().notNull(),
});

/** Catalogs you added by URL. The included catalog isn't stored here. */
export const extensionCatalogs = pgTable("extension_catalogs", {
  id: text("id").primaryKey(),
  url: text("url").notNull().unique(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  fetchedAt: ts("fetched_at"),
  etag: text("etag"),
  error: text("error"),
  /** The last good copy of the catalog. */
  document: jsonb("document").$type<Record<string, unknown>>(),
  addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});
