/**
 * Runs an extension's bundle the way Sling does, and asks it what it adds.
 *
 * The package is unpacked into a fresh temporary directory and imported in a
 * Node process with the permission model on: it may read that directory and
 * the small script that loads it, and nothing else. It can't write files,
 * open sockets, resolve names, start processes or workers, or build code from
 * strings, and its environment is empty.
 */
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionDescription } from "@sling/connector-sdk";
import { unpackTo } from "@sling/extension-package";

const CHILD = fileURLToPath(new URL("./describe-child.mjs", import.meta.url));
const DEFAULT_TIMEOUT_MS = 15_000;

export type DescribeResult =
  | { ok: true; description: ExtensionDescription; output: string[]; ms: number }
  | { ok: false; error: string; output: string[] };

/** The flags Sling starts an extension process with, for a package unpacked at `dir`. */
export function restrictedFlags(dir: string, memoryMb: number, script: string): string[] {
  return [
    "--permission",
    `--allow-fs-read=${dir}`,
    `--allow-fs-read=${script}`,
    `--max-old-space-size=${memoryMb}`,
    "--disallow-code-generation-from-strings",
  ];
}

function lines(chunks: Buffer[]): string[] {
  const text = Buffer.concat(chunks).toString("utf8").trimEnd();
  return text ? text.split("\n") : [];
}

export async function describeFiles(
  files: Map<string, Uint8Array>,
  main: string,
  options: { memoryMb?: number; timeoutMs?: number } = {},
): Promise<DescribeResult> {
  // The real path, since the permission model compares resolved paths.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sling-ext-check-")));
  try {
    await unpackTo(files, dir);
    return await run(dir, join(dir, main), options);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(
  dir: string,
  bundle: string,
  options: { memoryMb?: number; timeoutMs?: number },
): Promise<DescribeResult> {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [...restrictedFlags(dir, options.memoryMb ?? 256, CHILD), CHILD, bundle],
    { env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced" },
  );
  const out: Buffer[] = [];
  child.stdout?.on("data", (d: Buffer) => out.push(d));
  child.stderr?.on("data", (d: Buffer) => out.push(d));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DescribeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        error: `The bundle didn't describe itself within ${timeoutMs / 1000} seconds. Check for work at import time that never finishes.`,
        output: lines(out),
      });
    }, timeoutMs);
    let reply: { ok: boolean; description?: ExtensionDescription; error?: string } | null = null;
    let ms = 0;
    child.on("message", (message: unknown) => {
      reply ??= message as typeof reply;
      ms = Math.round(performance.now() - started);
    });
    child.on("error", (error) => finish({ ok: false, error: error.message, output: lines(out) }));
    // "close" comes after the process exits and its output and IPC channel are drained.
    child.on("close", (code, signal) => {
      const output = lines(out);
      if (reply?.ok) {
        finish({ ok: true, description: reply.description as ExtensionDescription, output, ms });
      } else if (reply) {
        finish({ ok: false, error: reply.error ?? "The bundle failed.", output });
      } else {
        finish({
          ok: false,
          error: `The process exited (${signal ?? `code ${code}`}) before the bundle described itself.`,
          output,
        });
      }
    });
  });
}
