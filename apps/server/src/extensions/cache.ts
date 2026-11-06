/**
 * Where packages are unpacked for their processes. Each server start gets a
 * fresh directory, so nothing written by an earlier run is ever read again,
 * and directories left by servers that are no longer running are removed.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackTo } from "@sling/extension-package";

/** Run directories this process created. Several servers can share a process in tests. */
const OURS = new Set<string>();

export function defaultCacheRoot(): string {
  return join(tmpdir(), "sling-extensions");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class UnpackCache {
  readonly root: string;
  #run: string | null = null;
  #seq = 0;
  #sweep: Promise<void> = Promise.resolve();

  constructor(root: string = defaultCacheRoot()) {
    this.root = root;
  }

  get runDir(): string {
    if (!this.#run) throw new Error("the unpack cache isn't open");
    return this.#run;
  }

  /** Makes this run's directory. Leftovers are removed in the background. */
  async open(): Promise<void> {
    const name = `${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const dir = join(this.root, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    OURS.add(name);
    this.#run = dir;
    this.#sweep = this.#removeLeftovers().catch(() => {});
  }

  async #removeLeftovers(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true });
    await Promise.all(
      entries.map(async (e) => {
        if (OURS.has(e.name)) return;
        const pid = Number(e.name.split("-")[0]);
        // Another live server's directory. Our own PID with a name we didn't
        // make is an earlier run that had the same PID, as in a container.
        if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) return;
        await rm(join(this.root, e.name), { recursive: true, force: true });
      }),
    );
  }

  /** Writes the files into a new directory and returns it. */
  async unpack(files: Map<string, Uint8Array>, id: string, version: string): Promise<string> {
    const dir = join(this.runDir, `${id}-${version}-${++this.#seq}`);
    await unpackTo(files, dir);
    return dir;
  }

  /** A new directory for a package being previewed. */
  stagingDir(stagingId: string): string {
    return join(this.runDir, "staging", stagingId);
  }

  /** Moves a previewed package's directory to where installed packages live. */
  async adopt(stagingDir: string, id: string, version: string): Promise<string> {
    const dir = join(this.runDir, `${id}-${version}-${++this.#seq}`);
    await rename(stagingDir, dir);
    return dir;
  }

  async remove(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    await this.#sweep;
    if (!this.#run) return;
    const dir = this.#run;
    this.#run = null;
    OURS.delete(dir.slice(this.root.length + 1));
    await rm(dir, { recursive: true, force: true });
  }
}
