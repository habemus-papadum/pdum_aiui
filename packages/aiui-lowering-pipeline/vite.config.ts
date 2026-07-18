import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  build: {
    lib: {
      // Two entrypoints: the pipeline core (`.`) and the internal trace-stage
      // label contract (`./trace-stages`), so dist/trace-stages.js exists for
      // installed consumers (the channel + trace-ui import it by subpath).
      entry: { index: "src/index.ts", "trace-stages": "src/trace-stages.ts" },
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
