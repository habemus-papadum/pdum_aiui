import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vitest/config";

// Vitest prefers THIS file over vite.config.ts: a leaner plugin set (locator
// only, no solid() — the tests are headless playbook layers 1/2), jsdom for
// the durable registry's window, and the shared-Solid resolution story (see
// solidTestDeps in @habemus-papadum/aiui-build-config).
export default defineConfig({
  plugins: [aiui({ locator: true })],
  resolve: {
    conditions: ["browser", "development", "import", "module", "default"],
  },
  test: {
    environment: "jsdom",
    passWithNoTests: true,
    server: { deps: { inline: [/solid-js/, /@solidjs\//, /@habemus-papadum\//] } },
  },
});
