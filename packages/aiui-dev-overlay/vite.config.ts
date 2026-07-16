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
  plugins: [solid()],
  test: {
    // vite-plugin-solid force-defaults the test environment to jsdom when the
    // config leaves it unset; this package's convention is node default +
    // per-file `@vitest-environment jsdom` pragmas. Pin it.
    environment: "node",
    server: {
      deps: {
        // Solid must be INLINED under Vitest, not node-resolved: node's
        // export conditions pick @solidjs/web's SERVER build, whose insert()
        // is inert — components render once and never update (the probe for
        // this: an effect inside the component fires on set+flush, the DOM
        // stays stale). vite-plugin-solid force-externalizes /solid-js/
        // unless the user config already lists a matching external — the
        // never-matching regex below (its SOURCE matches the plugin's
        // /solid-js/ gate) exists purely to defeat that, so `inline` wins
        // and the browser/development conditions above resolve dev builds.
        external: [/^never-external-solid-js$/],
        inline: [/solid-js/, /@solidjs\//],
      },
    },
  },
  resolve: {
    // Only meaningful under Vitest (the lib build's resolution is unaffected
    // in practice: externals never resolve, and app consumers bring their own
    // config): pick Solid's browser dev builds for the inlined deps above.
    conditions: ["browser", "development", "import", "module", "default"],
  },
  build: {
    lib: {
      // One entry per subpath export: the browser bundle, the dev-server
      // plugin behind `./vite` (Node code — kept out of the browser bundle),
      // the shared debug UI behind `./debug-ui` (lab + DevTools extension), and
      // the two lean host seams the browser extension consumes without the
      // barrel's Solid/multimodal graph: `./protocol` (intent socket) and
      // `./selection` (the page selection watcher).
      // (The framework-free lowering pipeline moved to its own package,
      // `@habemus-papadum/aiui-lowering-pipeline` — see its `composeIntent`.)
      entry: {
        index: "src/index.ts",
        vite: "src/vite.ts",
        "debug-ui": "src/debug-ui/index.ts",
        protocol: "src/protocol.ts",
        selection: "src/selection.ts",
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
