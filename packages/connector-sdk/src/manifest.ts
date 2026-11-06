/**
 * File formats around an extension: its manifest (`sling-extension.json`),
 * the signature `sling-ext sign` adds (`SIGNATURE.json`), and catalogs.
 */
import { z } from "zod";

/** The SDK version this package implements. Manifests name a range that must include it. */
export const SDK_VERSION = "1.0.0";

/** 3 to 40 characters: lowercase letters, digits, and hyphens, starting with a letter. */
export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

const ExtensionId = z
  .string()
  .regex(EXTENSION_ID_PATTERN, "must be 3 to 40 characters: a-z, 0-9, -");
const Version = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "must be a version like 1.2.3");
/** `^1.2.3`, `~1.2.3`, `>=1.2.3`, or an exact `1.2.3`. */
const VersionRange = z
  .string()
  .regex(/^(\^|~|>=)?\d+\.\d+\.\d+$/, "must be ^x.y.z, ~x.y.z, >=x.y.z, or x.y.z");
/** A hostname, or `*.` and a hostname for every subdomain. IP literals are allowed. */
const HostPattern = z
  .string()
  .regex(
    /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
    "must be a lowercase hostname, optionally starting with *.",
  );
const FilePath = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/);
const Fingerprint = z.string().regex(/^[0-9a-f]{16}$/, "must be 16 hex characters");
const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64");

export const NetworkPermissionSchema = z
  .object({
    /** Hosts the extension may reach. `*.example.com` covers every subdomain. */
    hosts: z.array(HostPattern).max(50).default([]),
    /**
     * Config fields of the extension's connectors that hold a URL. The host of
     * that URL, in each installation, may be reached too.
     */
    configHosts: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(10)
      .default([]),
    /** Loopback and private addresses, and plain http and ws to them. */
    localNetwork: z.boolean().default(false),
  })
  .strict();

/**
 * What an extension may do beyond the fixed minimum. Unknown keys are refused,
 * so a permission this server doesn't know is never silently ignored.
 */
export const ExtensionPermissionsSchema = z
  .object({
    network: NetworkPermissionSchema.prefault({}),
    /** Decide pending approvals on behalf of people its installation allows. */
    approvals: z.boolean().default(false),
    /** Provide sandboxes. A provider sees each sandbox's secrets. */
    sandboxes: z.boolean().default(false),
  })
  .strict();

export type ExtensionPermissions = z.output<typeof ExtensionPermissionsSchema>;
export type NetworkPermission = z.output<typeof NetworkPermissionSchema>;

export const ExtensionManifestSchema = z
  .object({
    format: z.literal("sling.extension/v1"),
    id: ExtensionId,
    name: z.string().trim().min(1).max(80),
    version: Version,
    description: z.string().max(500).default(""),
    /** Display name. Trust comes from the signing key, not this. */
    publisher: z.string().trim().min(1).max(80),
    /** SDK versions the extension works with. */
    sdk: VersionRange,
    /** The bundled ES module, relative to the package root. Absent in workflow packages. */
    main: FilePath.regex(/\.mjs$/, "must end in .mjs").optional(),
    /** Template keys under `templates/`. */
    templates: z
      .array(z.string().regex(/^[a-z0-9-]+$/))
      .max(50)
      .default([]),
    icon: FilePath.regex(/\.(svg|png)$/, "must be an .svg or .png").optional(),
    permissions: ExtensionPermissionsSchema.prefault({}),
    requires: z
      .object({
        /** Other extensions, by ID, with a version range. */
        extensions: z.record(ExtensionId, VersionRange).default({}),
        /** Connectors built into Sling, such as `discord`. */
        connectors: z.array(z.string().min(1)).max(20).default([]),
      })
      .prefault({}),
    /** Heap limit for the extension's process. */
    memoryMb: z.number().int().min(64).max(512).default(256),
    license: z.string().max(100).optional(),
    homepage: z.url().optional(),
    repository: z.url().optional(),
  })
  .refine((m) => m.main !== undefined || m.templates.length > 0, {
    message: "a package needs main, templates, or both",
  });

export type ExtensionManifest = z.output<typeof ExtensionManifestSchema>;
export type ExtensionManifestInput = z.input<typeof ExtensionManifestSchema>;

export const PackageSignatureSchema = z.object({
  format: z.literal("sling.signature/v1"),
  /** First 16 hex characters of the public key's SHA-256. */
  keyId: Fingerprint,
  /** Raw 32-byte Ed25519 public key, base64. */
  publicKey: Base64,
  publisher: z.string().trim().min(1).max(80),
  /** Ed25519 signature over `signedMessage(id, version, digest)`, base64. */
  signature: Base64,
});

export type PackageSignature = z.output<typeof PackageSignatureSchema>;

export const EXTENSION_KINDS = ["connector", "provider", "workflows"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const CatalogVersionSchema = z.object({
  version: Version,
  /** Resolved against the catalog's own URL. */
  url: z.string().min(1).max(2000),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 hex>"),
  size: z.number().int().nonnegative(),
  sdk: VersionRange,
  permissions: ExtensionPermissionsSchema.prefault({}),
  publishedAt: z.string().max(40).optional(),
  revoked: z
    .object({ reason: z.string().min(1).max(500) })
    .nullable()
    .default(null),
});

export const CatalogEntrySchema = z.object({
  id: ExtensionId,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  /** Key ID of the publisher that signs it. Null for unsigned packages. */
  publisher: Fingerprint.nullable().default(null),
  kinds: z.array(z.enum(EXTENSION_KINDS)).default([]),
  homepage: z.url().optional(),
  versions: z.array(CatalogVersionSchema).min(1).max(200),
});

export const CatalogSchema = z.object({
  format: z.literal("sling.catalog/v1"),
  name: z.string().trim().min(1).max(80),
  publishers: z
    .array(
      z.object({ keyId: Fingerprint, name: z.string().trim().min(1).max(80), publicKey: Base64 }),
    )
    .max(100)
    .default([]),
  extensions: z.array(CatalogEntrySchema).max(1000),
});

export type Catalog = z.output<typeof CatalogSchema>;
export type CatalogEntry = z.output<typeof CatalogEntrySchema>;
export type CatalogVersion = z.output<typeof CatalogVersionSchema>;

/** The exact bytes a publisher signs. Binds the ID and version to the digest. */
export function signedMessage(id: string, version: string, digest: string): Uint8Array {
  return new TextEncoder().encode(`sling.extension/v1\n${id}\n${version}\n${digest}\n`);
}
