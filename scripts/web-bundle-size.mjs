#!/usr/bin/env node
// Reports the web app's production bundle: what the first page load fetches (the entry
// script, the chunks it preloads, and its stylesheet) and each route loaded on demand,
// raw and compressed. With --check, fails when the compressed initial load exceeds the
// budget in apps/web/bundle-budget.json.
//
//   pnpm --filter @sling/web build && node scripts/web-bundle-size.mjs --check
//
// Compression uses gzip level 9 and brotli quality 11, so the numbers don't depend on a
// server's settings. Sling's own server sends files uncompressed; a proxy in front may
// compress them.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dist = option("--dist", join(root, "apps/web/dist"));
const routerFile = option("--router", join(root, "apps/web/src/router.tsx"));
const budgetFile = join(root, "apps/web/bundle-budget.json");

const html = readFileSync(join(dist, "index.html"), "utf8");
const refs = (pattern) => [...html.matchAll(pattern)].map((m) => m[1].replace(/^\//, ""));
const initial = [
  ...refs(/<script[^>]*type="module"[^>]*src="([^"]+)"/g),
  ...refs(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g),
  ...refs(/<link[^>]*rel="stylesheet"[^>]*href="(\/assets\/[^"]+)"/g),
];
if (initial.length === 0) throw new Error(`No entry assets found in ${dist}/index.html`);

function measure(file) {
  const bytes = readFileSync(join(dist, file));
  return {
    file: basename(file),
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }).length,
  };
}
const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

const entry = initial.map(measure);
const total = { raw: sum(entry, "raw"), gzip: sum(entry, "gzip"), brotli: sum(entry, "brotli") };

// Pages the router loads on demand, by the file name their chunk is named after.
const pages = [
  ...new Set(
    [...readFileSync(routerFile, "utf8").matchAll(/import\("\.\/pages\/([\w-]+)\.tsx"\)/g)].map(
      (m) => m[1],
    ),
  ),
];
const assets = readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".js"));
const initialNames = new Set(initial.map((f) => basename(f)));
const routes = pages.flatMap((page) => {
  const file = assets.find((f) => f.startsWith(`${page}-`) && !initialNames.has(f));
  return file ? [{ page, ...measure(`assets/${file}`) }] : [];
});
const routeNames = new Set(routes.map((r) => r.file));
const shared = assets
  .filter((f) => !initialNames.has(f) && !routeNames.has(f))
  .map((f) => measure(`assets/${f}`))
  .sort((a, b) => b.gzip - a.gzip);

const lines = [];
const table = (title, rows, label = (r) => r.file) => {
  lines.push("", `${title}`, "", "| File | Raw | gzip | brotli |", "|---|---:|---:|---:|");
  for (const r of rows)
    lines.push(`| ${label(r)} | ${kb(r.raw)} | ${kb(r.gzip)} | ${kb(r.brotli)} |`);
};
table("Initial load", entry);
lines.push(
  `| **Total** | **${kb(total.raw)}** | **${kb(total.gzip)}** | **${kb(total.brotli)}** |`,
);
table("Routes loaded on demand", routes, (r) => `${r.page} (${r.file})`);
table("Other chunks loaded on demand", shared);

let failed = false;
if (flag("--check")) {
  const budget = JSON.parse(readFileSync(budgetFile, "utf8"));
  const verdict = (name, actual, limit) => {
    const ok = actual <= limit;
    if (!ok) failed = true;
    return `${name}: ${actual} bytes of ${limit} (${ok ? "within budget" : "over budget"})`;
  };
  lines.push(
    "",
    "Initial load budget",
    "",
    `- ${verdict("gzip", total.gzip, budget.initialGzipBytes)}`,
    `- ${verdict("brotli", total.brotli, budget.initialBrotliBytes)}`,
  );
  if (failed) {
    lines.push(
      "",
      "The first page load grew past its budget. Load the new code on demand if you can; if the growth is intended, raise the numbers in apps/web/bundle-budget.json.",
    );
  }
}

const report = lines.join("\n").trimStart();
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Web bundle\n\n${report}\n`);
}
if (failed) process.exit(1);
