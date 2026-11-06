/**
 * The whole publishing flow, run the way an outside developer runs it: from a
 * temporary folder outside the repo, with no node_modules, calling the CLI as
 * a command.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CatalogSchema } from "@sling/connector-sdk";
import { readPackage, verifySignature } from "@sling/extension-package";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TSC = join(REPO, "node_modules/.bin/tsc");

let root: string;

function run(cwd: string, command: string, args: string[] = []) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function slingExt(cwd: string, ...args: string[]) {
  return run(cwd, process.execPath, [MAIN, ...args]);
}

/** Runs a step and fails the test with its output when it exits non-zero. */
function ok(result: { code: number | null; out: string }): string {
  if (result.code !== 0) throw new Error(`exit ${result.code}:\n${result.out}`);
  return result.out;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sling-ext-e2e-")));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sling-ext outside the repo", () => {
  it("runs in a folder that isn't inside the repo", () => {
    expect(root.startsWith(REPO)).toBe(false);
  });

  it("starts, builds, checks, tests, signs, verifies, and catalogs three extensions", async () => {
    const catalogDir = join(root, "catalog");

    // A signing key, with mode 0600.
    const keyOut = ok(slingExt(root, "keygen", "--out", "key.json", "--publisher", "Acme"));
    expect(keyOut).toMatch(/Fingerprint: [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}/);
    expect((await stat(join(root, "key.json"))).mode & 0o777).toBe(0o600);
    const key = JSON.parse(await readFile(join(root, "key.json"), "utf8")) as { keyId: string };

    for (const kind of ["connector", "provider", "workflows"]) {
      const id = `acme-${kind}`;
      ok(slingExt(root, "init", id, "--kind", kind, "--publisher", "Acme"));
      const dir = join(root, id);
      expect(await stat(join(dir, "node_modules")).catch(() => null)).toBeNull();

      const built = ok(slingExt(dir, "build"));
      if (kind === "workflows") {
        expect(built).toContain("Nothing to build");
      } else {
        expect(built).toMatch(/Built extension\.mjs: \d+\.\d kB/);
        // The editor setup points at the SDK that came with sling-ext.
        ok(run(dir, TSC, ["-p", "."]));
      }

      const checked = ok(slingExt(dir, "check"));
      expect(checked).toContain("No problems.");
      expect(checked).toContain(`Kinds: ${kind}`);

      // The starter's own test passes with plain node.
      const tested = ok(run(dir, process.execPath, ["--test"]));
      expect(tested).toMatch(/fail 0/);

      const packed = ok(slingExt(dir, "pack", "--sign", "../key.json", "--out", catalogDir));
      expect(packed).toContain(`Packed ${catalogDir}/${id}-0.1.0.slx`);
      expect(packed).toContain("Signed by Acme");

      const verified = ok(slingExt(root, "verify", join(catalogDir, `${id}-0.1.0.slx`)));
      expect(verified).toContain("Signature: good, by Acme");
      ok(slingExt(root, "verify", join(catalogDir, `${id}-0.1.0.slx`), "--fingerprint", key.keyId));
    }

    const cataloged = ok(slingExt(root, "catalog", "catalog", "--name", "Acme extensions"));
    expect(cataloged).toContain('"Acme extensions", 3 extensions, 3 versions, 1 publisher');

    const catalog = CatalogSchema.parse(
      JSON.parse(await readFile(join(catalogDir, "catalog.json"), "utf8")),
    );
    expect(catalog.publishers).toEqual([
      expect.objectContaining({ keyId: key.keyId, name: "Acme" }),
    ]);
    expect(
      Object.fromEntries(catalog.extensions.map((e) => [e.id, [e.kinds, e.publisher]])),
    ).toEqual({
      "acme-connector": [["connector"], key.keyId],
      "acme-provider": [["provider"], key.keyId],
      "acme-workflows": [["workflows"], key.keyId],
    });
    for (const entry of catalog.extensions) {
      const [v] = entry.versions;
      expect(v?.url).toBe(`${entry.id}-0.1.0.slx`);
      const bytes = new Uint8Array(await readFile(join(catalogDir, v?.url as string)));
      const pkg = readPackage(bytes);
      expect(v?.digest).toBe(pkg.digest);
      expect(v?.size).toBe(bytes.length);
      expect(verifySignature(pkg).ok).toBe(true);
    }
    const provider = catalog.extensions.find((e) => e.id === "acme-provider");
    expect(provider?.versions[0]?.permissions.sandboxes).toBe(true);
  });
});
