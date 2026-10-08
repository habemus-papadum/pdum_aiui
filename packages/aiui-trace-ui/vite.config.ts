import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
// `vitest/config`, not `vite`: Vitest 5 no longer augments Vite's UserConfig
// with `test`, so a config that carries a test block types it from here.
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  test: {
    // Node default + per-file `@vitest-environment jsdom` pragmas — the pure
    // stage classification runs in plain Node; the pane tests opt into jsdom.
    environment: "node",
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
