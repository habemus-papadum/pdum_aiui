/**
 * Test configuration for aiui-remote-bar — ONE project, because the monorepo's
 * root Vitest aggregates each package directory as a single project
 * (`projects: ["packages/*"]`), and a package config that defines its own
 * nested projects is silently flattened there: the `.tsx` tests then run
 * without the Solid plugin and fail with "Client-only API called on the server
 * side". (This file's first draft had two nested projects; the root run is why
 * it doesn't any more.)
 *
 * The package still spans two realms, reconciled inside the one project:
 *
 *  - **Solid (dom)** — the client component and host binding. Solid must be
 *    INLINED and resolved through browser/development conditions — the finding
 *    aiui-viz/vite.config.ts records in full: node conditions hand tests a
 *    SERVER build of solid whose flush()/effects belong to a different
 *    instance. Environments are chosen per file (`@vitest-environment jsdom`
 *    pragmas on the `.tsx` tests); the transform is harmless to plain `.ts`.
 *
 *  - **node (the `ws` relay)** — the browser conditions above would resolve
 *    `ws` to its browser STUB, which throws on construction. The alias pins
 *    `ws` to the real node build (resolved from node context here in the
 *    config), so the relay tests are immune to the conditions the Solid half
 *    needs.
 *
 * The `build` produces the published lib: three ES entrypoints mirroring the
 * exports map — the library (`.`), the host-neutral Node backend (`./server`),
 * and the channel sidecar (`./sidecar`, imported by the channel's
 * standard-sidecars.ts). It used to be declaration-only tsc (the package was
 * `--no-publish` and shipped as source); now that the channel depends on it, it
 * must emit runnable JS.
 */

import { readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);

// Externalize Node builtins + everything declared as a runtime/peer dependency,
// so the lib bundle never inlines a consumer-provided module (its Node half's
// `ws`, its browser half's solid).
const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

// The browser conditions + ws pin are ONLY for Vitest — node conditions hand the
// .tsx tests a SERVER build of solid, and browser conditions then need `ws`
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
  plugins: [solid()],
  resolve: testResolve,
  test: {
    server: {
      deps: {
        // Inline Solid so tests share the library's ONE dev build. The
        // never-matching external defeats vite-plugin-solid's
        // force-externalization so `inline` wins.
        external: [/^never-external-solid-js$/],
        inline: [/solid-js/, /@solidjs\//],
      },
    },
  },
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        backend: "src/backend.ts",
        sidecar: "src/sidecar.ts",
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
