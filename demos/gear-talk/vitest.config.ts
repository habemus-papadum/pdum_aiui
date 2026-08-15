import { aiui } from "@habemus-papadum/aiui-source-processor";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// Vitest prefers THIS file over vite.config.ts. Unlike the notebook demos'
// headless-only suites, the deck's tests mount components, so solid() joins
// the locator; jsdom + the shared-Solid resolution story as everywhere.
export default defineConfig({
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
