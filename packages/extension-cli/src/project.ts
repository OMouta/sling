/**
 * An extension project on disk: a directory with `sling-extension.json`, the
 * source, and the files that go into the package.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ExtensionManifest, ExtensionManifestSchema } from "@sling/connector-sdk";
import { MANIFEST_FILE } from "@sling/extension-package";
import { CliError } from "./util.ts";

export interface Project {
  dir: string;
  manifest: ExtensionManifest;
}

/** Issues from a zod error, one per line. */
export function zodIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((i) => `${i.path.map(String).join(".") || "value"}: ${i.message}`);
}

async function readOptional(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

export async function loadProject(dir: string): Promise<Project> {
  const root = resolve(dir);
  const raw = await readOptional(join(root, MANIFEST_FILE));
  if (!raw) {
    throw new CliError(
      `There's no ${MANIFEST_FILE} in ${root}. Run this in an extension's folder, or start one with sling-ext init <dir>.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    throw new CliError(`${MANIFEST_FILE} isn't valid JSON: ${(error as Error).message}`);
  }
  const parsed = ExtensionManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      `${MANIFEST_FILE} has problems:\n${zodIssues(parsed.error)
        .map((l) => `  ${l}`)
        .join("\n")}`,
    );
  }
  return { dir: root, manifest: parsed.data };
}

export interface CollectedFiles {
  files: Map<string, Uint8Array>;
  /** Files the manifest names that aren't there, with what to do about it. */
  missing: string[];
}

/**
 * The files that go into the package: the manifest, the bundle, the README,
 * the icon, and each template. Nothing else in the folder is included.
 */
export async function collectFiles(project: Project): Promise<CollectedFiles> {
  const { dir, manifest } = project;
  const files = new Map<string, Uint8Array>();
  const missing: string[] = [];
  const add = async (path: string, ifMissing: string | null) => {
    const data = await readOptional(join(dir, path));
    if (data) files.set(path, data);
    else if (ifMissing) missing.push(ifMissing);
  };
  await add(MANIFEST_FILE, null);
  if (manifest.main) {
    await add(manifest.main, `${manifest.main} isn't built yet. Run sling-ext build.`);
  }
  await add("README.md", null);
  if (manifest.icon) await add(manifest.icon, `The icon ${manifest.icon} isn't there.`);
  for (const key of manifest.templates) {
    for (const name of ["template.json", "workflow.json"]) {
      const path = `templates/${key}/${name}`;
      await add(path, `Template ${key} has no ${path}.`);
    }
  }
  return { files, missing };
}
