import { CliError } from "./util.ts";

export interface ParsedArgs {
  positional: string[];
  /** `--name value`, `--name=value`, or `true` for a switch. */
  flags: Map<string, string | true>;
}

/**
 * Splits argv into positional arguments and `--flags`. Names in `switches`
 * take no value; every other flag needs one. `--` ends the flags.
 */
export function parseArgs(argv: string[], switches: ReadonlySet<string> = new Set()): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (!arg.startsWith("--") || arg === "--") {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (switches.has(name) || name === "help") {
      if (eq !== -1) throw new CliError(`--${name} takes no value`);
      flags.set(name, true);
      continue;
    }
    if (eq !== -1) {
      flags.set(name, arg.slice(eq + 1));
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new CliError(`--${name} needs a value`);
    flags.set(name, value);
    i++;
  }
  return { positional, flags };
}

/** The flag's value, or undefined. Refuses a switch used as a value flag. */
export function flag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  if (v === true) throw new CliError(`--${name} needs a value`);
  return v;
}

/** Refuses flags the command doesn't know, so a typo isn't silently ignored. */
export function onlyFlags(args: ParsedArgs, known: string[]): void {
  for (const name of args.flags.keys()) {
    if (name !== "help" && !known.includes(name)) throw new CliError(`Unknown option --${name}`);
  }
}
