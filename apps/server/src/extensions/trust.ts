/**
 * Who may sign the packages this server installs. A publisher is trusted per
 * key, server-wide, and an installed extension stays pinned to the key that
 * signed it.
 */

import { formatFingerprint } from "@sling/connector-sdk/host";
import type { PublisherRef, PublisherView } from "@sling/core";
import { schema } from "@sling/db";
import type { ExtensionPackage } from "@sling/extension-package";
import { verifySignature } from "@sling/extension-package";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";

export interface Signer {
  keyId: string;
  publicKey: string;
  publisher: string;
}

export interface TrustInput {
  source: "included" | "catalog" | "upload";
  pkg: Pick<ExtensionPackage, "manifest" | "digest" | "signature">;
  /** Key ID the catalog entry names, for catalog installs. */
  catalogPublisher: string | null;
  allowUnsigned: boolean;
  isTrusted(keyId: string): boolean;
  /** The key the installed version is pinned to, when this would update it. */
  pinnedKeyId: string | null;
  /** Whether a version of this extension is installed. */
  installed: boolean;
}

export interface TrustResult {
  problems: string[];
  /** The verified signer. Null for unsigned packages and the included catalog's. */
  signer: Signer | null;
  /** Shown as signed. Included packages count: they ship with the server. */
  signed: boolean;
  /** The signer's key isn't trusted yet, so confirming must trust it. */
  needsTrust: boolean;
}

const fp = formatFingerprint;

/** Decides whether a package's origin and signature let it be installed. */
export function assessTrust(input: TrustInput): TrustResult {
  if (input.source === "included") {
    return { problems: [], signer: null, signed: true, needsTrust: false };
  }
  const problems: string[] = [];
  if (!input.pkg.signature) {
    if (!input.allowUnsigned) {
      problems.push("The package isn't signed. This server only installs signed packages.");
    }
    if (input.catalogPublisher) {
      problems.push(
        `The catalog says ${fp(input.catalogPublisher)} signs this package, but it isn't signed.`,
      );
    }
    if (input.pinnedKeyId) {
      problems.push(
        `The installed version is signed by ${fp(input.pinnedKeyId)}, and this package isn't signed. To switch, remove the extension and install it again.`,
      );
    }
    return { problems, signer: null, signed: false, needsTrust: false };
  }
  const check = verifySignature(input.pkg as ExtensionPackage);
  if (!check.ok) {
    problems.push(`${check.reason}.`);
    return { problems, signer: null, signed: false, needsTrust: false };
  }
  const signer: Signer = {
    keyId: check.keyId,
    publicKey: check.publicKey,
    publisher: check.publisher,
  };
  if (input.catalogPublisher && input.catalogPublisher !== signer.keyId) {
    problems.push(
      `The package is signed by ${fp(signer.keyId)}, but the catalog lists ${fp(input.catalogPublisher)} as its publisher.`,
    );
  }
  if (input.installed && input.pinnedKeyId && input.pinnedKeyId !== signer.keyId) {
    problems.push(
      `This package is signed by a different key than the installed version (${fp(signer.keyId)} instead of ${fp(input.pinnedKeyId)}). To switch keys, remove the extension and install it again.`,
    );
  }
  return { problems, signer, signed: true, needsTrust: !input.isTrusted(signer.keyId) };
}

type PublisherRow = typeof schema.extensionPublishers.$inferSelect;

/** Trusted keys, cached in memory: every preview and discover listing reads them. */
export class PublisherStore {
  readonly #ctx: AppContext;
  #rows = new Map<string, PublisherRow>();

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async load(): Promise<void> {
    const rows = await this.#ctx.db.select().from(schema.extensionPublishers);
    this.#rows = new Map(rows.map((r) => [r.keyId, r]));
  }

  isTrusted(keyId: string): boolean {
    return this.#rows.has(keyId);
  }

  /** Trusts a key. Returns false when it was already trusted. */
  async trust(signer: Signer, userId: string): Promise<boolean> {
    if (this.#rows.has(signer.keyId)) return false;
    const [row] = await this.#ctx.db
      .insert(schema.extensionPublishers)
      .values({
        keyId: signer.keyId,
        name: signer.publisher,
        publicKey: signer.publicKey,
        trustedBy: userId,
      })
      .onConflictDoNothing()
      .returning();
    if (row) this.#rows.set(row.keyId, row);
    else await this.load();
    return row !== undefined;
  }

  /** Stops trusting a key. Extensions it signed keep running. */
  async remove(keyId: string): Promise<PublisherRow | null> {
    const [row] = await this.#ctx.db
      .delete(schema.extensionPublishers)
      .where(eq(schema.extensionPublishers.keyId, keyId))
      .returning();
    this.#rows.delete(keyId);
    return row ?? null;
  }

  /** Trusted keys, with the installed extensions pinned to each. */
  list(pinned: ReadonlyMap<string, string[]>): PublisherView[] {
    return [...this.#rows.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || a.keyId.localeCompare(b.keyId))
      .map((r) => ({
        keyId: r.keyId,
        name: r.name,
        fingerprint: formatFingerprint(r.keyId),
        trustedAt: r.trustedAt.toISOString(),
        extensions: [...(pinned.get(r.keyId) ?? [])].sort(),
      }));
  }

  ref(keyId: string, name: string): PublisherRef {
    return { keyId, name, fingerprint: formatFingerprint(keyId), trusted: this.isTrusted(keyId) };
  }
}
