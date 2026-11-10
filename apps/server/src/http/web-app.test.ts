import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { serveWebApp } from "./app.ts";

const dist = mkdtempSync(join(tmpdir(), "sling-web-"));
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "index.html"), "<!doctype html><title>Sling</title>");
writeFileSync(join(dist, "assets", "index-new.js"), "export {};");
afterAll(() => rmSync(dist, { recursive: true, force: true }));

async function app() {
  const a = Fastify();
  serveWebApp(a, { webDist: dist });
  await a.ready();
  return a;
}

describe("the built web app", () => {
  it("serves its files, and the app shell for any page", async () => {
    const a = await app();
    const js = await a.inject("/assets/index-new.js");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    const page = await a.inject("/chats?q=x");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
  });

  it("answers 404 for a built file it doesn't have, such as an older build's chunk", async () => {
    const a = await app();
    const old = await a.inject("/assets/Settings-old.js");
    expect(old.statusCode).toBe(404);
    expect(old.headers["content-type"]).not.toContain("text/html");
  });
});
