import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The integration tests wait on a real CalDAV server.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
