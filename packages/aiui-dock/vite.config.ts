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
  // and live's recipe); the tests here are pure-.ts.
  plugins: process.env.VITEST ? [] : [solid({ include: ["src/**/*.tsx"] })],
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
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
