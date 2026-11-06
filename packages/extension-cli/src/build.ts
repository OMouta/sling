/**
 * `sling-ext build`: bundles `src/index.ts` and everything it imports into
 * the one ES module the manifest's `main` names.
 */
import { readFile, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";
import type { Project } from "./project.ts";
import { CliError } from "./util.ts";

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const SKIP = Symbol("sling-ext resolve");

/**
 * Builtins an extension can import but not use: its process has no files,
 * child processes, workers, sockets, or DNS of its own.
 */
const REFUSED_BUILTINS = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "dns/promises",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "net",
  "tls",
  "wasi",
  "worker_threads",
]);

const BUILTINS = new Set(builtinModules);

/**
 * Resolves the SDK and zod from this CLI's own installation, so a project
 * builds with no dependencies, the bundle holds one copy of zod, and every
 * extension built with this CLI gets the same SDK. A project's tsconfig paths
 * for these two are for the editor only.
 */
export function sdkResolver(): Plugin {
  return {
    name: "sling-sdk",
    setup(b) {
      b.onResolve({ filter: /^(@sling\/connector-sdk|zod)(\/.*)?$/ }, async (args) => {
        if (args.pluginData === SKIP) return undefined;
        const r = await b.resolve(args.path, {
          kind: args.kind,
          resolveDir: CLI_DIR,
          pluginData: SKIP,
        });
        if (r.errors.length > 0) return { errors: r.errors };
        return { path: r.path, namespace: r.namespace, external: r.external };
      });
    },
  };
}

/**
 * zod's `z` namespace carries every translation of its error messages, about
 * 260 kB minified, which no extension needs. This swaps zod's own import of
 * its locale index for one that keeps English and replaces the rest with
 * functions that say how to import a locale directly. Imports of a locale
 * file from the extension's own code are left alone.
 */
export function zodLocales(): Plugin {
  const namespace = "sling-zod-locales";
  return {
    name: namespace,
    setup(b) {
      b.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, (args) => {
        if (!/[\\/]zod[\\/]v4[\\/](classic|core)[\\/][^\\/]+\.js$/.test(args.importer)) {
          return undefined;
        }
        return { path: join(dirname(args.importer), "../locales/index.js"), namespace };
      });
      b.onLoad({ filter: /.*/, namespace }, async (args) => {
        const index = await readFile(args.path, "utf8");
        const names = [...index.matchAll(/default as (\w+) \} from "\.\/([\w-]+)\.js"/g)];
        const lines = names.map(([, name, file]) =>
          name === "en"
            ? `export { default as en } from "./${file}.js";`
            : `export const ${name} = leftOut(${JSON.stringify(file)});`,
        );
        return {
          resolveDir: dirname(args.path),
          loader: "js",
          contents: [
            "function leftOut(file) {",
            "  return () => {",
            '    throw new Error("sling-ext leaves zod\'s translations out of extension bundles. Import the one you need directly: import locale from \\"zod/v4/locales/" + file + ".js\\"");',
            "  };",
            "}",
            ...lines,
          ].join("\n"),
        };
      });
    },
  };
}

export interface BuildResult {
  outfile: string;
  bytes: number;
  ms: number;
  /** Node builtins the bundle imports that an extension can't use. */
  refused: string[];
}

function refusedImports(metafile: Metafile): string[] {
  const found = new Set<string>();
  for (const input of Object.values(metafile.inputs)) {
    for (const imp of input.imports) {
      if (!imp.external) continue;
      const name = imp.path.replace(/^node:/, "");
      if (BUILTINS.has(name) && REFUSED_BUILTINS.has(name)) found.add(`node:${name}`);
    }
  }
  return [...found].sort();
}

export interface BuildOptions {
  entry?: string;
  minify?: boolean;
}

export async function buildProject(
  project: Project,
  options: BuildOptions = {},
): Promise<BuildResult | null> {
  const { dir, manifest } = project;
  if (!manifest.main) return null;
  const entry = join(dir, options.entry ?? "src/index.ts");
  try {
    await stat(entry);
  } catch {
    throw new CliError(`There's no ${options.entry ?? "src/index.ts"} to build.`);
  }
  const outfile = join(dir, manifest.main);
  const started = performance.now();
  const result = await build({
    absWorkingDir: dir,
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node26",
    // ES modules tree-shake; prefer them when a package has both.
    mainFields: ["module", "main"],
    minify: options.minify ?? true,
    charset: "utf8",
    metafile: true,
    logLevel: "silent",
    plugins: [sdkResolver(), zodLocales()],
  }).catch((error: unknown) => {
    const errors = (
      error as { errors?: { text: string; location?: { file: string; line: number } | null }[] }
    ).errors;
    if (!errors?.length) throw error;
    const lines = errors.map((e) =>
      e.location ? `  ${e.location.file}:${e.location.line}: ${e.text}` : `  ${e.text}`,
    );
    throw new CliError(`The build failed:\n${lines.join("\n")}`);
  });
  const ms = Math.round(performance.now() - started);
  const bytes = (await stat(outfile)).size;
  return { outfile, bytes, ms, refused: refusedImports(result.metafile) };
}
