/**
 * Builds extension packages for tests: bundles a TypeScript module that
 * default-exports `defineExtension(...)`, writes a manifest, and packs it,
 * optionally signed.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionManifestInput } from "@sling/connector-sdk";
import {
  computeDigest,
  type ExtensionPackage,
  generateSigningKey,
  readPackage,
  type SigningKey,
  signPackage,
  unpackTo,
  writePackage,
} from "@sling/extension-package";
import { build } from "esbuild";

const FIXTURES = fileURLToPath(new URL(".", import.meta.url));
const enc = new TextEncoder();

export interface FixtureTemplate {
  template: Record<string, unknown>;
  workflow: Record<string, unknown>;
}

export interface FixtureOptions {
  id: string;
  version?: string;
  /**
   * TypeScript source of the extension's entry. It can import
   * `@sling/connector-sdk` and `zod`. Omit for a workflow package.
   */
  source?: string;
  manifest?: Partial<ExtensionManifestInput>;
  templates?: Record<string, FixtureTemplate>;
  files?: Record<string, string>;
  /** Signs the package with this key. */
  key?: SigningKey;
}

export interface BuiltExtension {
  bytes: Uint8Array;
  pkg: ExtensionPackage;
  digest: string;
}

/** Bundles source the way `sling-ext build` does: ESM, Node 26, every dependency inline. */
export async function bundle(source: string): Promise<string> {
  const out = await build({
    stdin: { contents: source, resolveDir: FIXTURES, loader: "ts", sourcefile: "extension.ts" },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node26",
    write: false,
    logLevel: "silent",
  });
  return out.outputFiles[0]?.text ?? "";
}

export async function buildExtension(opts: FixtureOptions): Promise<BuiltExtension> {
  const files = new Map<string, Uint8Array>();
  const manifest: ExtensionManifestInput = {
    format: "sling.extension/v1",
    id: opts.id,
    name: opts.manifest?.name ?? opts.id,
    version: opts.version ?? "1.0.0",
    publisher: opts.key?.publisher ?? "Tests",
    sdk: "^1.0.0",
    ...(opts.source !== undefined ? { main: "extension.mjs" } : {}),
    templates: Object.keys(opts.templates ?? {}),
    ...opts.manifest,
  };
  files.set("sling-extension.json", enc.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  if (opts.source !== undefined) files.set("extension.mjs", enc.encode(await bundle(opts.source)));
  files.set("README.md", enc.encode(`# ${manifest.name}\n\nA test extension.\n`));
  for (const [key, t] of Object.entries(opts.templates ?? {})) {
    files.set(`templates/${key}/template.json`, enc.encode(JSON.stringify(t.template)));
    files.set(`templates/${key}/workflow.json`, enc.encode(JSON.stringify(t.workflow)));
  }
  for (const [path, text] of Object.entries(opts.files ?? {})) files.set(path, enc.encode(text));
  const digest = computeDigest(files);
  const unsigned = readPackage(writePackage(files));
  const bytes = opts.key
    ? writePackage(files, signPackage(unsigned, opts.key))
    : writePackage(files);
  return { bytes, pkg: readPackage(bytes), digest };
}

/** Unpacks a built package into a fresh temp directory, as the extension service does. */
export async function unpackFixture(built: BuiltExtension): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `sling-ext-${built.pkg.manifest.id}-`));
  await unpackTo(built.pkg.files, dir);
  return dir;
}

export { generateSigningKey };
