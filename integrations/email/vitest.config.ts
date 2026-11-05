import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The integration tests wait on a real IMAP server.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
