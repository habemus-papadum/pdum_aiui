import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vitest/config";

// Vitest prefers THIS file over vite.config.ts: a leaner plugin set (locator
// only, no solid() — the tests are headless playbook layers 1/2), jsdom for
// the durable registry's window, and the shared-Solid resolution story (see
// solidTestDeps in @habemus-papadum/aiui-build-config).
export default defineConfig({
  // Vite 8 honours the tsconfig's `jsx: preserve`, and this plugin-less run
  // still loads .tsx (a graph test reaching a component module): compile it
  // with Solid's own jsx-runtime, never rendered by these tests. (The same
  // literal as SOLID_TEST_OXC in @habemus-papadum/aiui-build-config, which a
  // scaffolded app cannot import — this file mirrors the template's.)
  oxc: { jsx: { runtime: "automatic", importSource: "@solidjs/web" } },
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
