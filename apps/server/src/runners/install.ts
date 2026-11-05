import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";

const SCRIPTS = new URL("../../../../scripts/", import.meta.url);
const MARKER = /^# sling:defaults$/m;

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Fills in this server's URL, and the release repo when set, so the install
 * command a person copies needs only the pairing code.
 */
export function withDefaults(
  script: string,
  kind: "sh" | "ps1",
  defaults: { url: string; repo: string | undefined },
): string {
  const lines =
    kind === "sh"
      ? [
          // Both values are plain: a URL origin, and an owner/name checked at startup.
          `: "\${SLING_URL:=${defaults.url}}"`,
          ...(defaults.repo ? [`: "\${SLING_REPO:=${defaults.repo}}"`] : []),
        ]
      : [
          `if (-not $env:SLING_URL) { $env:SLING_URL = ${psQuote(defaults.url)} }`,
          ...(defaults.repo
            ? [`if (-not $env:SLING_REPO) { $env:SLING_REPO = ${psQuote(defaults.repo)} }`]
            : []),
        ];
  const block = lines.join("\n");
  if (MARKER.test(script)) return script.replace(MARKER, block);
  // Older scripts have no marker: put the defaults after the first line.
  const nl = script.indexOf("\n");
  return nl === -1
    ? `${block}\n${script}`
    : `${script.slice(0, nl + 1)}${block}\n${script.slice(nl + 1)}`;
}

export async function installRoutes(app: FastifyInstance, ctx: AppContext) {
  const defaults = { url: ctx.config.publicUrl.origin, repo: ctx.config.releaseRepo };
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
