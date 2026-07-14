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
 * There is no `build` here on purpose: the package is `--no-publish` and ships
 * as source to its in-workspace consumers (source-first convention), so `build`
 * is declaration-only tsc (see package.json) and never bundles.
 */

import { createRequire } from "node:module";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [solid()],
  resolve: {
    conditions: ["browser", "development", "import", "module", "default"],
    alias: {
      // Pin ws to its NODE entry: the browser conditions above exist for
      // solid-js, and must not hand the relay tests ws's browser stub.
      ws: require.resolve("ws"),
    },
  },
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
});
