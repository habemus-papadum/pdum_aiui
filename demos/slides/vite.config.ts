import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// Library package, so no build block (the workspace runs on source). The test
// half needs solid() — the Deck/Lens suites render real components — plus the
// shared-Solid resolution story (jsdom + browser conditions + inlined Solid;
// see solidTestDeps in @habemus-papadum/aiui-build-config for the finding).
export default defineConfig({
  plugins: [solid()],
  resolve: {
    conditions: ["browser", "development", "import", "module", "default"],
  },
  test: {
    environment: "jsdom",
    passWithNoTests: true,
    server: { deps: { inline: [/solid-js/, /@solidjs\//, /@habemus-papadum\//] } },
  },
});
