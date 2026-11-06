import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The end-to-end test bundles and runs three starter projects.
    testTimeout: 60_000,
  },
});
