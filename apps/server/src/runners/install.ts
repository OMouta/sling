import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { BuildError, DEFAULT_RELEASE_REPO, RunnerBuilds, runnerTag } from "./builds.ts";

const SCRIPTS = new URL("../../../../scripts/", import.meta.url);
const MARKER = /^# sling:defaults$/m;

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Fills in this server's URL, so the install command a person copies needs
 * only the pairing code, and the script downloads sling-runner from here.
 */
export function withDefaults(
  script: string,
  kind: "sh" | "ps1",
  defaults: { url: string },
): string {
  // The URL is plain: an origin.
  const block =
    kind === "sh"
      ? `: "\${SLING_URL:=${defaults.url}}"`
      : `if (-not $env:SLING_URL) { $env:SLING_URL = ${psQuote(defaults.url)} }`;
  if (MARKER.test(script)) return script.replace(MARKER, block);
  // Older scripts have no marker: put the defaults after the first line.
  const nl = script.indexOf("\n");
  return nl === -1
    ? `${block}\n${script}`
    : `${script.slice(0, nl + 1)}${block}\n${script.slice(nl + 1)}`;
}

const DOWNLOAD_TYPES: [string, string][] = [
  [".sha256", "text/plain; charset=utf-8"],
  [".tar.gz", "application/gzip"],
  [".zip", "application/zip"],
];

export async function installRoutes(app: FastifyInstance, ctx: AppContext) {
  const defaults = { url: ctx.config.publicUrl.origin };
  const builds = new RunnerBuilds({
    repo: ctx.config.releaseRepo ?? DEFAULT_RELEASE_REPO,
    tag: await runnerTag(),
    dir: ctx.config.runnerCacheDir,
  });
  const names = new Set(RunnerBuilds.names());

  // The install scripts download sling-runner from here, so machines only
  // need to reach Sling.
  app.get<{ Params: { file: string } }>("/runner/download/:file", async (request, reply) => {
    const { file } = request.params;
    const text = (code: number, message: string) =>
      reply.code(code).header("content-type", "text/plain; charset=utf-8").send(`${message}\n`);
    if (!names.has(file)) return text(404, `There's no sling-runner build called ${file}.`);
    let body: Buffer;
    try {
      body = await builds.get(file);
    } catch (err) {
      if (!(err instanceof BuildError)) throw err;
      request.log.warn({ file, err: err.message }, "sling-runner build unavailable");
      return text(err.status, err.message);
    }
    const type =
      DOWNLOAD_TYPES.find(([ext]) => file.endsWith(ext))?.[1] ?? "application/octet-stream";
    return reply.header("content-type", type).header("cache-control", "no-cache").send(body);
  });

  for (const [path, file, kind, type] of [
    ["/install.sh", "install.sh", "sh", "text/x-shellscript; charset=utf-8"],
    ["/install.ps1", "install.ps1", "ps1", "text/plain; charset=utf-8"],
  ] as const) {
    app.get(path, async (_request, reply) => {
      let script: string;
      try {
        script = await readFile(new URL(file, SCRIPTS), "utf8");
      } catch {
        return reply.code(404).send({ error: "install script not found" });
      }
      return reply
        .header("content-type", type)
        .header("cache-control", "no-store")
        .send(withDefaults(script, kind, defaults));
    });
  }
}
