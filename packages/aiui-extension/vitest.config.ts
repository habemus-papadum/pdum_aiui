// Vitest deliberately does NOT load vite.config.ts: that config instantiates
// the CRXJS plugin (manifest pipeline, dev-server hooks) which has no business
// running under a test runner. Tests here are node-environment unit tests.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
