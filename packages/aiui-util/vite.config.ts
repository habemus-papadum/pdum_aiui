import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  build: {
    lib: {
      // The library (`.`) and the Node client-serving helper (`./web-surface`),
      // separate so the main entry never pulls the lazy-vite module.
      entry: { index: "src/index.ts", "web-surface": "src/web-surface.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      // "vite": web-surface imports it LAZILY (dev only, for the Vite dev
      // server) — it must never be inlined into the bundle; the dynamic
      // import resolves at runtime in a source checkout, unreached in prod.
      external: externalizeDeps(pkg, ["vite"]),
    },
  },
});
