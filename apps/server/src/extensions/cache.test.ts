import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { UnpackCache } from "./cache.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function root() {
  const dir = await mkdtemp(join(tmpdir(), "sling-cache-test-"));
  roots.push(dir);
  return dir;
}

describe("UnpackCache", () => {
  it("unpacks into a fresh directory per start, and removes it on close", async () => {
    const r = await root();
    const cache = new UnpackCache(r);
    await cache.open();
    const files = new Map([
      ["sling-extension.json", new TextEncoder().encode("{}")],
      ["templates/a/template.json", new TextEncoder().encode("{}")],
    ]);
    const one = await cache.unpack(files, "ntfy", "1.0.0");
    const two = await cache.unpack(files, "ntfy", "1.0.0");
    expect(one).not.toBe(two);
    expect(await readFile(join(one, "templates/a/template.json"), "utf8")).toBe("{}");
    const staged = cache.stagingDir("stg_1");
    await mkdir(staged, { recursive: true });
    const adopted = await cache.adopt(staged, "ntfy", "1.1.0");
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(adopted)).toBe(true);
    const run = cache.runDir;
    await cache.close();
    expect(existsSync(run)).toBe(false);
  });

  it("removes directories of servers that stopped, and keeps live ones", async () => {
    const r = await root();
    const dead = join(r, "2147483000-old-run");
    const live = join(r, `${process.ppid}-other-server`);
    const sameProcess = new UnpackCache(r);
    await sameProcess.open();
    await mkdir(join(dead, "ntfy"), { recursive: true });
    await mkdir(live, { recursive: true });
    const cache = new UnpackCache(r);
    await cache.open();
    await cache.close();
    const names = await readdir(r);
    expect(names).not.toContain("2147483000-old-run");
    expect(names).toContain(`${process.ppid}-other-server`);
    // Another server in this process keeps its directory.
    expect(existsSync(sameProcess.runDir)).toBe(true);
    await sameProcess.close();
  });

  it("removes a directory an earlier run left under this same process ID", async () => {
    const r = await root();
    const earlier = join(r, `${process.pid}-earlier`);
    await mkdir(earlier, { recursive: true });
    const cache = new UnpackCache(r);
    await cache.open();
    await cache.close();
    expect(existsSync(earlier)).toBe(false);
  });
});
