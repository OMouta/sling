/**
 * `sling-ext catalog`: writes `catalog.json` for the `.slx` files in a
 * folder, so the folder can be served as a catalog by any static web host.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Catalog,
  type CatalogEntry,
  CatalogSchema,
  type CatalogVersion,
  type ExtensionKind,
} from "@sling/connector-sdk";
import { compareVersions, formatFingerprint, kindsOf } from "@sling/connector-sdk/host";
import { verifySignature } from "@sling/extension-package";
import { describeFiles } from "./describe.ts";
import { openPackage } from "./pack.ts";
import { zodIssues } from "./project.ts";
import { CliError, errorMessage } from "./util.ts";

/** Sling refuses catalogs bigger than this. */
export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

export interface CatalogOptions {
  name?: string;
  /** Defaults to `<dir>/catalog.json`. */
  out?: string;
  /** Marks `<id>@<version>` revoked, with `reason`. */
  revoke?: { id: string; version: string; reason: string };
  /** Clock for `publishedAt` on versions the catalog didn't list before. */
  now?: () => Date;
}

interface Scanned {
  file: string;
  id: string;
  name: string;
  description: string;
  homepage: string | undefined;
  version: CatalogVersion;
  kinds: ExtensionKind[];
  publisher: { keyId: string; name: string; publicKey: string } | null;
}

async function readExisting(path: string): Promise<Catalog | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = CatalogSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new CliError(
        `${path} isn't a valid catalog, so it can't be updated: ${zodIssues(parsed.error).join("; ")}`,
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${path} isn't valid JSON: ${errorMessage(error)}`);
  }
}

async function scan(dir: string, file: string): Promise<Scanned> {
  const { bytes, pkg } = await openPackage(join(dir, file));
  const m = pkg.manifest;
  let publisher: Scanned["publisher"] = null;
  if (pkg.signature) {
    const check = verifySignature(pkg);
    if (!check.ok) throw new CliError(`${file}: ${check.reason}`);
    publisher = { keyId: check.keyId, name: check.publisher, publicKey: check.publicKey };
  }
  let kinds: ExtensionKind[] = kindsOf(m, null);
  if (m.main) {
    const described = await describeFiles(pkg.files, m.main, { memoryMb: m.memoryMb });
    if (!described.ok) throw new CliError(`${file}: running its bundle failed: ${described.error}`);
    kinds = kindsOf(m, described.description);
  }
  return {
    file,
    id: m.id,
    name: m.name,
    description: m.description,
    homepage: m.homepage,
    kinds,
    publisher,
    version: {
      version: m.version,
      url: encodeURIComponent(file),
      digest: pkg.digest,
      size: bytes.length,
      sdk: m.sdk,
      permissions: m.permissions,
      revoked: null,
    },
  };
}

export interface CatalogResult {
  path: string;
  catalog: Catalog;
  /** One line per version, for printing. */
  lines: string[];
}

export async function writeCatalog(
  dir: string,
  options: CatalogOptions = {},
): Promise<CatalogResult> {
  const out = options.out ?? join(dir, "catalog.json");
  const existing = await readExisting(out);
  const now = (options.now ?? (() => new Date()))();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".slx")).sort();
  if (files.length === 0) throw new CliError(`There are no .slx files in ${dir}.`);

  const scanned: Scanned[] = [];
  for (const file of files) scanned.push(await scan(dir, file));

  const byId = new Map<string, Scanned[]>();
  for (const s of scanned) byId.set(s.id, [...(byId.get(s.id) ?? []), s]);

  const publishers = new Map<string, NonNullable<Scanned["publisher"]>>();
  const entries: CatalogEntry[] = [];
  const lines: string[] = [];
  let revokedOne = false;

  for (const id of [...byId.keys()].sort()) {
    const versions = (byId.get(id) as Scanned[]).sort((a, b) =>
      compareVersions(b.version.version, a.version.version),
    );
    const seen = new Map<string, Scanned>();
    for (const v of versions) {
      const twin = seen.get(v.version.version);
      if (twin) {
        throw new CliError(
          `${twin.file} and ${v.file} are both ${id} ${v.version.version}. Keep one of them.`,
        );
      }
      seen.set(v.version.version, v);
    }
    const keys = new Set(versions.map((v) => v.publisher?.keyId ?? "unsigned"));
    if (keys.size > 1) {
      const which = [...keys].map((k) => (k === "unsigned" ? "unsigned" : formatFingerprint(k)));
      throw new CliError(
        `The versions of ${id} aren't all signed by one key (${which.join(", ")}). Sling pins an extension to the key that signed it, so sign every version with the same key.`,
      );
    }
    const latest = versions[0] as Scanned;
    const before = existing?.extensions.find((e) => e.id === id);
    const catalogVersions: CatalogVersion[] = versions.map((v) => {
      const old = before?.versions.find((x) => x.version === v.version.version);
      let revoked = old?.digest === v.version.digest ? old.revoked : null;
      if (
        options.revoke &&
        options.revoke.id === id &&
        options.revoke.version === v.version.version
      ) {
        revoked = { reason: options.revoke.reason };
        revokedOne = true;
      }
      return {
        ...v.version,
        publishedAt:
          old?.digest === v.version.digest && old.publishedAt
            ? old.publishedAt
            : now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        revoked,
      };
    });
    if (latest.publisher) publishers.set(latest.publisher.keyId, latest.publisher);
    entries.push({
      id,
      name: latest.name,
      description: latest.description,
      publisher: latest.publisher?.keyId ?? null,
      kinds: latest.kinds,
      ...(latest.homepage ? { homepage: latest.homepage } : {}),
      versions: catalogVersions,
    });
    for (const v of catalogVersions) {
      const by = latest.publisher
        ? `signed by ${latest.publisher.name}, ${formatFingerprint(latest.publisher.keyId)}`
        : "unsigned";
      const revoked = v.revoked ? `, revoked: ${v.revoked.reason}` : "";
      lines.push(`${id} ${v.version} (${latest.kinds.join(", ") || "nothing"}), ${by}${revoked}`);
    }
  }
  if (options.revoke && !revokedOne) {
    throw new CliError(
      `There's no ${options.revoke.id} ${options.revoke.version} in ${dir} to revoke.`,
    );
  }

  const catalog = CatalogSchema.parse({
    format: "sling.catalog/v1",
    name: options.name ?? existing?.name ?? "Extensions",
    publishers: [...publishers.values()].sort((a, b) => a.keyId.localeCompare(b.keyId)),
    extensions: entries,
  });
  const text = `${JSON.stringify(catalog, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) {
    throw new CliError("The catalog is over 2 MB, which Sling refuses. Split it into two folders.");
  }
  await writeFile(out, text);
  return { path: out, catalog, lines };
}
