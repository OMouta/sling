import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  computeDigest,
  generateSigningKey,
  keyIdOf,
  readPackage,
  SIGNATURE_FILE,
  signPackage,
  unpackTo,
  verifySignature,
  writePackage,
} from "./index.ts";
import { writeTar } from "./tar.ts";

const enc = new TextEncoder();

function files(over: Record<string, string> = {}, manifest: Record<string, unknown> = {}) {
  const m = new Map<string, Uint8Array>();
  m.set(
    "sling-extension.json",
    enc.encode(
      JSON.stringify({
        format: "sling.extension/v1",
        id: "acme",
        name: "Acme",
        version: "1.0.0",
        publisher: "Acme",
        sdk: "^1.0.0",
        main: "extension.mjs",
        ...manifest,
      }),
    ),
  );
  m.set("extension.mjs", enc.encode("export default {};\n"));
  m.set("README.md", enc.encode("# Acme\n"));
  for (const [k, v] of Object.entries(over)) m.set(k, enc.encode(v));
  return m;
}

describe("packages", () => {
  it("round-trips, with the same bytes every time", () => {
    const a = writePackage(files());
    const b = writePackage(files());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const pkg = readPackage(a);
    expect(pkg.manifest.id).toBe("acme");
    expect([...pkg.files.keys()].sort()).toEqual([
      "README.md",
      "extension.mjs",
      "sling-extension.json",
    ]);
    expect(pkg.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pkg.signature).toBeNull();
  });

  it("keeps the digest when signed, and changes it when a file changes", () => {
    const key = generateSigningKey("Acme");
    const pkg = readPackage(writePackage(files()));
    const signed = readPackage(writePackage(pkg.files, signPackage(pkg, key)));
    expect(signed.digest).toBe(pkg.digest);
    expect(verifySignature(signed)).toMatchObject({
      ok: true,
      keyId: key.keyId,
      publisher: "Acme",
    });
    expect(keyIdOf(key.publicKey)).toBe(key.keyId);

    const tampered = new Map(signed.files);
    tampered.set("extension.mjs", enc.encode("export default { evil: true };\n"));
    const t = readPackage(writePackage(tampered, signed.signature));
    expect(t.digest).not.toBe(pkg.digest);
    expect(verifySignature(t)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/changed after/),
    });
  });

  it("binds the signature to the ID and version", () => {
    const key = generateSigningKey("Acme");
    const pkg = readPackage(writePackage(files()));
    const sig = signPackage(pkg, key);
    const bumped = readPackage(writePackage(files({}, { version: "1.0.1" }), sig));
    expect(verifySignature(bumped).ok).toBe(false);
  });

  it("refuses a signature whose key ID isn't its key", () => {
    const a = generateSigningKey("A");
    const b = generateSigningKey("B");
    const pkg = readPackage(writePackage(files()));
    const sig = { ...signPackage(pkg, a), keyId: b.keyId };
    expect(verifySignature(readPackage(writePackage(pkg.files, sig)))).toMatchObject({ ok: false });
  });

  it("matches a tar made by the system tar, apart from metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "slx-"));
    const f = files(
      { "templates/x/template.json": "{}", "templates/x/workflow.json": "{}" },
      { templates: ["x"] },
    );
    for (const [p, d] of f) {
      execFileSync("mkdir", ["-p", join(dir, p, "..")]);
      writeFileSync(join(dir, p), d);
    }
    const out = join(dir, "..", `${Date.now()}.tgz`);
    execFileSync("tar", ["-czf", out, "-C", dir, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const pkg = readPackage(readFileSync(out));
    expect(pkg.digest).toBe(computeDigest(f));
  });

  it("unpacks to a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slx-out-"));
    const pkg = readPackage(writePackage(files({ "lib/a/b.txt": "hi" })));
    await unpackTo(pkg.files, dir);
    expect(readFileSync(join(dir, "lib/a/b.txt"), "utf8")).toBe("hi");
  });
});

describe("refusals", () => {
  const gz = (tar: Uint8Array) => gzipSync(tar);

  it("refuses unsafe paths", () => {
    for (const bad of ["../evil", "/etc/passwd", "a/../../b", "a//b", "C:/x"]) {
      const f = files();
      f.set(bad, enc.encode("x"));
      expect(() => readPackage(gz(writeTar(f))), bad).toThrow(/unsafe path/);
    }
  });

  it("refuses symlinks", () => {
    const tar = writeTar(files());
    // Turn the first entry into a symlink and fix its checksum.
    const h = tar.subarray(0, 512);
    h[156] = 0x32;
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    expect(() => readPackage(gz(tar))).toThrow(/link or special file/);
  });

  it("refuses packages over the limits", () => {
    const f = files({ "big.bin": "x".repeat(2000) });
    const limits = { maxCompressed: 1e6, maxUnpacked: 1000, maxFiles: 10, maxPathLength: 200 };
    expect(() => readPackage(writePackage(f), limits)).toThrow(/too large|over/);
    const many = files();
    for (let i = 0; i < 20; i++) many.set(`f${i}`, enc.encode("x"));
    expect(() => readPackage(writePackage(many), { ...limits, maxUnpacked: 1e6 })).toThrow(
      /more than 10/,
    );
    expect(() => readPackage(writePackage(files()), { ...limits, maxCompressed: 10 })).toThrow(
      /over/,
    );
  });

  it("refuses a missing manifest, main, or template", () => {
    const f = files();
    f.delete("sling-extension.json");
    expect(() => readPackage(writePackage(f))).toThrow(/no sling-extension.json/);
    const noMain = files();
    noMain.delete("extension.mjs");
    expect(() => readPackage(writePackage(noMain))).toThrow(/main names/);
    expect(() => readPackage(writePackage(files({}, { templates: ["t"] })))).toThrow(/Template t/);
    expect(() => readPackage(enc.encode("not gzip"))).toThrow(/gzipped tar/);
  });

  it("refuses a broken signature file", () => {
    const f = files();
    f.set(SIGNATURE_FILE, enc.encode('{"format":"nope"}'));
    expect(() => readPackage(gz(writeTar(f)))).toThrow(/SIGNATURE.json/);
  });
});
