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
  // vite-plugin-solid compiles the JSX (cell-view, plot) to @solidjs/web
  // template calls at build time; consumers running source get the same
  // transform from their own solid plugin (the editable-deps convention).
  plugins: [solid()],
  test: {
    // The Worker stub must exist before @duckdb/duckdb-wasm's module body
    // runs (it references `Worker` at module scope). setupFiles run before
    // any test module, so no test has to remember to import the stub first.
    setupFiles: ["./src/test-support/worker-stub.ts"],
    server: {
      // Solid must be INLINED under Vitest, not node-resolved. The full
      // finding — first recorded here — now lives with solidTestDeps
      // (@habemus-papadum/aiui-build-config).
      deps: solidTestDeps,
    },
  },
  resolve: {
    // Only meaningful under Vitest (the lib build's resolution is unaffected:
    // externals never resolve, and app consumers bring their own config).
    conditions: SOLID_TEST_CONDITIONS,
  },
  build: {
    lib: {
      // One entry per export subpath: the core surface; the Observable Plot
      // bridge (`./plot`); the Mosaic/vgplot bridge (`./mosaic`) and the
      // DuckDB-WASM instantiation glue (`./duckdb`) — so @observablehq/plot,
      // @uwdata/mosaic-plot, @duckdb/duckdb-wasm, and katex stay optional
      // peers that core consumers never import; the page-chrome porcelain
      // (`./site`); and the modal interaction kit (`./modal`: framework-free,
      // no Solid import, so node-side consumers can reach it —
      // aiui-lowering-pipeline re-exports `wordDiff` from it).
      entry: {
        index: "src/index.ts",
        plot: "src/plot.tsx",
        mosaic: "src/mosaic.tsx",
        duckdb: "src/duckdb.ts",
        site: "src/site/index.ts",
        modal: "src/modal/index.ts",
        testing: "src/testing.ts",
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
