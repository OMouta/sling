import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { generateApiReport, REPORT_PATH } from "../scripts/api-report.ts";

describe("API report", () => {
  it("matches the SDK's exports", async () => {
    const [current, fresh] = await Promise.all([
      readFile(REPORT_PATH, "utf8").catch(() => ""),
      generateApiReport(),
    ]);
    expect(
      current,
      "The SDK's public API changed. If that's intended, run `pnpm --filter @sling/connector-sdk api-report`, commit api-report.d.ts with the change, and bump the SDK's version to match.",
    ).toBe(fresh);
  }, 30_000);
});
