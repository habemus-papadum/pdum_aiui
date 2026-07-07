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
  // Solid components are `.tsx`, compiled the same way aiui-viz's are — and
  // ONLY `.tsx`: the include filter keeps the Solid transform off plain `.ts`
  // files, whose `import.meta.url` it would otherwise rewrite (breaking the
  // pure-Node tests, e.g. fixtures.test.ts's `fileURLToPath(new URL(...,
  // import.meta.url))`). Scoped like this the plugin is safe under Vitest
  // too, so ONE project runs the vanilla suite and the Solid component tests
  // side by side (proposal B2.1) — no more VITEST branch.
  plugins: [solid({ include: /\.tsx$/ })],
  test: {
    // vite-plugin-solid force-defaults the test environment to jsdom when the
    // config leaves it unset; this package's convention is node default +
    // per-file `@vitest-environment jsdom` pragmas. Pin it.
    environment: "node",
  },
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
