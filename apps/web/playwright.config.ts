import { defineConfig, devices } from "@playwright/test";

/**
 * A few journeys through the real app in a real browser, against a running
 * Sling: `SLING_BROWSER_URL`, or a server on :8080 serving the built app.
 * `PLAYWRIGHT_CHROMIUM` points at a Chromium already on the machine.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM || undefined;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.SLING_BROWSER_URL ?? "http://localhost:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } },
    },
  ],
});
