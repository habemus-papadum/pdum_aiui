import { readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

// Externalize Node builtins + everything this package declares as a runtime/peer
// dependency, so the library bundle never inlines a consumer-provided module.
const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

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
  resolve: {
    // Only meaningful under Vitest (the lib build's externals never resolve).
    conditions: ["browser", "development", "import", "module", "default"],
    alias: {
      // …but this package has a NODE half (the sidecar + its CDP bridge), and
      // `browser` hands it ws's browser stub — a module whose whole job is to
      // throw. Pin ws to the real node entry; nothing in the page graph imports
      // it, so the app build is unaffected.
      ws: require.resolve("ws"),
    },
  },
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      external: (id) => external.some((mod) => id === mod || id.startsWith(`${mod}/`)),
    },
  },
});
