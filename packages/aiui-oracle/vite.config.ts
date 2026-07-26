import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  // Solid transform scoped to .tsx only, and OFF under Vitest — the pencil
  // recipe (an unscoped plugin rewrites import.meta in pure-.ts cores, and
  // under Vitest it flips resolve conditions browser-ward).
  plugins: process.env.VITEST ? [] : [solid({ include: ["src/**/*.tsx"] })],
  build: {
    lib: {
      // Two entrypoints mirroring the exports map: the chromeless core (`.`)
      // and the Solid widgets (`./widgets`).
      entry: {
        index: "src/index.ts",
        widgets: "src/widgets/index.ts",
        server: "src/mint-backend.ts",
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
