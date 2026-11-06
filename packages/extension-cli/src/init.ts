/** `sling-ext init`: a starter project that builds, checks, and packs as it is. */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID_PATTERN } from "@sling/connector-sdk";
import { packageJson, type StarterKind, starterFiles } from "./starters.ts";
import { CliError } from "./util.ts";

export const STARTER_KINDS: StarterKind[] = ["connector", "provider", "workflows"];

/** A directory name as an extension ID: `My Extension` becomes `my-extension`. */
export function idFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

function titleFromId(id: string): string {
  const words = id.split("-").filter(Boolean);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Where this CLI's SDK and zod live, for the project's editor types. The
 * build always uses these two from the CLI too, so the project needs no
 * dependencies.
 */
export function sdkPaths(): Record<string, string[]> {
  const sdk = fileURLToPath(import.meta.resolve("@sling/connector-sdk"));
  // zod's ES module entry is <package>/index.js, with its types beside it.
  const zod = dirname(fileURLToPath(import.meta.resolve("zod")));
  return {
    "@sling/connector-sdk": [sdk],
    zod: [join(zod, "index.d.ts")],
    "zod/*": [join(zod, "*", "index.d.ts")],
  };
}

function tsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "es2024",
        // Extensions get web APIs (fetch, WebSocket, crypto.subtle) and no Node modules.
        lib: ["es2024", "dom"],
        types: [],
        module: "preserve",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        skipLibCheck: true,
        // Written by sling-ext init: the SDK and zod that came with sling-ext.
        paths: sdkPaths(),
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`;
}

export interface InitOptions {
  kind?: StarterKind;
  id?: string;
  name?: string;
  publisher?: string;
}

export interface InitResult {
  dir: string;
  id: string;
  kind: StarterKind;
  files: string[];
}

export async function initProject(target: string, options: InitOptions = {}): Promise<InitResult> {
  const dir = resolve(target);
  const kind = options.kind ?? "connector";
  if (!STARTER_KINDS.includes(kind)) {
    throw new CliError(`--kind must be one of ${STARTER_KINDS.join(", ")}.`);
  }
  const id = options.id ?? idFromName(basename(dir));
  if (!EXTENSION_ID_PATTERN.test(id)) {
    throw new CliError(
      `"${id}" can't be an extension ID: use 3 to 40 lowercase letters, digits, and hyphens, starting with a letter. Pass one with --id.`,
    );
  }
  try {
    const existing = await readdir(dir);
    if (existing.length > 0) throw new CliError(`${dir} isn't empty. Pick a new folder.`);
  } catch (error) {
    if (error instanceof CliError) throw error;
  }
  const name = options.name ?? titleFromId(id);
  const publisher = options.publisher ?? userInfo().username;
  for (const [what, value] of [
    ["--name", name],
    ["--publisher", publisher],
  ]) {
    if (!value?.trim() || /["\\\n]/.test(value as string)) {
      throw new CliError(`${what} can't be empty or hold quotes, backslashes, or line breaks.`);
    }
  }
  const fill = (text: string) =>
    text
      .replaceAll("__ID__", id)
      .replaceAll("__NAME__", name)
      .replaceAll("__PUBLISHER__", publisher);

  const files: Record<string, string> = { ...starterFiles(kind), "package.json": packageJson(id) };
  if (kind !== "workflows") files["tsconfig.json"] = tsconfig();
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, path === "tsconfig.json" ? text : fill(text));
  }
  return { dir, id, kind, files: Object.keys(files).sort() };
}
