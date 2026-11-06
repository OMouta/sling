#!/usr/bin/env node
/** The `sling-ext` command. */
import { runCli } from "./commands.ts";
import { CliError, consoleOutput } from "./util.ts";

// `pnpm sling-ext` in the repo runs from the repo root; work where it was typed.
const cwd =
  process.env.npm_lifecycle_event === "sling-ext" && process.env.INIT_CWD
    ? process.env.INIT_CWD
    : process.cwd();

try {
  process.exitCode = await runCli(process.argv.slice(2), { cwd, out: consoleOutput });
} catch (error) {
  if (error instanceof CliError) {
    process.stderr.write(`sling-ext: ${error.message}\n`);
  } else {
    process.stderr.write(
      `sling-ext: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  }
  process.exitCode = 1;
}
