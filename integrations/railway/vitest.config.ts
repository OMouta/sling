import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The live tests create real Railway sandboxes and run Docker inside them.
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
