import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  type ExtensionManifest,
  ExtensionManifestSchema,
  type PackageSignature,
  PackageSignatureSchema,
  signedMessage,
} from "@sling/connector-sdk";
import { comparePaths, PackageError, readTar, writeTar } from "./tar.ts";

export const MANIFEST_FILE = "sling-extension.json";
export const SIGNATURE_FILE = "SIGNATURE.json";

export interface PackageLimits {
  /** The `.slx` file itself. */
  maxCompressed: number;
  /** Every file's contents added up. */
  maxUnpacked: number;
  maxFiles: number;
  maxPathLength: number;
}

export const LIMITS: PackageLimits = {
  maxCompressed: 20 * 1024 * 1024,
  maxUnpacked: 50 * 1024 * 1024,
  maxFiles: 2000,
  maxPathLength: 200,
};

export interface ExtensionPackage {
  manifest: ExtensionManifest;
  /** Every file but `SIGNATURE.json`. */
  files: Map<string, Uint8Array>;
  /** `sha256:<hex>` over the files, see `computeDigest`. */
  digest: string;
  signature: PackageSignature | null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * SHA-256 over one line per file, sorted by path: `<path>\0<sha256 hex>\n`.
 * `SIGNATURE.json` is left out, so signing doesn't change the digest, and
 * neither do tar metadata or compression.
 */
export function computeDigest(files: Map<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort(comparePaths)) {
    if (path === SIGNATURE_FILE) continue;
    hash.update(`${path}\0${sha256Hex(files.get(path) as Uint8Array)}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function parseJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(dec.decode(bytes));
  } catch {
    throw new PackageError("bad_manifest", `${what} isn't valid JSON`);
  }
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "value"}: ${i.message}`)
    .join("; ");
}

/** Reads the manifest and checks every file it points at is there. */
export function parseManifest(files: Map<string, Uint8Array>): ExtensionManifest {
  const raw = files.get(MANIFEST_FILE);
  if (!raw) throw new PackageError("no_manifest", `The package has no ${MANIFEST_FILE}`);
  const parsed = ExtensionManifestSchema.safeParse(parseJson(raw, MANIFEST_FILE));
  if (!parsed.success) {
    throw new PackageError("bad_manifest", `${MANIFEST_FILE}: ${issues(parsed.error)}`);
  }
  const m = parsed.data;
  if (m.main && !files.has(m.main)) {
    throw new PackageError("bad_manifest", `main names ${m.main}, which isn't in the package`);
  }
  if (m.icon && !files.has(m.icon)) {
    throw new PackageError("bad_manifest", `icon names ${m.icon}, which isn't in the package`);
  }
  for (const key of m.templates) {
    for (const f of ["template.json", "workflow.json"]) {
      if (!files.has(`templates/${key}/${f}`)) {
        throw new PackageError("bad_manifest", `Template ${key} has no ${f}`);
      }
    }
  }
  return m;
}

/** Unpacks and checks a `.slx`. Doesn't decide trust: see `verifySignature`. */
export function readPackage(bytes: Uint8Array, limits: PackageLimits = LIMITS): ExtensionPackage {
  if (bytes.length > limits.maxCompressed) {
    throw new PackageError(
      "too_large",
      `The package is over ${Math.round(limits.maxCompressed / 1024 / 1024)} MB`,
    );
  }
  let tar: Uint8Array;
  try {
    // Headers and padding add at most a block and a half per file.
    tar = gunzipSync(bytes, { maxOutputLength: limits.maxUnpacked + (limits.maxFiles + 2) * 1024 });
  } catch (err) {
    const tooBig = (err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE";
    throw new PackageError(
      tooBig ? "too_large" : "bad_archive",
      tooBig ? "The package is too large unpacked" : "The package isn't a gzipped tar",
    );
  }
  const all = readTar(tar, {
    maxFiles: limits.maxFiles,
    maxBytes: limits.maxUnpacked,
    maxPathLength: limits.maxPathLength,
  });
  let signature: PackageSignature | null = null;
  const sig = all.get(SIGNATURE_FILE);
  if (sig) {
    const parsed = PackageSignatureSchema.safeParse(parseJson(sig, SIGNATURE_FILE));
    if (!parsed.success) {
      throw new PackageError("bad_signature", `${SIGNATURE_FILE}: ${issues(parsed.error)}`);
    }
    signature = parsed.data;
    all.delete(SIGNATURE_FILE);
  }
  const manifest = parseManifest(all);
  return { manifest, files: all, digest: computeDigest(all), signature };
}

/** A gzipped tar of the files, plus `SIGNATURE.json` when given. Same files, same bytes. */
export function writePackage(
  files: Map<string, Uint8Array>,
  signature: PackageSignature | null = null,
): Uint8Array {
  const all = new Map(files);
  all.delete(SIGNATURE_FILE);
  if (signature) all.set(SIGNATURE_FILE, enc.encode(`${JSON.stringify(signature, null, 2)}\n`));
  const gz = gzipSync(writeTar(all), { level: 9 });
  // The OS byte in the gzip header varies by platform; pin it to Unix.
  gz[9] = 3;
  return new Uint8Array(gz.buffer, gz.byteOffset, gz.length);
}

// --------------------------------------------------------------- keys

export interface SigningKey {
  format: "sling.signing-key/v1";
  keyId: string;
  /** Raw 32-byte Ed25519 public key, base64. */
  publicKey: string;
  /** PKCS #8 DER, base64. Keep it secret. */
  privateKey: string;
  publisher: string;
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** First 16 hex characters of the SHA-256 of the raw public key. */
export function keyIdOf(publicKey: string): string {
  return sha256Hex(Buffer.from(publicKey, "base64")).slice(0, 16);
}

function publicKeyObject(publicKey: string): KeyObject {
  const raw = Buffer.from(publicKey, "base64");
  if (raw.length !== 32) throw new PackageError("bad_signature", "The public key isn't 32 bytes");
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function generateSigningKey(publisher: string): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(SPKI_ED25519_PREFIX.length);
  const pub = Buffer.from(raw).toString("base64");
  return {
    format: "sling.signing-key/v1",
    keyId: keyIdOf(pub),
    publicKey: pub,
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publisher,
  };
}

/** The `SIGNATURE.json` for a package, signed with `key`. */
export function signPackage(
  pkg: Pick<ExtensionPackage, "manifest" | "digest">,
  key: SigningKey,
): PackageSignature {
  const privateKey = createPrivateKey({
    key: Buffer.from(key.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const message = signedMessage(pkg.manifest.id, pkg.manifest.version, pkg.digest);
  return {
    format: "sling.signature/v1",
    keyId: key.keyId,
    publicKey: key.publicKey,
    publisher: key.publisher,
    signature: sign(null, message, privateKey).toString("base64"),
  };
}

export type SignatureCheck =
  | { ok: true; keyId: string; publicKey: string; publisher: string }
  | { ok: false; reason: string };

/**
 * Checks the signature matches the package's ID, version, and digest, and the
 * key ID matches the key. Whether that key is trusted is the caller's call.
 */
export function verifySignature(pkg: ExtensionPackage): SignatureCheck {
  const s = pkg.signature;
  if (!s) return { ok: false, reason: "The package isn't signed" };
  if (keyIdOf(s.publicKey) !== s.keyId) {
    return { ok: false, reason: "The signature's key ID doesn't match its key" };
  }
  let good = false;
  try {
    good = verify(
      null,
      signedMessage(pkg.manifest.id, pkg.manifest.version, pkg.digest),
      publicKeyObject(s.publicKey),
      Buffer.from(s.signature, "base64"),
    );
  } catch {
    good = false;
  }
  if (!good) {
    return {
      ok: false,
      reason: "The signature doesn't match the package. Its files changed after it was signed",
    };
  }
  return { ok: true, keyId: s.keyId, publicKey: s.publicKey, publisher: s.publisher };
}

/** Writes the files under `dir`, which should be new and empty. */
export async function unpackTo(files: Map<string, Uint8Array>, dir: string): Promise<void> {
  const made = new Set<string>();
  for (const [path, data] of files) {
    const target = join(dir, path);
    const parent = dirname(target);
    if (!made.has(parent)) {
      await mkdir(parent, { recursive: true });
      made.add(parent);
    }
    await writeFile(target, data, { mode: 0o644, flag: "wx" });
  }
}

/** Reads `sling-extension.json`-relative text, such as the README. */
export function fileText(files: Map<string, Uint8Array>, path: string): string | null {
  const f = files.get(path);
  return f ? dec.decode(f) : null;
}
