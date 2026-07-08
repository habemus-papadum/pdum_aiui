import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Externalize Node builtins + everything this package declares as a runtime/peer
// dependency, so the library bundle never inlines a consumer-provided module
// (solid-js, @solidjs/web, @observablehq/plot all stay external).
const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

export default defineConfig({
  // vite-plugin-solid compiles the JSX (cell-view, plot) to @solidjs/web
  // template calls at build time; consumers running source get the same
  // transform from their own solid plugin (the editable-deps convention).
  plugins: [solid()],
  build: {
    lib: {
      // One entry per export subpath: the core surface; the Observable Plot
      // bridge (`./plot`); the Mosaic/vgplot bridge (`./mosaic`) and the
      // DuckDB-WASM instantiation glue (`./duckdb`) — so @observablehq/plot,
      // @uwdata/mosaic-plot, @duckdb/duckdb-wasm, and katex stay optional
      // peers that core consumers never import; the page-chrome porcelain
      // (`./site`); and the modal interaction kit (`./modal`: framework-free,
      // no Solid import, so node-side consumers can reach it through the
      // overlay's intent pipeline).
      entry: {
        index: "src/index.ts",
        plot: "src/plot.tsx",
        mosaic: "src/mosaic.tsx",
        duckdb: "src/duckdb.ts",
        site: "src/site/index.ts",
        modal: "src/modal/index.ts",
      },
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
