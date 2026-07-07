import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Externalize Node builtins + everything this package declares as a runtime/peer
// dependency, so the library bundle never inlines a consumer-provided module.
const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

export default defineConfig({
  // Solid-capable (see proposals/solid-rewrite.md): new components are Solid
  // `.tsx`, compiled the same way aiui-viz's are. The existing vanilla `.ts`
  // surface has no JSX and is unaffected.
  //
  // Skipped under Vitest (Vitest loads this config as the package's project):
  // vite-plugin-solid's transform rewrites `import.meta.url` in a way that breaks
  // the pure-Node `.ts` tests (e.g. fixtures.test.ts's `fileURLToPath(new
  // URL(..., import.meta.url))`). Stage 2 introduces a dedicated setup for the
  // Solid component tests; the vanilla suite needs no Solid transform.
  plugins: process.env.VITEST ? [] : [solid()],
  build: {
    lib: {
      // Five entries: the browser bundle, the dev-server plugin behind the
      // `./vite` subpath export (Node code — kept out of the browser bundle),
      // the framework-free intent pipeline behind `./intent-pipeline`, the
      // shared debug UI behind `./debug-ui` (lab + DevTools extension), and the
      // `./reader` bootstrap — the Solid code-reader page the plugin serves.
      // `@habemus-papadum/aiui-code` is externalized (a runtime dependency), so
      // Monaco never enters this bundle — the reader entry pulls it in only
      // transitively through that external package.
      entry: {
        index: "src/index.ts",
        vite: "src/vite.ts",
        "intent-pipeline": "src/intent-pipeline/index.ts",
        "debug-ui": "src/debug-ui/index.ts",
        reader: "src/reader/index.ts",
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
