import { aiui } from "@habemus-papadum/aiui-source-processor";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// Vitest prefers THIS file over vite.config.ts. Unlike the notebook demos'
// headless-only suites, the deck's tests mount components, so solid() joins
// the locator; jsdom + the shared-Solid resolution story as everywhere.
export default defineConfig({
  // Vite 8 honours the tsconfig's `jsx: preserve`, and this plugin-less run
  // still loads .tsx (a graph test reaching a component module): compile it
  // with Solid's own jsx-runtime, never rendered by these tests. (The same
  // literal as SOLID_TEST_OXC in @habemus-papadum/aiui-build-config, which a
  // scaffolded app cannot import — this file mirrors the template's.)
  oxc: { jsx: { runtime: "automatic", importSource: "@solidjs/web" } },
  plugins: [aiui({ locator: true }), solid()],
  resolve: {
    conditions: ["browser", "development", "import", "module", "default"],
  },
  test: {
    environment: "jsdom",
    passWithNoTests: true,
    server: { deps: { inline: [/solid-js/, /@solidjs\//, /@habemus-papadum\//] } },
  },
});
