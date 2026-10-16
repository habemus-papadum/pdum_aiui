import { readFileSync } from "node:fs";
import { externalizeDeps, SOLID_TEST_OXC } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  // Vite 8 honours `jsx: preserve`; a plugin-less test run still loads .tsx.
  oxc: process.env.VITEST ? SOLID_TEST_OXC : undefined,
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        core: "src/core.ts",
        input: "src/input/index.ts",
        canvas: "src/canvas.ts",
        solid: "src/solid.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      external: externalizeDeps(pkg),
    },
  },
});
