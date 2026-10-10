import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: { __AIBR_VERSION__: JSON.stringify(pkg.version) },
  build: {
    lib: {
      entry: { index: "src/index.ts", cli: "src/cli.ts" },
      formats: ["es"],
      fileName: (_format, entry) => `${entry}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      external: externalizeDeps(pkg),
      output: {
        banner: (chunk: { name: string }) => (chunk.name === "cli" ? "#!/usr/bin/env node" : ""),
      },
    },
  },
});
