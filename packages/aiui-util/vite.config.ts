import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Externalize Node builtins + everything this package declares as a runtime/peer
// dependency, plus `vite` — which `web-surface` imports LAZILY (dev only, for
// the Vite dev server), so it must never be inlined into the bundle; the dynamic
// import resolves at runtime in a source checkout and is unreached in prod.
const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  "vite",
];

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
      external: (id) => external.some((mod) => id === mod || id.startsWith(`${mod}/`)),
    },
  },
});
