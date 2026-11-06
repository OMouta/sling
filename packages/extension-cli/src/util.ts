import { relative } from "node:path";

/** A mistake the user can fix. Printed without a stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** Where commands print. Tests pass one that collects lines. */
export interface Output {
  out(line?: string): void;
  err(line?: string): void;
}

export const consoleOutput: Output = {
  out: (line = "") => process.stdout.write(`${line}\n`),
  err: (line = "") => process.stderr.write(`${line}\n`),
};

/** `48213` as `47.1 kB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A path relative to the working directory when that's shorter. */
export function shortPath(path: string, cwd: string = process.cwd()): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && rel.length < path.length ? rel : path;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
