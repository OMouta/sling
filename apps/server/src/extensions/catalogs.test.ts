import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkSourceUrl, parseCatalog, readCapped, readIncludedCatalog } from "./catalogs.ts";
import { ExtensionError } from "./errors.ts";

describe("checkSourceUrl", () => {
  it("allows HTTPS", () => {
    expect(checkSourceUrl("https://example.com/catalog.json", false).href).toBe(
      "https://example.com/catalog.json",
    );
  });

  it("refuses other schemes and credentials in the URL", () => {
    for (const url of ["http://example.com/c.json", "ftp://example.com/c.json", "file:///c.json"]) {
      expect(() => checkSourceUrl(url, true)).toThrow("Catalogs must use HTTPS.");
    }
    expect(() => checkSourceUrl("https://me:pw@example.com/c.json", true)).toThrow(
      "Leave credentials out of the URL.",
    );
    expect(() => checkSourceUrl("not a url", true)).toThrow("That isn't a URL.");
  });

  it("allows plain HTTP to this machine only while unsigned packages are allowed", () => {
    for (const url of [
      "http://127.0.0.1:8000/c.json",
      "http://localhost/c.json",
      "http://[::1]:9/c.json",
    ]) {
      expect(checkSourceUrl(url, true).protocol).toBe("http:");
      expect(() => checkSourceUrl(url, false)).toThrow("SLING_ALLOW_UNSIGNED_EXTENSIONS=1");
    }
    expect(() => checkSourceUrl("http://127.0.0.1.example.com/c.json", true)).toThrow(
      "Catalogs must use HTTPS.",
    );
  });

  it("resolves package URLs against the catalog", () => {
    const base = new URL("https://example.com/ext/catalog.json");
    expect(checkSourceUrl("ntfy-1.0.0.slx", false, base).href).toBe(
      "https://example.com/ext/ntfy-1.0.0.slx",
    );
    expect(() => checkSourceUrl("http://evil.test/x.slx", false, base)).toThrow(ExtensionError);
  });
});

describe("readCapped", () => {
  const stream = (chunks: number[]) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const n of chunks) c.enqueue(new Uint8Array(n));
          c.close();
        },
      }),
    );

  it("reads a body under the cap", async () => {
    expect((await readCapped(stream([10, 20]), 30, "catalog")).length).toBe(30);
  });

  it("stops a body that goes over the cap", async () => {
    await expect(readCapped(stream([20, 20]), 30, "catalog")).rejects.toThrow(
      "The catalog is over 0 MB.",
    );
  });

  it("refuses a declared length over the cap without reading", async () => {
    const res = new Response("x".repeat(10), { headers: { "content-length": "3000000" } });
    await expect(readCapped(res, 2 * 1024 * 1024, "catalog")).rejects.toThrow(
      "The catalog is over 2 MB.",
    );
  });
});

describe("parseCatalog", () => {
  it("names what's wrong", () => {
    expect(() => parseCatalog("{")).toThrow("The catalog isn't valid JSON.");
    expect(() => parseCatalog(JSON.stringify({ format: "nope" }))).toThrow(
      /^The catalog isn't valid: format: /,
    );
  });

  it("fills defaults", () => {
    const c = parseCatalog(
      JSON.stringify({
        format: "sling.catalog/v1",
        name: "Mine",
        extensions: [
          {
            id: "mine",
            name: "Mine",
            versions: [
              {
                version: "1.0.0",
                url: "mine-1.0.0.slx",
                digest: `sha256:${"a".repeat(64)}`,
                size: 1,
                sdk: "^1.0.0",
              },
            ],
          },
        ],
      }),
    );
    expect(c.extensions[0]).toMatchObject({ publisher: null, kinds: [] });
    expect(c.extensions[0]?.versions[0]).toMatchObject({
      revoked: null,
      permissions: { approvals: false, sandboxes: false },
    });
  });
});

describe("readIncludedCatalog", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("is empty, with no error, when the directory is missing", async () => {
    const c = await readIncludedCatalog(join(tmpdir(), "sling-no-such-dir-here"));
    expect(c).toMatchObject({ id: "included", included: true, url: null, error: null });
    expect(c.document?.extensions).toEqual([]);
  });

  it("reads catalog.json, and keeps an error for a broken one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sling-included-"));
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "catalog.json"), "{ not json");
    const broken = await readIncludedCatalog(dir);
    expect(broken.error).toBe("The catalog isn't valid JSON.");
    expect(broken.document?.extensions).toEqual([]);
    await writeFile(
      join(dir, "catalog.json"),
      JSON.stringify({ format: "sling.catalog/v1", name: "Shipped", extensions: [] }),
    );
    const good = await readIncludedCatalog(dir);
    expect(good).toMatchObject({ name: "Shipped", error: null });
  });
});
