/**
 * Builds the catalog that ships with Sling: bundles and packs every example
 * extension in this folder, unsigned, into extensions/dist with a
 * catalog.json. The server reads that folder from SLING_INCLUDED_EXTENSIONS.
 *
 *   pnpm extensions:build
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProject,
  loadProject,
  packProject,
  writeCatalog,
} from "../packages/extension-cli/src/index.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = join(HERE, "dist");

const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
const started = performance.now();

await rm(OUT, { recursive: true, force: true });
const dirs: string[] = [];
for (const entry of (await readdir(HERE, { withFileTypes: true })).sort((a, b) =>
  a.name.localeCompare(b.name),
)) {
  if (!entry.isDirectory() || entry.name === "dist") continue;
  const ok = await stat(join(HERE, entry.name, "sling-extension.json")).catch(() => null);
  if (ok) dirs.push(join(HERE, entry.name));
}

for (const dir of dirs) {
  const project = await loadProject(dir);
  const built = await buildProject(project);
  const packed = await packProject(project, { outDir: OUT });
  const m = project.manifest;
  console.log(
    `${m.id} ${m.version}: ${built ? `bundle ${kb(built.bytes)}, ` : ""}package ${kb(packed.bytes.length)}`,
  );
}

const { catalog, path } = await writeCatalog(OUT, { name: "Included with Sling" });
console.log(
  `Wrote ${path} with ${catalog.extensions.length} extensions in ${Math.round(performance.now() - started)} ms`,
);
