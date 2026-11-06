/** `sling-ext pack`, `sign`, and `verify`. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatFingerprint } from "@sling/connector-sdk/host";
import {
  computeDigest,
  type ExtensionPackage,
  LIMITS,
  PackageError,
  readPackage,
  type SigningKey,
  signPackage,
  verifySignature,
  writePackage,
} from "@sling/extension-package";
import { type CheckReport, checkFiles } from "./check.ts";
import { collectFiles, type Project } from "./project.ts";
import { CliError, errorMessage, formatBytes } from "./util.ts";

export interface PackResult {
  path: string;
  bytes: Uint8Array;
  digest: string;
  report: CheckReport;
  signedBy: SigningKey | null;
}

/** `<id>-<version>.slx`. */
export function packageFileName(id: string, version: string): string {
  return `${id}-${version}.slx`;
}

/**
 * Checks the project and writes `<outDir>/<id>-<version>.slx`. The same
 * files always give the same bytes, signed or not.
 */
export async function packProject(
  project: Project,
  options: { key?: SigningKey | null; outDir?: string } = {},
): Promise<PackResult> {
  const { files, missing } = await collectFiles(project);
  if (missing.length) throw new CliError(missing.join("\n"));
  const report = await checkFiles(files);
  if (report.problems.length) {
    throw new CliError(
      `The package has problems:\n${report.problems.map((p) => `  ${p}`).join("\n")}`,
    );
  }
  const { manifest } = project;
  const digest = computeDigest(files);
  const signature = options.key ? signPackage({ manifest, digest }, options.key) : null;
  const bytes = writePackage(files, signature);
  if (bytes.length > LIMITS.maxCompressed) {
    throw new CliError(
      `The package is ${formatBytes(bytes.length)}. The limit is ${formatBytes(LIMITS.maxCompressed)}.`,
    );
  }
  // Read it back as Sling will, so a package that packs always opens.
  readPackage(bytes);
  const outDir = resolve(project.dir, options.outDir ?? "dist");
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, packageFileName(manifest.id, manifest.version));
  await writeFile(path, bytes);
  return { path, bytes, digest, report, signedBy: options.key ?? null };
}

export async function openPackage(
  path: string,
): Promise<{ bytes: Uint8Array; pkg: ExtensionPackage }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    throw new CliError(`Couldn't read ${path}: ${errorMessage(error)}`);
  }
  try {
    return { bytes, pkg: readPackage(bytes) };
  } catch (error) {
    if (error instanceof PackageError) throw new CliError(`${path}: ${error.message}`);
    throw error;
  }
}

export interface SignResult {
  bytes: Uint8Array;
  pkg: ExtensionPackage;
  /** The key ID of the signature this one replaced, if any. */
  replaced: string | null;
}

/** Adds or replaces `SIGNATURE.json`. The digest doesn't change. */
export function signBytes(pkg: ExtensionPackage, key: SigningKey): SignResult {
  const signature = signPackage(pkg, key);
  const bytes = writePackage(pkg.files, signature);
  return { bytes, pkg: readPackage(bytes), replaced: pkg.signature?.keyId ?? null };
}

export function fingerprintLine(keyId: string): string {
  return `${formatFingerprint(keyId)} (key ID ${keyId})`;
}

export type VerifyOutcome =
  | { ok: true; keyId: string; publisher: string }
  | { ok: false; reason: string };

/** Checks the signature, and optionally that it's by one particular key. */
export function verifyPackage(pkg: ExtensionPackage, expectKeyId?: string): VerifyOutcome {
  const check = verifySignature(pkg);
  if (!check.ok) {
    return {
      ok: false,
      reason: pkg.signature
        ? check.reason
        : "The package isn't signed. Sling installs unsigned packages only when the server runs with SLING_ALLOW_UNSIGNED_EXTENSIONS=1.",
    };
  }
  const want = expectKeyId?.replace(/\s+/g, "").toLowerCase();
  if (want && want !== check.keyId) {
    return {
      ok: false,
      reason: `It's signed by ${formatFingerprint(check.keyId)}, not ${formatFingerprint(want)}.`,
    };
  }
  return { ok: true, keyId: check.keyId, publisher: check.publisher };
}
