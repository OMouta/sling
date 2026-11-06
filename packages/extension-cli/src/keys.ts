/** Signing keys on disk: `sling-ext keygen` writes them, `pack --sign` and `sign` read them. */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { generateSigningKey, keyIdOf, type SigningKey } from "@sling/extension-package";
import { z } from "zod";
import { zodIssues } from "./project.ts";
import { CliError, errorMessage } from "./util.ts";

const SigningKeySchema = z.object({
  format: z.literal("sling.signing-key/v1"),
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  publisher: z.string().trim().min(1).max(80),
});

/** Writes a new key with mode 0600. Refuses to replace an existing file. */
export async function writeNewKey(path: string, publisher: string): Promise<SigningKey> {
  const key = generateSigningKey(publisher);
  try {
    await writeFile(path, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      throw new CliError(`${path} already exists. Pick another file with --out.`);
    }
    throw error;
  }
  // The umask can only remove bits, but set it outright in case the file system ignores mode.
  await chmod(path, 0o600);
  return key;
}

export interface LoadedKey {
  key: SigningKey;
  /** Set when other users can read the file. */
  warning: string | null;
}

export async function readKey(path: string): Promise<LoadedKey> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CliError(`Couldn't read the key ${path}: ${errorMessage(error)}`);
  }
  const parsed = SigningKeySchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      `${path} isn't a sling-ext signing key: ${zodIssues(parsed.error).join("; ")}`,
    );
  }
  const key = parsed.data;
  if (keyIdOf(key.publicKey) !== key.keyId) {
    throw new CliError(`${path}: the keyId doesn't match the public key.`);
  }
  try {
    const derived = createPublicKey(
      createPrivateKey({
        key: Buffer.from(key.privateKey, "base64"),
        format: "der",
        type: "pkcs8",
      }),
    )
      .export({ format: "der", type: "spki" })
      .subarray(-32);
    if (Buffer.from(derived).toString("base64") !== key.publicKey) {
      throw new CliError(`${path}: the private key doesn't match the public key.`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`${path}: the private key isn't a valid Ed25519 key.`);
  }
  let warning: string | null = null;
  if (process.platform !== "win32") {
    const mode = (await stat(path)).mode & 0o777;
    if (mode & 0o077) {
      warning = `${path} can be read by other users on this machine (mode ${mode.toString(8)}). Run chmod 600 ${path}.`;
    }
  }
  return { key, warning };
}
