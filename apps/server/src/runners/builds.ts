import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The repo whose releases carry sling-runner builds, unless SLING_RELEASE_REPO names another. */
export const DEFAULT_RELEASE_REPO = "OMouta/sling";

/** The platforms the release workflow builds sling-runner for. */
export const RUNNER_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "x86_64-pc-windows-msvc",
] as const;

export function defaultBuildCacheDir(): string {
  return join(tmpdir(), "sling-runner-builds");
}

const CARGO_TOML = new URL("../../../../Cargo.toml", import.meta.url);

/**
 * The release tag of the sling-runner built from the same source as this
 * server, like `v0.1.0`, from the workspace version in Cargo.toml.
 */
export async function runnerTag(file: URL | string = CARGO_TOML): Promise<string | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  const section = text?.split(/^\[workspace\.package\]\s*$/m)[1]?.split(/^\[/m)[0];
  const version = section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  return version ? `v${version}` : undefined;
}

/** A build machines asked for that Sling can't hand out, with what to tell them. */
export class BuildError extends Error {
  readonly status: 404 | 502;

  constructor(message: string, status: 404 | 502) {
    super(message);
    this.status = status;
  }
}

interface Asset {
  target: string;
  /** The file's name in the GitHub release, like `sling-runner-v0.1.0-<target>.tar.gz`. */
  release: string;
  checksum: boolean;
}

const MAX_BYTES = 128 * 1024 * 1024;

/**
 * Hands out sling-runner builds, so a machine installing the Runner only
 * needs to reach Sling. Machines ask by platform, as
 * `sling-runner-<target>.tar.gz` (`.zip` on Windows) and its `.sha256`. The
 * first time one is asked for, it comes from the GitHub release matching this
 * server's version, is checked against its checksum, and is kept on disk.
 */
export class RunnerBuilds {
  readonly #repo: string;
  readonly #tag: string | undefined;
  readonly #dir: string;
  readonly #fetch: typeof fetch;
  readonly #pending = new Map<string, Promise<void>>();

  constructor(options: {
    repo: string;
    tag: string | undefined;
    dir?: string | undefined;
    fetch?: typeof fetch;
  }) {
    this.#repo = options.repo;
    this.#tag = options.tag;
    this.#dir = options.dir ?? defaultBuildCacheDir();
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Every name a machine may ask for. */
  static names(): string[] {
    return RUNNER_TARGETS.flatMap((target) => {
      const archive = `sling-runner-${target}.${archiveExt(target)}`;
      return [archive, `${archive}.sha256`];
    });
  }

  /** The file a machine asked for by name. Throws BuildError when Sling can't hand it out. */
  async get(name: string): Promise<Buffer> {
    const tag = this.#tag;
    if (!tag) {
      throw new BuildError("This Sling doesn't know which sling-runner version it runs with.", 404);
    }
    const asset = this.#asset(name, tag);
    if (!asset) throw new BuildError(`There's no sling-runner build called ${name}.`, 404);
    const archive = asset.checksum ? asset.release.slice(0, -".sha256".length) : asset.release;
    const dir = join(this.#dir, tag);
    // The checksum is written last, so with it on disk the archive is complete.
    const cached = await readFile(join(dir, `${archive}.sha256`)).catch(() => undefined);
    if (!cached) await this.#once(archive, () => this.#download(asset.target, archive, tag, dir));
    return readFile(join(dir, asset.release));
  }

  #asset(name: string, tag: string): Asset | undefined {
    for (const target of RUNNER_TARGETS) {
      const archive = `sling-runner-${target}.${archiveExt(target)}`;
      const release = `sling-runner-${tag}-${target}.${archiveExt(target)}`;
      if (name === archive) return { target, release, checksum: false };
      if (name === `${archive}.sha256`)
        return { target, release: `${release}.sha256`, checksum: true };
    }
    return undefined;
  }

  /** Two machines asking at once share one download. */
  async #once(key: string, run: () => Promise<void>): Promise<void> {
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = run().finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    await pending;
  }

  async #download(target: string, archive: string, tag: string, dir: string): Promise<void> {
    const base = `https://github.com/${this.#repo}/releases/download/${tag}`;
    const [bytes, sum] = await Promise.all([
      this.#fetchAsset(`${base}/${archive}`, target, tag),
      this.#fetchAsset(`${base}/${archive}.sha256`, target, tag),
    ]);
    const expected = sum.toString("utf8").trim().split(/\s+/)[0]?.toLowerCase();
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (expected !== actual) {
      throw new BuildError(
        `sling-runner ${tag} for ${target} from github.com/${this.#repo} doesn't match its checksum.`,
        502,
      );
    }
    await mkdir(dir, { recursive: true });
    await writeAtomic(join(dir, archive), bytes);
    await writeAtomic(join(dir, `${archive}.sha256`), sum);
  }

  async #fetchAsset(url: string, target: string, tag: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.#fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new BuildError(`Sling couldn't reach GitHub for sling-runner ${tag}: ${why}`, 502);
    }
    if (res.status === 404) {
      throw new BuildError(
        `https://github.com/${this.#repo}/releases/tag/${tag} has no sling-runner build for ${target}. It may not be published yet.`,
        404,
      );
    }
    if (!res.ok) throw new BuildError(`GitHub answered ${res.status} for ${url}.`, 502);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) {
      throw new BuildError(`${url} is larger than a sling-runner build should be.`, 502);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      throw new BuildError(`${url} is larger than a sling-runner build should be.`, 502);
    }
    return bytes;
  }
}

function archiveExt(target: string): "zip" | "tar.gz" {
  return target.includes("windows") ? "zip" : "tar.gz";
}

async function writeAtomic(path: string, bytes: Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.part`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}
