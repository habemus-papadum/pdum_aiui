import { readFileSync } from "node:fs";
import {
  externalizeDeps,
  SOLID_TEST_CONDITIONS,
  SOLID_TEST_OXC,
  solidTestDeps,
} from "@habemus-papadum/aiui-build-config";
import solid from "vite-plugin-solid";
// `vitest/config`, not `vite`: Vitest 5 no longer augments Vite's UserConfig
// with `test`, so a config that carries a test block types it from here.
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  plugins: process.env.VITEST ? [] : [solid()],
  // Vite 8 honours `jsx: preserve`; a plugin-less test run still loads .tsx.
  oxc: process.env.VITEST ? SOLID_TEST_OXC : undefined,
  test: {
    environment: "jsdom",
    server: {
      deps: solidTestDeps,
    },
  },
  resolve: {
    // Only meaningful under Vitest (the lib build's resolution is unaffected).
    conditions: SOLID_TEST_CONDITIONS,
  },
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        widgets: "src/widgets.tsx",
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
});
