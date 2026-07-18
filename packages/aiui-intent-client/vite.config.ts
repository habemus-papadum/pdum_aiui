import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  externalizeDeps,
  SOLID_TEST_CONDITIONS,
  solidTestDeps,
} from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

// The browser conditions + ws pin are ONLY for Vitest — node conditions hand the
// .tsx tests a SERVER build of solid, and the browser conditions then need `ws`
// pinned to its node entry so the relay tests don't get ws's throwing browser
// stub. The lib build wants none of it (its deps are all external), and the ws
// alias would rewrite `ws` to an absolute path and defeat its externalization —
// so gate the whole `resolve` block to test runs.
const testResolve = process.env.VITEST
  ? {
      conditions: SOLID_TEST_CONDITIONS,
      alias: { ws: require.resolve("ws") },
    }
  : {};

export default defineConfig({
  // Compiles the panel's JSX; dev serving (`pnpm dev`) gets the plain page.
  plugins: [solid()],
  test: {
    server: {
      // Solid must be INLINED under Vitest, not node-resolved — the full
      // finding lives with solidTestDeps (@habemus-papadum/aiui-build-config).
      deps: solidTestDeps,
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
      // vite + esbuild: the sidecar imports them LAZILY (only at mount, for
      // the /intent/ dev server and the page bundle) — external keeps all of
      // Vite/esbuild out of dist/sidecar.js.
      external: externalizeDeps(pkg, ["vite", "esbuild"]),
    },
  },
});
