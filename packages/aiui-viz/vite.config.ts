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
  test: {
    // The Worker stub must exist before @duckdb/duckdb-wasm's module body
    // runs (it references `Worker` at module scope). setupFiles run before
    // any test module, so no test has to remember to import the stub first.
    setupFiles: ["./src/test-support/worker-stub.ts"],
    server: {
      deps: {
        // Solid must be INLINED under Vitest, not node-resolved — this file is
        // the canonical record of the finding (sibling package and demo
        // configs cite it). Node's export conditions
        // hand @solidjs/web a SERVER build of solid-js, so `_$effect` calls a
        // DIFFERENT instance of `createRenderEffect` than a test's
        // `import { getObserver } from "solid-js"` observes. The DOM is still
        // written once (so most tests pass), but there is no observer during
        // the compute and no reactivity on update — which is precisely what
        // cell-attribution.ts reaches for. Probe: inside `effect()` from
        // @solidjs/web, `getObserver()` is null, while inside
        // `createRenderEffect` from solid-js it is the effect node.
        //
        // vite-plugin-solid force-externalizes /solid-js/ unless the user
        // config already lists a matching external — the never-matching regex
        // below (its SOURCE matches the plugin's /solid-js/ gate) exists purely
        // to defeat that, so `inline` wins and the browser/development
        // conditions below resolve one shared dev build.
        external: [/^never-external-solid-js$/],
        inline: [/solid-js/, /@solidjs\//],
      },
    },
  },
  resolve: {
    // Only meaningful under Vitest (the lib build's resolution is unaffected:
    // externals never resolve, and app consumers bring their own config).
    conditions: ["browser", "development", "import", "module", "default"],
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
      external: (id) => external.some((mod) => id === mod || id.startsWith(`${mod}/`)),
    },
  },
});
