import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogSchema } from "@sling/connector-sdk";
import {
  computeDigest,
  generateSigningKey,
  readPackage,
  writePackage,
} from "@sling/extension-package";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArgs } from "./args.ts";
import { buildProject } from "./build.ts";
import { writeCatalog } from "./catalog.ts";
import { checkFiles } from "./check.ts";
import { runCli } from "./commands.ts";
import { idFromName, initProject } from "./init.ts";
import { readKey, writeNewKey } from "./keys.ts";
import { packProject, signBytes, verifyPackage } from "./pack.ts";
import { collectFiles, loadProject } from "./project.ts";
import type { StarterKind } from "./starters.ts";
import { CliError } from "./util.ts";

let root: string;
let n = 0;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sling-ext-unit-")));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const fresh = () => join(root, `p${++n}`);

/** A starter project, optionally with its source replaced, built. */
async function project(
  kind: StarterKind = "connector",
  options: { id?: string; source?: string; manifest?: Record<string, unknown> } = {},
) {
  const { dir } = await initProject(fresh(), { kind, id: options.id ?? "acme", publisher: "Acme" });
  if (options.source) await writeFile(join(dir, "src/index.ts"), options.source);
  if (options.manifest) {
    const path = join(dir, "sling-extension.json");
    const m = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...m, ...options.manifest }));
  }
  const p = await loadProject(dir);
  await buildProject(p);
  return p;
}

async function check(p: Awaited<ReturnType<typeof project>>) {
  const { files } = await collectFiles(p);
  return checkFiles(files);
}

function capture() {
  const lines: string[] = [];
  const out = { out: (l = "") => lines.push(l), err: (l = "") => lines.push(l) };
  return { lines, out, text: () => lines.join("\n") };
}

const extensionSource = (body: string) => `
import { defineConnector, defineExtension, defineNode } from "@sling/connector-sdk";
import { z } from "zod";
${body}
`;

describe("arguments", () => {
  it("reads positionals, values, switches, and --", () => {
    const a = parseArgs(
      ["x", "--out", "k.json", "--name=A b", "--no-minify", "--", "--y"],
      new Set(["no-minify"]),
    );
    expect(a.positional).toEqual(["x", "--y"]);
    expect(Object.fromEntries(a.flags)).toEqual({ out: "k.json", name: "A b", "no-minify": true });
  });

  it("refuses a flag without its value, and unknown flags", async () => {
    expect(() => parseArgs(["--out"])).toThrow(/needs a value/);
    const { out } = capture();
    await expect(runCli(["keygen", "--bogus", "x"], { cwd: root, out })).rejects.toThrow(
      /Unknown option --bogus/,
    );
  });

  it("turns folder names into IDs", () => {
    expect(idFromName("My Extension!")).toBe("my-extension");
    expect(idFromName("2fa-helper")).toBe("fa-helper");
  });
});

describe("check", () => {
  it("passes each starter as it is", async () => {
    for (const kind of ["connector", "provider", "workflows"] as const) {
      const report = await check(await project(kind));
      expect(report.problems).toEqual([]);
      expect(report.kinds).toEqual([kind]);
    }
  });

  it("refuses names outside the extension's ID", async () => {
    const p = await project("connector", {
      source: extensionSource(`
const node = defineNode({
  type: "other.send", version: 1, title: "Send", description: "", category: "action",
  configSchema: z.object({}), inputs: [], outputs: [], execInput: true,
  execOutputs: [{ name: "next" }], idempotent: false, run: async () => ({ exec: "next" }),
});
export default defineExtension({ connectors: [defineConnector({
  id: "other", name: "Other", description: "", credentialsSchema: z.object({}), secretFields: [],
  configSchema: z.object({ url: z.string() }), test: async () => ({ ok: true }), nodes: [node],
})] });`),
    });
    const report = await check(p);
    expect(report.problems).toEqual([
      "Connector other must be named acme or start with acme.",
      "Node other.send must start with acme.",
    ]);
  });

  it("refuses a provider without the sandboxes permission", async () => {
    const p = await project("provider", {
      manifest: { permissions: { network: { configHosts: ["apiUrl"] } } },
    });
    const report = await check(p);
    expect(report.problems).toEqual([
      "Connector acme provides sandboxes, which needs the sandboxes permission.",
    ]);
  });

  it("runs the bundle without file access, as Sling does", async () => {
    const p = await project("connector", {
      source: `import { readFileSync } from "node:fs";\nreadFileSync("/etc/hosts");\nexport default {};`,
    });
    const report = await check(p);
    expect(report.problems.join("\n")).toMatch(
      /Running the bundle failed: Error: Access to this API has been restricted/,
    );
  });

  it("runs the bundle with an empty environment and no code generation", async () => {
    const p = await project("connector", {
      source: extensionSource(`
console.log("HOME=" + process.env.HOME);
let evalWorks = true;
try { new Function("return 1"); } catch { evalWorks = false; }
console.log("eval=" + evalWorks);
export default defineExtension({ connectors: [] });`),
    });
    const report = await check(p);
    expect(report.output).toEqual(["HOME=undefined", "eval=false"]);
    expect(report.problems).toEqual([
      "The package's code adds no connectors.",
      'configHosts names "url", which no connector\'s config has.',
    ]);
  });

  it("explains a bundle that doesn't export an extension", async () => {
    const p = await project("connector", { source: "export default 42;" });
    const report = await check(p);
    expect(report.problems[0]).toMatch(/default export isn't an extension/);
  });

  it("refuses an sdk range that leaves out this SDK", async () => {
    const report = await check(await project("connector", { manifest: { sdk: "^2.0.0" } }));
    expect(report.problems).toContain(
      'sdk is "^2.0.0", which doesn\'t include SDK 1.0.0. Use "^1.0.0".',
    );
  });

  it("warns about templates that use connectors the manifest doesn't require", async () => {
    const p = await project("workflows", { manifest: { requires: {} } });
    const report = await check(p);
    expect(report.problems).toEqual([]);
    expect(report.warnings).toEqual([
      'Template say-hello uses discord.send_message, which comes from the built-in discord connector. Add "discord" to requires.connectors.',
      'Template say-hello: binding $discord is for the discord connector, which comes from the built-in discord connector. Add "discord" to requires.connectors.',
    ]);
  });

  it("refuses a workflow package that asks for permissions", async () => {
    const p = await project("workflows", { manifest: { permissions: { approvals: true } } });
    expect((await check(p)).problems).toEqual([
      "A package without code can't ask for permissions.",
    ]);
  });
});

describe("build", () => {
  it("leaves zod's translations out and keeps English", async () => {
    const p = await project("connector", {
      source: extensionSource(`
export const fr = () => z.locales.fr();
export const message = () => z.string().safeParse(1).error?.issues[0]?.message;
export default defineExtension({ connectors: [] });`),
    });
    const bundle = join(p.dir, "extension.mjs");
    expect((await stat(bundle)).size).toBeLessThan(260_000);
    const mod = await import(bundle);
    expect(mod.message()).toMatch(/expected string/i);
    expect(() => mod.fr()).toThrow(/zod\/v4\/locales\/fr\.js/);
  });

  it("warns about Node modules an extension can't use", async () => {
    const p = await project("connector");
    await writeFile(
      join(p.dir, "src/index.ts"),
      `import { request } from "node:https";\nexport const r = request;\nexport default {};`,
    );
    const result = await buildProject(p);
    expect(result?.refused).toEqual(["node:https"]);
  });

  it("reports a failed build with the file and line", async () => {
    const p = await project("connector");
    await writeFile(join(p.dir, "src/index.ts"), `import "./missing.ts";`);
    await expect(buildProject(p)).rejects.toThrow(/src\/index\.ts:1: Could not resolve/);
  });
});

describe("keys", () => {
  it("writes keys with mode 0600 and refuses to overwrite one", async () => {
    const path = join(root, "k1.json");
    const key = await writeNewKey(path, "Acme");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readKey(path)).key).toEqual(key);
    await expect(writeNewKey(path, "Acme")).rejects.toThrow(/already exists/);
  });

  it("warns when other users can read the key, and refuses a mismatched one", async () => {
    const path = join(root, "k2.json");
    await writeNewKey(path, "Acme");
    await chmod(path, 0o644);
    expect((await readKey(path)).warning).toMatch(/chmod 600/);
    const other = generateSigningKey("Other");
    const key = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...key, privateKey: other.privateKey }));
    await expect(readKey(path)).rejects.toThrow(/private key doesn't match/);
  });
});

describe("pack, sign, and verify", () => {
  it("packs the same bytes every time, signed or not", async () => {
    const p = await project("connector");
    const key = generateSigningKey("Acme");
    const a = await packProject(p, { outDir: join(root, "out-a") });
    const b = await packProject(p, { outDir: join(root, "out-b") });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    const s1 = await packProject(p, { key, outDir: join(root, "out-c") });
    const s2 = await packProject(p, { key, outDir: join(root, "out-d") });
    expect(Buffer.from(s1.bytes).equals(Buffer.from(s2.bytes))).toBe(true);
    expect(s1.digest).toBe(a.digest);
    expect(readPackage(s1.bytes).files).toEqual(readPackage(a.bytes).files);
  });

  it("includes only the manifest, bundle, README, icon, and templates", async () => {
    const p = await project("connector");
    await writeFile(join(p.dir, "notes.txt"), "not shipped");
    const packed = await packProject(p);
    expect([...readPackage(packed.bytes).files.keys()].sort()).toEqual([
      "README.md",
      "extension.mjs",
      "icon.svg",
      "sling-extension.json",
    ]);
  });

  it("refuses to pack a project with problems, or one that isn't built", async () => {
    const p = await project("connector", { manifest: { sdk: "^9.0.0" } });
    await expect(packProject(p)).rejects.toThrow(/doesn't include SDK/);
    await rm(join(p.dir, "extension.mjs"));
    await expect(packProject(p)).rejects.toThrow(/isn't built yet. Run sling-ext build/);
  });

  it("signs, replaces a signature, and catches tampering and the wrong key", async () => {
    const p = await project("workflows");
    const first = generateSigningKey("First");
    const second = generateSigningKey("Second");
    const packed = await packProject(p, { key: first });
    const resigned = signBytes(readPackage(packed.bytes), second);
    expect(resigned.replaced).toBe(first.keyId);
    expect(verifyPackage(resigned.pkg)).toEqual({
      ok: true,
      keyId: second.keyId,
      publisher: "Second",
    });
    expect(verifyPackage(resigned.pkg, first.keyId)).toMatchObject({ ok: false });

    const tampered = new Map(resigned.pkg.files);
    tampered.set("README.md", new TextEncoder().encode("changed"));
    const bad = readPackage(writePackage(tampered, resigned.pkg.signature));
    expect(computeDigest(tampered)).not.toBe(resigned.pkg.digest);
    expect(verifyPackage(bad)).toEqual({
      ok: false,
      reason: "The signature doesn't match the package. Its files changed after it was signed",
    });
    expect(verifyPackage(readPackage(writePackage(tampered)))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/isn't signed/),
    });
  });

  it("verify exits non-zero for an unsigned package", async () => {
    const p = await project("workflows");
    const packed = await packProject(p);
    const { out, text } = capture();
    expect(await runCli(["verify", packed.path], { cwd: root, out })).toBe(1);
    expect(text()).toMatch(/SLING_ALLOW_UNSIGNED_EXTENSIONS=1/);
  });
});

describe("catalog", () => {
  async function shelf(versions: string[], key = generateSigningKey("Acme")) {
    const dir = fresh();
    for (const version of versions) {
      const p = await project("connector", { manifest: { version } });
      await packProject(p, { key, outDir: dir });
    }
    return { dir, key };
  }

  it("lists versions newest first, with relative URLs and the publisher", async () => {
    const { dir, key } = await shelf(["1.0.0", "1.2.0", "1.10.0"]);
    const { catalog } = await writeCatalog(dir, {
      name: "Acme",
      now: () => new Date("2026-11-06T10:00:00.123Z"),
    });
    expect(CatalogSchema.parse(catalog)).toEqual(catalog);
    expect(catalog.publishers).toEqual([
      { keyId: key.keyId, name: "Acme", publicKey: key.publicKey },
    ]);
    const [entry] = catalog.extensions;
    expect(entry?.versions.map((v) => [v.version, v.url, v.publishedAt])).toEqual([
      ["1.10.0", "acme-1.10.0.slx", "2026-11-06T10:00:00Z"],
      ["1.2.0", "acme-1.2.0.slx", "2026-11-06T10:00:00Z"],
      ["1.0.0", "acme-1.0.0.slx", "2026-11-06T10:00:00Z"],
    ]);
    expect(entry?.kinds).toEqual(["connector"]);
    expect(entry?.publisher).toBe(key.keyId);
  });

  it("revokes a version and keeps revocations and dates when run again", async () => {
    const { dir } = await shelf(["1.0.0", "1.1.0"]);
    await writeCatalog(dir, { name: "Acme", now: () => new Date("2026-01-01T00:00:00Z") });
    await writeCatalog(dir, {
      revoke: { id: "acme", version: "1.0.0", reason: "Leaks the token in its log" },
      now: () => new Date("2026-02-01T00:00:00Z"),
    });
    const { catalog } = await writeCatalog(dir, { now: () => new Date("2026-03-01T00:00:00Z") });
    expect(catalog.name).toBe("Acme");
    expect(
      catalog.extensions[0]?.versions.map((v) => [v.version, v.revoked, v.publishedAt]),
    ).toEqual([
      ["1.1.0", null, "2026-01-01T00:00:00Z"],
      ["1.0.0", { reason: "Leaks the token in its log" }, "2026-01-01T00:00:00Z"],
    ]);
    await expect(
      writeCatalog(dir, { revoke: { id: "acme", version: "9.9.9", reason: "x" } }),
    ).rejects.toThrow(/no acme 9.9.9/);
  });

  it("refuses versions signed by different keys", async () => {
    const { dir } = await shelf(["1.0.0"]);
    const p = await project("connector", { manifest: { version: "1.1.0" } });
    await packProject(p, { key: generateSigningKey("Mallory"), outDir: dir });
    await expect(writeCatalog(dir)).rejects.toThrow(/aren't all signed by one key/);
  });

  it("lists unsigned packages with no publisher", async () => {
    const dir = fresh();
    await packProject(await project("workflows", { id: "flows" }), { outDir: dir });
    const { catalog } = await writeCatalog(dir, { name: "Local" });
    expect(catalog.publishers).toEqual([]);
    expect(catalog.extensions[0]).toMatchObject({
      id: "flows",
      publisher: null,
      kinds: ["workflows"],
    });
  });

  it("refuses an empty folder", async () => {
    await expect(writeCatalog(root)).rejects.toThrow(CliError);
  });
});
