import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: {
    // Bake the version into the CLI so the scaffolder can pin the aiui
    // dependency range without a runtime package.json read (same convention
    // as the aiui CLI's __AIUI_VERSION__).
    __CREATE_AIUI_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    lib: {
      // Two entrypoints: the library (index) and the `create-aiui` bin (cli).
      entry: { index: "src/index.ts", cli: "src/cli.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      external: externalizeDeps(pkg),
      output: {
        // Make only the CLI chunk directly executable; the library stays clean.
        banner: (chunk: { name: string }) => (chunk.name === "cli" ? "#!/usr/bin/env node" : ""),
      },
    },
  },
});
