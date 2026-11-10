import { createHash } from "node:crypto";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BuildError, RunnerBuilds, runnerIsOlder, runnerTag } from "./builds.ts";

const TARGET = "aarch64-apple-darwin";
const ARCHIVE = `sling-runner-v0.1.0-${TARGET}.tar.gz`;
const BASE = "https://github.com/acme/sling/releases/download/v0.1.0";

function sha(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A GitHub release with the given files, answering 404 for the rest. */
function release(files: Record<string, Buffer | string>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const name = url.startsWith(`${BASE}/`) ? url.slice(BASE.length + 1) : undefined;
    const body = name === undefined ? undefined : files[name];
    if (body === undefined) return new Response("Not Found", { status: 404 });
    return new Response(typeof body === "string" ? body : new Uint8Array(body));
  });
}

async function builds(fetch: typeof globalThis.fetch) {
  const dir = await mkdtemp(join(tmpdir(), "sling-builds-"));
  return { dir, builds: new RunnerBuilds({ repo: "acme/sling", tag: "v0.1.0", dir, fetch }) };
}

describe("sling-runner builds", () => {
  const bytes = Buffer.from("a stand-in archive");
  const sum = `${sha(bytes)}  ${ARCHIVE}\n`;

  it("fetches the build matching its version once, then hands it out from disk", async () => {
    const fetch = release({ [ARCHIVE]: bytes, [`${ARCHIVE}.sha256`]: sum });
    const { builds: b } = await builds(fetch);
    expect(await b.get(`sling-runner-${TARGET}.tar.gz`)).toEqual(bytes);
    expect((await b.get(`sling-runner-${TARGET}.tar.gz.sha256`)).toString()).toBe(sum);
    expect(await b.get(`sling-runner-${TARGET}.tar.gz`)).toEqual(bytes);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("downloads once for machines asking at the same time", async () => {
    const fetch = release({ [ARCHIVE]: bytes, [`${ARCHIVE}.sha256`]: sum });
    const { builds: b } = await builds(fetch);
    await Promise.all([
      b.get(`sling-runner-${TARGET}.tar.gz`),
      b.get(`sling-runner-${TARGET}.tar.gz.sha256`),
      b.get(`sling-runner-${TARGET}.tar.gz`),
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps nothing that doesn't match its checksum", async () => {
    const fetch = release({ [ARCHIVE]: bytes, [`${ARCHIVE}.sha256`]: `${"0".repeat(64)}  x\n` });
    const { builds: b, dir } = await builds(fetch);
    const err = await b.get(`sling-runner-${TARGET}.tar.gz`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuildError);
    expect(err).toMatchObject({ status: 502 });
    expect(await readdir(dir)).toEqual([]);
  });

  it("says where it looked when the release has no build", async () => {
    const { builds: b } = await builds(release({}));
    await expect(b.get("sling-runner-x86_64-pc-windows-msvc.zip")).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining(
        "https://github.com/acme/sling/releases/tag/v0.1.0 has no sling-runner build for x86_64-pc-windows-msvc",
      ),
    });
    await expect(b.get("sling-runner-x86_64-pc-windows-msvc.zip")).rejects.toMatchObject({
      message: expect.stringContaining(
        "cargo install --locked --git https://github.com/acme/sling sling-runner",
      ),
    });
  });

  it("says when GitHub can't be reached", async () => {
    const { builds: b } = await builds(
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(b.get(`sling-runner-${TARGET}.tar.gz`)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("couldn't reach GitHub"),
    });
  });

  it("only hands out the platforms the release builds", async () => {
    const fetch = release({});
    const { builds: b } = await builds(fetch);
    await expect(b.get("sling-runner-v0.1.0-../../etc.tar.gz")).rejects.toMatchObject({
      status: 404,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(RunnerBuilds.names()).toContain("sling-runner-x86_64-pc-windows-msvc.zip.sha256");
  });
});

describe("the Runner version", () => {
  it("is the workspace version in Cargo.toml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sling-cargo-"));
    const file = join(dir, "Cargo.toml");
    await writeFile(
      file,
      '[workspace]\nmembers = ["a"]\n\n[workspace.package]\nversion = "1.4.2"\nedition = "2024"\n\n[workspace.dependencies]\nversion = "9"\n',
    );
    expect(await runnerTag(file)).toBe("v1.4.2");
    expect(await runnerTag(join(dir, "missing.toml"))).toBeUndefined();
    expect(await runnerTag()).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it("flags a runner older than the server's", () => {
    expect(runnerIsOlder("0.1.0", "0.2.0")).toBe(true);
    expect(runnerIsOlder("0.9.3", "0.10.0")).toBe(true);
    expect(runnerIsOlder("0.2.0", "0.2.0")).toBe(false);
    expect(runnerIsOlder("0.3.0", "0.2.0")).toBe(false);
    expect(runnerIsOlder("dev", "0.2.0")).toBe(false);
    expect(runnerIsOlder(null, "0.2.0")).toBe(false);
    expect(runnerIsOlder("0.1.0", null)).toBe(false);
    // Against this server's own version, from Cargo.toml.
    expect(runnerIsOlder("0.0.0")).toBe(true);
  });
});
