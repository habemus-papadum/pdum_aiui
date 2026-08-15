import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// The workspace runs on source; the build half exists for `pnpm -r build` →
// publish (the viz pattern: tsc emits .d.ts first, vite bundles alongside).
// The test half needs solid() — the Deck/Lens suites render real components —
// plus the shared-Solid resolution story (jsdom + browser conditions + inlined
// Solid; see solidTestDeps in @habemus-papadum/aiui-build-config for the
// finding). styles.css is not part of the lib graph (opt-in `./styles.css`
// export, shipped from src/).
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
  build: {
    lib: {
      entry: { index: "src/index.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      external: externalizeDeps(pkg),
    },
  },
});
