import { readFileSync } from "node:fs";
import {
  externalizeDeps,
  SOLID_TEST_CONDITIONS,
  solidTestDeps,
} from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  // Solid transform scoped to .tsx only, and OFF under Vitest (the oracle's
  // recipe: an unscoped plugin rewrites import.meta in pure-.ts cores).
  plugins: process.env.VITEST ? [] : [solid({ include: ["src/**/*.tsx"] })],
  build: {
    lib: {
      // One entry per exports subpath.
      entry: {
        index: "src/index.ts",
        widgets: "src/widgets/index.ts",
        node: "src/node/index.ts",
        claude: "src/claude/index.ts",
        vite: "src/vite.ts",
      },
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
  resolve: process.env.VITEST ? { conditions: SOLID_TEST_CONDITIONS } : undefined,
  test: {
    environment: "node",
    server: { deps: solidTestDeps },
  },
});
