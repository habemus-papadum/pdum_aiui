import { readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

// Externalize Node builtins + everything this package declares as a runtime/peer
// dependency, so the library bundle never inlines a consumer-provided module —
// plus `vite` and `esbuild`, which the sidecar imports LAZILY (only at mount,
// for the /intent/ dev server and the page-ink bundle). Bundling them would
// pull all of Vite/esbuild into dist/sidecar.js; kept external, the dynamic
// import resolves at runtime (and, absent in a published install, fails at mount
// and is skipped — the Phase-4 static-dist replacement is what makes it work
// installed).
const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  "vite",
  "esbuild",
];

// The browser conditions + ws pin are ONLY for Vitest — node conditions hand the
// .tsx tests a SERVER build of solid, and the browser conditions then need `ws`
// pinned to its node entry so the relay tests don't get ws's throwing browser
// stub. The lib build wants none of it (its deps are all external), and the ws
// alias would rewrite `ws` to an absolute path and defeat its externalization —
// so gate the whole `resolve` block to test runs.
const testResolve = process.env.VITEST
  ? {
      conditions: ["browser", "development", "import", "module", "default"],
      alias: { ws: require.resolve("ws") },
    }
  : {};

export default defineConfig({
  // Compiles the panel's JSX; dev serving (`pnpm dev`) gets the plain page.
  plugins: [solid()],
  test: {
    server: {
      deps: {
        // Solid must be INLINED under Vitest, not node-resolved (the finding
        // aiui-viz/vite.config.ts records in full): node's export conditions
        // hand tests a SERVER build of solid-js whose flush()/effects belong
        // to a different instance than the one the library runs — writes
        // "commit" into a graph nobody reads. The never-matching external
        // defeats vite-plugin-solid's force-externalization so `inline` wins.
        external: [/^never-external-solid-js$/],
        inline: [/solid-js/, /@solidjs\//],
      },
    },
  },
  resolve: testResolve,
  build: {
    lib: {
      // Two entrypoints: the browser panel (`.`) and the Node channel sidecar
      // (`./sidecar`, imported by the channel's standard-sidecars.ts). The Node
      // entry's ws/CDP graph is kept out of the browser `index` bundle by being
      // its own entry.
      entry: { index: "src/index.ts", sidecar: "src/sidecar.ts" },
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
