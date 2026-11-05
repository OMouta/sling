import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The integration tests pull images and start containers on a real daemon.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
