/** Each `sling-ext` command: parses its arguments, does the work, and prints. */
import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { SDK_VERSION } from "@sling/connector-sdk";
import { describePermissions, formatFingerprint } from "@sling/connector-sdk/host";
import { flag, onlyFlags, type ParsedArgs, parseArgs } from "./args.ts";
import { buildProject } from "./build.ts";
import { writeCatalog } from "./catalog.ts";
import { checkFiles, printReport } from "./check.ts";
import { initProject, STARTER_KINDS } from "./init.ts";
import { readKey, writeNewKey } from "./keys.ts";
import { fingerprintLine, openPackage, packProject, signBytes, verifyPackage } from "./pack.ts";
import { collectFiles, loadProject } from "./project.ts";
import type { StarterKind } from "./starters.ts";
import { CliError, formatBytes, type Output, plural, shortPath } from "./util.ts";

export interface CommandContext {
  cwd: string;
  out: Output;
}

interface Command {
  usage: string;
  summary: string;
  switches?: string[];
  flags?: string[];
  run(args: ParsedArgs, ctx: CommandContext): Promise<number>;
}

const at = (ctx: CommandContext, path: string) =>
  isAbsolute(path) ? path : resolve(ctx.cwd, path);

function oneDir(args: ParsedArgs, ctx: CommandContext): string {
  if (args.positional.length > 1) throw new CliError("Give at most one folder.");
  return at(ctx, args.positional[0] ?? ".");
}

const init: Command = {
  usage:
    "init <dir> [--kind connector|provider|workflows] [--id id] [--name name] [--publisher name]",
  summary: "Start a new extension: manifest, src/index.ts, a test, and a README",
  flags: ["kind", "id", "name", "publisher"],
  async run(args, ctx) {
    const [target] = args.positional;
    if (!target || args.positional.length > 1) throw new CliError(`Usage: sling-ext ${this.usage}`);
    const kind = (flag(args, "kind") ?? "connector") as StarterKind;
    if (!STARTER_KINDS.includes(kind)) {
      throw new CliError(`--kind must be one of ${STARTER_KINDS.join(", ")}.`);
    }
    const result = await initProject(at(ctx, target), {
      kind,
      id: flag(args, "id"),
      name: flag(args, "name"),
      publisher: flag(args, "publisher"),
    });
    const rel = shortPath(result.dir, ctx.cwd);
    ctx.out.out(`Created ${result.kind} ${result.id} in ${rel}`);
    for (const f of result.files) ctx.out.out(`  ${f}`);
    ctx.out.out();
    ctx.out.out("Next:");
    ctx.out.out(`  cd ${rel}`);
    if (kind !== "workflows") ctx.out.out("  sling-ext build");
    ctx.out.out("  sling-ext check");
    ctx.out.out("  node --test");
    return 0;
  },
};

const build: Command = {
  usage: "build [dir] [--entry src/index.ts] [--no-minify]",
  summary: "Bundle src/index.ts and its dependencies into the manifest's main file",
  switches: ["no-minify"],
  flags: ["entry"],
  async run(args, ctx) {
    const project = await loadProject(oneDir(args, ctx));
    const result = await buildProject(project, {
      entry: flag(args, "entry"),
      minify: !args.flags.has("no-minify"),
    });
    if (!result) {
      ctx.out.out(
        `Nothing to build: ${project.manifest.id} has no main, so it's a workflow package.`,
      );
      return 0;
    }
    ctx.out.out(
      `Built ${shortPath(result.outfile, ctx.cwd)}: ${formatBytes(result.bytes)} in ${result.ms} ms`,
    );
    for (const name of result.refused) {
      ctx.out.err(
        `Warning: the bundle imports ${name}, which an extension can't use. Sling runs extensions with no files, processes, sockets, or DNS of their own. Use the global fetch and WebSocket for the network.`,
      );
    }
    return 0;
  },
};

const check: Command = {
  usage: "check [dir | file.slx]",
  summary: "Run the bundle under Sling's restrictions and check what it adds",
  async run(args, ctx) {
    const target = oneDir(args, ctx);
    let files: Map<string, Uint8Array>;
    if (target.endsWith(".slx")) {
      files = (await openPackage(target)).pkg.files;
    } else {
      const collected = await collectFiles(await loadProject(target));
      if (collected.missing.length) throw new CliError(collected.missing.join("\n"));
      files = collected.files;
    }
    const report = await checkFiles(files);
    printReport(report, ctx.out);
    ctx.out.out();
    if (report.problems.length) {
      ctx.out.out(`${plural(report.problems.length, "problem")}. Sling would refuse this package.`);
      return 1;
    }
    ctx.out.out("No problems.");
    return 0;
  },
};

const keygen: Command = {
  usage: "keygen [--out key.json] [--publisher name]",
  summary: "Create an Ed25519 signing key and print its fingerprint",
  flags: ["out", "publisher"],
  async run(args, ctx) {
    if (args.positional.length) throw new CliError(`Usage: sling-ext ${this.usage}`);
    let publisher = flag(args, "publisher");
    if (!publisher) {
      try {
        publisher = (await loadProject(ctx.cwd)).manifest.publisher;
      } catch {
        throw new CliError(
          "Pass --publisher <name>: the name Sling shows next to your fingerprint.",
        );
      }
    }
    const path = at(ctx, flag(args, "out") ?? "key.json");
    const key = await writeNewKey(path, publisher);
    ctx.out.out(
      `Wrote ${shortPath(path, ctx.cwd)}. Keep it secret: it signs packages as ${publisher}.`,
    );
    ctx.out.out(`Fingerprint: ${fingerprintLine(key.keyId)}`);
    ctx.out.out(`Public key: ${key.publicKey}`);
    ctx.out.out();
    ctx.out.out(
      "Publish the fingerprint where your users can check it, such as your README. Sling shows it before anyone trusts your key.",
    );
    return 0;
  },
};

async function loadKeyFor(path: string, ctx: CommandContext) {
  const { key, warning } = await readKey(at(ctx, path));
  if (warning) ctx.out.err(`Warning: ${warning}`);
  return key;
}

const pack: Command = {
  usage: "pack [dir] [--sign key.json] [--out dist]",
  summary: "Check the project and write a deterministic .slx, signed if a key is given",
  flags: ["sign", "out"],
  async run(args, ctx) {
    const project = await loadProject(oneDir(args, ctx));
    const keyPath = flag(args, "sign");
    const key = keyPath ? await loadKeyFor(keyPath, ctx) : null;
    const outFlag = flag(args, "out");
    const result = await packProject(project, {
      key,
      outDir: outFlag ? at(ctx, outFlag) : undefined,
    });
    for (const w of result.report.warnings) ctx.out.err(`Warning: ${w}`);
    ctx.out.out(
      `Packed ${shortPath(result.path, ctx.cwd)}: ${formatBytes(result.bytes.length)}, ${plural(result.report.files, "file")}`,
    );
    ctx.out.out(`Digest: ${result.digest}`);
    if (result.signedBy) {
      ctx.out.out(
        `Signed by ${result.signedBy.publisher}: ${fingerprintLine(result.signedBy.keyId)}`,
      );
    } else {
      ctx.out.out(
        `Unsigned. Sign it with: sling-ext sign ${shortPath(result.path, ctx.cwd)} --key key.json`,
      );
    }
    return 0;
  },
};

const sign: Command = {
  usage: "sign <file.slx> --key key.json [--out file.slx]",
  summary: "Add or replace the package's SIGNATURE.json",
  flags: ["key", "out"],
  async run(args, ctx) {
    const [file] = args.positional;
    const keyPath = flag(args, "key");
    if (!file || !keyPath || args.positional.length > 1) {
      throw new CliError(`Usage: sling-ext ${this.usage}`);
    }
    const key = await loadKeyFor(keyPath, ctx);
    const path = at(ctx, file);
    const { pkg } = await openPackage(path);
    const result = signBytes(pkg, key);
    const outFlag = flag(args, "out");
    const out = outFlag ? at(ctx, outFlag) : path;
    await writeFile(out, result.bytes);
    const m = pkg.manifest;
    ctx.out.out(`Signed ${m.id} ${m.version} as ${key.publisher}: ${fingerprintLine(key.keyId)}`);
    if (result.replaced && result.replaced !== key.keyId) {
      ctx.out.out(`Replaced a signature by ${formatFingerprint(result.replaced)}.`);
    }
    ctx.out.out(`Wrote ${shortPath(out, ctx.cwd)}: ${formatBytes(result.bytes.length)}`);
    return 0;
  },
};

const verify: Command = {
  usage: "verify <file.slx> [--fingerprint keyId]",
  summary: "Check the package's digest, signature, fingerprint, and manifest",
  flags: ["fingerprint"],
  async run(args, ctx) {
    const [file] = args.positional;
    if (!file || args.positional.length > 1) throw new CliError(`Usage: sling-ext ${this.usage}`);
    const { bytes, pkg } = await openPackage(at(ctx, file));
    const m = pkg.manifest;
    let unpacked = 0;
    for (const data of pkg.files.values()) unpacked += data.length;
    ctx.out.out(`${m.name} (${m.id}) ${m.version}, published by ${m.publisher}`);
    ctx.out.out(
      `Files: ${pkg.files.size}, ${formatBytes(unpacked)} unpacked, ${formatBytes(bytes.length)} packed`,
    );
    ctx.out.out(`Digest: ${pkg.digest}`);
    ctx.out.out(`SDK: ${m.sdk} (this sling-ext has ${SDK_VERSION})`);
    const lines = describePermissions(m.permissions);
    ctx.out.out(`Permissions: ${lines.length ? "" : "none beyond the fixed minimum"}`);
    for (const l of lines) ctx.out.out(`  ${l.risk === "high" ? "[high] " : ""}${l.text}`);
    const outcome = verifyPackage(pkg, flag(args, "fingerprint"));
    if (!outcome.ok) {
      ctx.out.out(`Signature: ${outcome.reason}`);
      return 1;
    }
    ctx.out.out(`Signature: good, by ${outcome.publisher}`);
    ctx.out.out(`Fingerprint: ${fingerprintLine(outcome.keyId)}`);
    return 0;
  },
};

const catalog: Command = {
  usage:
    'catalog <dir> [--name "Acme extensions"] [--out catalog.json] [--revoke id@version --reason text]',
  summary: "Write catalog.json for the .slx files in a folder, with relative URLs",
  flags: ["name", "out", "revoke", "reason"],
  async run(args, ctx) {
    const [dirArg] = args.positional;
    if (!dirArg || args.positional.length > 1) throw new CliError(`Usage: sling-ext ${this.usage}`);
    const dir = at(ctx, dirArg);
    const revokeArg = flag(args, "revoke");
    const reason = flag(args, "reason");
    let revoke: { id: string; version: string; reason: string } | undefined;
    if (revokeArg) {
      const m = /^([a-z][a-z0-9-]+)@(\S+)$/.exec(revokeArg);
      if (!m || !reason) throw new CliError("Revoke with --revoke <id>@<version> --reason <text>.");
      revoke = { id: m[1] as string, version: m[2] as string, reason };
    } else if (reason) {
      throw new CliError("--reason goes with --revoke.");
    }
    const outFlag = flag(args, "out");
    const result = await writeCatalog(dir, {
      name: flag(args, "name"),
      out: outFlag ? at(ctx, outFlag) : undefined,
      revoke,
    });
    const c = result.catalog;
    const versions = c.extensions.reduce((n, e) => n + e.versions.length, 0);
    ctx.out.out(
      `Wrote ${shortPath(result.path, ctx.cwd)}: "${c.name}", ${plural(c.extensions.length, "extension")}, ${plural(versions, "version")}, ${plural(c.publishers.length, "publisher")}`,
    );
    for (const line of result.lines) ctx.out.out(`  ${line}`);
    ctx.out.out();
    ctx.out.out(
      `Serve ${basename(dir)}/ from any static HTTPS host, then add <url>/${basename(result.path)} in Sling under Extensions → Sources.`,
    );
    return 0;
  },
};

export const COMMANDS: Record<string, Command> = {
  init,
  build,
  check,
  keygen,
  pack,
  sign,
  verify,
  catalog,
};

export function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  const lines = [
    "sling-ext: build, check, sign, and publish Sling extensions.",
    "",
    "Usage: sling-ext <command> [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
    "",
    "Run sling-ext <command> --help for its options. Docs: docs/extensions/cli.md",
  ];
  return lines.join("\n");
}

/** Runs one command line. Returns the exit code. */
export async function runCli(argv: string[], ctx: CommandContext): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    ctx.out.out(helpText());
    return name ? 0 : 1;
  }
  if (name === "--version" || name === "version") {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    ctx.out.out(`sling-ext ${pkg.version}, SDK ${SDK_VERSION}`);
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) throw new CliError(`Unknown command ${name}. Run sling-ext --help for the list.`);
  const args = parseArgs(rest, new Set(command.switches ?? []));
  if (args.flags.has("help")) {
    ctx.out.out(`Usage: sling-ext ${command.usage}`);
    ctx.out.out();
    ctx.out.out(command.summary);
    return 0;
  }
  onlyFlags(args, [...(command.flags ?? []), ...(command.switches ?? [])]);
  return command.run(args, ctx);
}
